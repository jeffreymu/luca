import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import pathModule from "node:path";
import { SPECIALISTS, LANES, listSpecialists } from "./specialists.js";
import { analyzeRepository } from "./repository.js";
import { gitStatus, runGit } from "./git.js";
import { WorktreeManager } from "./worktree.js";
import { createPullRequest, listIssues, listPullRequests, parseGitHubSlug, postPullRequestComment } from "./github.js";
import { inspectHarness } from "./harness.js";
import { DockerSandboxManager } from "./sandbox.js";
import { ToolExecutor } from "./agent-runtime.js";

const dockerSandboxes = new DockerSandboxManager();
const webhookWindows=new Map();
function acceptWebhookRate(workspaceId,limit=120){const minute=Math.floor(Date.now()/60_000),current=webhookWindows.get(workspaceId);if(!current||current.minute!==minute){webhookWindows.set(workspaceId,{minute,count:1});return true;}current.count++;return current.count<=limit;}

export async function handlePlatformApi(ctx) {
  const {req,res,url,store,worker,json,badRequest,notFound,readBody,broadcast}=ctx;
  const path=url.pathname, method=req.method;
  const approvalRequired=(workspace,operation)=>{try{return JSON.parse(workspace?.sandbox_policy||"{}").requireApprovalFor?.includes(operation);}catch{return false;}};
  const authorizeOperation=(workspace,operation,resourceId,approvalId)=>!approvalRequired(workspace,operation)||store.consumeOperationApproval(approvalId,operation,resourceId);

  if(path==="/api/operation-approvals"&&method==="GET"){json(res,200,store.listOperationApprovals(url.searchParams.get("workspaceId")));return true;}
  if(path==="/api/operation-approvals"&&method==="POST"){const b=await readBody(req);json(res,201,store.createOperationApproval(b));return true;}
  const operationApproval=path.match(/^\/api\/operation-approvals\/([^/]+)$/);
  if(operationApproval&&method==="POST"){const b=await readBody(req);if(!["APPROVED","REJECTED"].includes(b.status)){badRequest(res,"status must be APPROVED or REJECTED");return true;}json(res,200,store.resolveOperationApproval(operationApproval[1],b.status,b.response));return true;}

  if(path==="/api/admin/schema"&&method==="GET"){json(res,200,store.schemaInfo());return true;}
  if(path==="/api/admin/backup"&&method==="POST"){const b=await readBody(req),dir=pathModule.resolve(process.cwd(),".lucapi-backups");mkdirSync(dir,{recursive:true});const filename=pathModule.basename(b.filename||`lucapi-${Date.now()}.db`),target=pathModule.join(dir,filename.endsWith(".db")?filename:`${filename}.db`);try{json(res,201,store.backup(target));}catch(e){badRequest(res,e.message);}return true;}

  const sessionCancel=path.match(/^\/api\/sessions\/([^/]+)\/cancel$/);
  if(sessionCancel&&method==="POST") { const s=store.requestSessionCancel(sessionCancel[1]);s?json(res,200,s):notFound(res);return true; }
  const sessionResume=path.match(/^\/api\/sessions\/([^/]+)\/resume$/);
  if(sessionResume&&method==="POST") { const s=store.getSession(sessionResume[1]);if(!s){notFound(res);return true;}json(res,202,store.createJob({type:"card.run",boardId:s.board_id,cardId:s.card_id,payload:{resumedFrom:s.id}}));return true; }
  const sessionTranscript=path.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if(sessionTranscript&&method==="GET") { const s=store.getSession(sessionTranscript[1]);if(!s){notFound(res);return true;}json(res,200,{session:s,traces:store.listTraces(s.id)});return true; }

  if(path==="/api/jobs" && method==="GET") { json(res,200,store.listJobs({workspaceId:url.searchParams.get("workspaceId")||undefined,status:url.searchParams.get("status")||undefined})); return true; }
  const jobMatch=path.match(/^\/api\/jobs\/([^/]+)$/);
  if(jobMatch && method==="GET") { const j=store.getJob(jobMatch[1]); j?json(res,200,j):notFound(res); return true; }
  if(jobMatch && method==="DELETE") { store.cancelJob(jobMatch[1]); json(res,200,{ok:true}); return true; }
  const retry=path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
  if(retry && method==="POST") { const j=store.retryJob(retry[1]);j?json(res,200,j):badRequest(res,"only FAILED or CANCELLED jobs can be retried");return true; }
  const releaseLease=path.match(/^\/api\/jobs\/([^/]+)\/release-lease$/);
  if(releaseLease&&method==="POST"){const j=store.releaseJobLease(releaseLease[1]);j?json(res,200,j):notFound(res);return true;}
  if(path==="/api/jobs/process" && method==="POST") { await worker.tick(); json(res,200,{ok:true}); return true; }

  if(path==="/api/tasks/ready" && method==="GET") { const boardId=url.searchParams.get("boardId"); json(res,200,store.listReadyCards(boardId)); return true; }
  if(path==="/api/worktrees/cleanup"&&method==="POST") { const b=await readBody(req),w=store.getWorkspace(b.workspaceId),board=store.getBoardByWorkspace(b.workspaceId);if(!w||!board){notFound(res);return true;}const cutoff=Date.now()-(Number(b.olderThanDays??7)*86_400_000),removed=[],skipped=[];for(const card of store.listCards(board.id).filter((c)=>c.worktree_path&&c.column_id==="done")){if(!b.force&&!card.pr_url&&new Date(card.updated_at).getTime()>cutoff){skipped.push(card.id);continue;}try{await new WorktreeManager().remove(w.repo_path,card.worktree_path,{force:true});store.updateCard(card.id,{worktreePath:null});removed.push(card.id);}catch(e){skipped.push(card.id);}}json(res,200,{removed,skipped});return true; }
  const delivery=path.match(/^\/api\/cards\/([^/]+)\/delivery$/);
  if(delivery&&method==="GET") { const card=store.getCard(delivery[1]); if(!card){notFound(res);return true;} json(res,200,{cardId:card.id,worktreePath:card.worktree_path,branch:card.branch_name,baseCommit:card.base_commit,headCommit:card.head_commit,prUrl:card.pr_url,artifacts:card.artifacts.filter((a)=>["evidence","review","summary"].includes(a.type))});return true; }
  const wtMatch=path.match(/^\/api\/cards\/([^/]+)\/worktree\/(validate|remove)$/);
  if(wtMatch) { const card=store.getCard(wtMatch[1]);if(!card?.worktree_path){badRequest(res,"card has no worktree");return true;}const wm=new WorktreeManager();if(wtMatch[2]==="validate"&&method==="POST"){json(res,200,await wm.validate(card.worktree_path));return true;}if(wtMatch[2]==="remove"&&method==="DELETE"){const w=store.getWorkspaceByBoard(card.board_id);if(!authorizeOperation(w,"worktree.remove",card.id,url.searchParams.get("approvalId"))){json(res,403,{error:"approved operation approval required"});return true;}await wm.remove(w.repo_path,card.worktree_path,{force:url.searchParams.get("force")==="true"});store.updateCard(card.id,{worktreePath:null});json(res,200,{ok:true});return true;} }
  const deliver=path.match(/^\/api\/cards\/([^/]+)\/deliver$/);
  if(deliver&&method==="POST") { const card=store.getCard(deliver[1]),b=await readBody(req);if(!card?.worktree_path){badRequest(res,"card has no worktree");return true;}const w=store.getWorkspaceByBoard(card.board_id);if(!authorizeOperation(w,"card.deliver",card.id,b.approvalId)){json(res,403,{error:"approved operation approval required"});return true;}await runGit(["push","-u","origin","HEAD"],card.worktree_path);const token=w.github_token??process.env.GITHUB_TOKEN,remote=(await gitStatus(card.worktree_path)).remoteUrl,slug=w.github_repo??parseGitHubSlug(remote);if(!token||!slug){json(res,200,{pushed:true,branch:card.branch_name,pr:null,note:"branch pushed; configure GitHub token/repo to create PR"});return true;}const pr=await createPullRequest({apiBase:w.github_api_base??"https://api.github.com",token,slug,title:b.title||card.title,body:b.body||card.objective,head:card.branch_name,base:b.base||card.base_branch||"main"});store.updateCard(card.id,{prUrl:pr.url});json(res,pr.existed?200:201,{pushed:true,pr});return true; }
  if(path==="/api/kanban/decompose" && method==="POST") {
    const b=await readBody(req); if(!b.boardId||!b.goal){badRequest(res,"boardId and goal are required");return true;}
    const parts=String(b.goal).split(/[。；;\n]/).map((s)=>s.trim()).filter(Boolean).slice(0,12); const cards=[];
    for(let i=0;i<parts.length;i++) cards.push(store.createCard({boardId:b.boardId,title:parts[i].slice(0,80),objective:parts[i],parentId:b.parentId??null,dependencies:b.mode==="sequential"&&i? [cards[i-1].id]:[],priority:parts.length-i,tags:["decomposed"]}));
    broadcast({type:"card",boardId:b.boardId}); json(res,201,{cards}); return true;
  }

  if(path==="/api/agents") {
    if(method==="GET") { json(res,200,store.listAgents(url.searchParams.get("workspaceId"))); return true; }
    if(method==="POST") { const b=await readBody(req); json(res,201,store.createAgent(b)); return true; }
  }
  const agentMatch=path.match(/^\/api\/agents\/([^/]+)$/);
  if(agentMatch&&method==="GET") { const a=store.getAgent(agentMatch[1]);a?json(res,200,a):notFound(res);return true; }
  if(agentMatch&&method==="PATCH") { const b=await readBody(req),a=store.updateAgent(agentMatch[1],b);a?json(res,200,a):notFound(res);return true; }
  if(agentMatch&&method==="DELETE") { store.deleteAgent(agentMatch[1]); json(res,200,{ok:true}); return true; }
  const agentStatus=path.match(/^\/api\/agents\/([^/]+)\/status$/);
  if(agentStatus&&method==="POST") { const b=await readBody(req); json(res,200,store.updateAgentStatus(agentStatus[1],b.status)); return true; }

  if(path==="/api/team-runs") {
    if(method==="GET") { json(res,200,store.listTeamRuns(url.searchParams.get("workspaceId"))); return true; }
    if(method==="POST") { const b=await readBody(req); const run=store.createTeamRun(b); store.addTeamMessage({teamRunId:run.id,role:"coordinator",content:`Goal accepted: ${b.goal}`});let job=null,approval=null;if(b.approvalRequired){approval=store.createApproval({teamRunId:run.id,prompt:b.approvalPrompt||`Approve team run: ${b.goal}`});store.updateTeamRunStatus(run.id,"WAITING_APPROVAL");}else job=store.createJob({type:"team.run",workspaceId:b.workspaceId,boardId:b.boardId,payload:{teamRunId:run.id}}); json(res,202,{run:store.getTeamRun(run.id),job,approval}); return true; }
  }
  const teamMatch=path.match(/^\/api\/team-runs\/([^/]+)$/);
  if(teamMatch&&method==="GET") { const r=store.getTeamRun(teamMatch[1]);r?json(res,200,r):notFound(res);return true; }
  const teamMessages=path.match(/^\/api\/team-runs\/([^/]+)\/messages$/);
  if(teamMessages&&method==="GET") { const r=store.getTeamRun(teamMessages[1]);r?json(res,200,r.messages):notFound(res);return true; }
  if(teamMessages&&method==="POST") { const b=await readBody(req);json(res,201,store.addTeamMessage({teamRunId:teamMessages[1],agentId:b.agentId,role:b.role||"user",content:b.content}));return true; }
  const teamApproval=path.match(/^\/api\/team-runs\/([^/]+)\/approvals$/);
  if(teamApproval&&method==="POST") { const b=await readBody(req);json(res,201,store.createApproval({teamRunId:teamApproval[1],prompt:b.prompt}));return true; }
  const approvalResolve=path.match(/^\/api\/approvals\/([^/]+)$/);
  if(approvalResolve&&method==="POST") { const b=await readBody(req),before=store.getApproval(approvalResolve[1]);if(!before){notFound(res);return true;}if(!["APPROVED","REJECTED"].includes(b.status)){badRequest(res,"status must be APPROVED or REJECTED");return true;}const approval=store.resolveApproval(before.id,b.status,b.response),run=store.getTeamRun(before.team_run_id);let job=null;if(b.status==="APPROVED"){store.updateTeamRunStatus(run.id,"PENDING");job=store.createJob({type:"team.run",workspaceId:run.workspace_id,boardId:run.board_id,payload:{teamRunId:run.id,approvedBy:b.response||"operator"}});}else store.updateTeamRunStatus(run.id,"CANCELLED");json(res,200,{approval,run:store.getTeamRun(run.id),job});return true; }

  if(path==="/api/specialists") {
    if(method==="GET") { const configs=store.listSpecialistConfigs(); json(res,200,listSpecialists().map((s)=>({...s,config:configs.find((c)=>c.lane===s.lane)||null}))); return true; }
    if(method==="PUT"||method==="POST") { const b=await readBody(req); if(!LANES.includes(b.lane)){badRequest(res,"invalid lane");return true;} json(res,200,store.upsertSpecialistConfig({lane:b.lane,name:b.name||SPECIALISTS[b.lane].name,systemPrompt:b.systemPrompt,providerId:b.providerId,enabled:b.enabled!==false})); return true; }
    if(method==="DELETE") { const b=await readBody(req); store.deleteSpecialistConfig(b.lane); json(res,200,{ok:true}); return true; }
  }

  if(path==="/api/workflows") {
    const workspaceId=url.searchParams.get("workspaceId");
    if(method==="GET") { json(res,200,store.listWorkflows(workspaceId)); return true; }
    if(method==="POST") { const b=await readBody(req); json(res,201,store.createWorkflow({workspaceId:b.workspaceId,name:b.name,definition:b.definition})); return true; }
  }
  const workflowMatch=path.match(/^\/api\/workflows\/([^/]+)$/);
  if(workflowMatch&&method==="GET") { const w=store.getWorkflow(workflowMatch[1]); w?json(res,200,w):notFound(res); return true; }
  if(workflowMatch&&method==="PATCH") { const b=await readBody(req),w=store.updateWorkflow(workflowMatch[1],b);w?json(res,200,w):notFound(res);return true; }
  if(workflowMatch&&method==="DELETE") { store.deleteWorkflow(workflowMatch[1]); json(res,200,{ok:true}); return true; }
  const workflowRun=path.match(/^\/api\/workflows\/([^/]+)\/trigger$/);
  if(workflowRun&&method==="POST") { const w=store.getWorkflow(workflowRun[1]); if(!w){notFound(res);return true;} json(res,202,store.createJob({type:"workflow.run",workspaceId:w.workspace_id,payload:{workflowId:w.id,source:"manual"}})); return true; }

  if(path==="/api/schedules") {
    if(method==="GET") { json(res,200,store.listSchedules(url.searchParams.get("workspaceId"))); return true; }
    if(method==="POST") { const b=await readBody(req); try{json(res,201,store.createSchedule(b));}catch(e){badRequest(res,e.message);}return true; }
  }
  const scheduleMatch=path.match(/^\/api\/schedules\/([^/]+)$/);
  if(scheduleMatch&&method==="GET"){const s=store.getSchedule(scheduleMatch[1]);s?json(res,200,{...s,runs:store.listScheduleRuns(s.id)}):notFound(res);return true;}
  if(scheduleMatch&&method==="PATCH"){const b=await readBody(req);try{const s=store.updateSchedule(scheduleMatch[1],b);s?json(res,200,s):notFound(res);}catch(e){badRequest(res,e.message);}return true;}
  if(scheduleMatch&&method==="DELETE"){store.deleteSchedule(scheduleMatch[1]);json(res,200,{ok:true});return true;}
  if(path==="/api/schedules/tick"&&method==="POST") { await worker.tick(); json(res,200,{ok:true}); return true; }

  if(path==="/api/skills") {
    if(method==="GET") { json(res,200,store.listSkills(url.searchParams.get("workspaceId"))); return true; }
    if(method==="POST") { const b=await readBody(req); json(res,201,store.createSkill(b)); return true; }
    if(method==="DELETE") { const b=await readBody(req); store.deleteSkill(b.id); json(res,200,{ok:true}); return true; }
  }
  const skillMatch=path.match(/^\/api\/skills\/([^/]+)$/);
  if(skillMatch&&method==="PATCH"){const b=await readBody(req),s=store.updateSkill(skillMatch[1],b);s?json(res,200,s):notFound(res);return true;}
  if(skillMatch&&method==="DELETE"){store.deleteSkill(skillMatch[1]);json(res,200,{ok:true});return true;}

  if(path==="/api/webhooks/logs"&&method==="GET") { json(res,200,store.listWebhookLogs(url.searchParams.get("workspaceId")));return true; }
  if(path==="/api/webhooks/configs") {
    if(method==="GET") { json(res,200,store.listWebhooks(url.searchParams.get("workspaceId")).map(({secret,...c})=>({...c,hasSecret:Boolean(secret)}))); return true; }
    if(method==="POST") { const b=await readBody(req),{secret,...c}=store.createWebhook(b); json(res,201,{...c,hasSecret:Boolean(secret)}); return true; }
    if(method==="DELETE") { const b=await readBody(req);store.db.prepare("DELETE FROM webhook_configs WHERE id=?").run(b.id);json(res,200,{ok:true});return true; }
  }
  const webhookConfig=path.match(/^\/api\/webhooks\/configs\/([^/]+)$/);
  if(webhookConfig&&method==="PATCH"){const b=await readBody(req),updated=store.updateWebhook(webhookConfig[1],b);if(!updated){notFound(res);return true;}const{secret,...config}=updated;json(res,200,{...config,hasSecret:Boolean(secret)});return true;}
  const hook=path.match(/^\/api\/webhooks\/([^/]+)$/);
  if(hook&&method==="POST"&&hook[1]!=="configs") {
    if(!store.getWorkspace(hook[1])){notFound(res);return true;}
    if(!acceptWebhookRate(hook[1])){json(res,429,{accepted:false,error:"webhook rate limit exceeded"});return true;}
    const b=await readBody(req), event=req.headers["x-github-event"]||b.event||"manual", delivery=req.headers["x-github-delivery"]||null;
    const configs=store.matchingWebhooks(hook[1],event), jobs=[],duplicates=[];let rejected=0;
    for(const c of configs){
      if(store.hasAcceptedWebhook(c.id,delivery)){duplicates.push(c.id);continue;}
      if(c.secret){const expected=`sha256=${createHmac("sha256",c.secret).update(req.rawBody||"").digest("hex")}`,received=String(req.headers["x-hub-signature-256"]||"");const valid=expected.length===received.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(received));if(!valid){rejected++;store.logWebhook({configId:c.id,event,deliveryId:delivery,status:"REJECTED",payload:{},error:"invalid signature"});continue;}}
      const filters=c.filters||{},matches=Object.entries(filters).every(([key,value])=>String(key.split(".").reduce((o,k)=>o?.[k],b)??"")===String(value));
      if(!matches){store.logWebhook({configId:c.id,event,deliveryId:delivery,status:"IGNORED",payload:b,error:"filters did not match"});continue;}
      const job=store.createJob({type:"workflow.run",workspaceId:c.workspace_id,payload:{workflowId:c.workflow_id,source:"webhook",event,delivery}});jobs.push(job.id);store.logWebhook({configId:c.id,event,deliveryId:delivery,status:"ACCEPTED",payload:b});
    }
    if(configs.length&&rejected===configs.length){json(res,401,{accepted:false,error:"invalid webhook signature"});return true;}
    json(res,202,{accepted:true,jobs,duplicates}); return true;
  }

  if(["/api/github/issues","/api/github/pulls","/api/github/pr-comment","/api/github/overview"].includes(path)) {
    const b=method==="POST"?await readBody(req):{},workspaceId=b.workspaceId||url.searchParams.get("workspaceId"),w=store.getWorkspace(workspaceId);
    if(!w?.github_token){badRequest(res,"GitHub token required");return true;}const remote=w.repo_path?(await gitStatus(w.repo_path)).remoteUrl:null,slug=w.github_repo??parseGitHubSlug(remote),gh={apiBase:w.github_api_base??"https://api.github.com",token:w.github_token,slug};
    if(!slug){badRequest(res,"GitHub repo slug required");return true;}
    if(path.endsWith("overview")&&method==="GET"){const [issues,pulls]=await Promise.all([listIssues({...gh,state:"open"}),listPullRequests({...gh,state:"open"})]);json(res,200,{issues,pulls});return true;}
    if(path.endsWith("issues")&&method==="GET"){json(res,200,await listIssues({...gh,state:url.searchParams.get("state")||"open"}));return true;}
    if(path.endsWith("pulls")&&method==="GET"){json(res,200,await listPullRequests({...gh,state:url.searchParams.get("state")||"open"}));return true;}
    if(path.endsWith("pr-comment")&&method==="POST"){json(res,201,await postPullRequestComment({...gh,number:b.number,body:b.body}));return true;}
  }

  const harnessMatch=path.match(/^\/api\/(harness|fitness)\/([^/]+)$/);
  if(harnessMatch&&method==="GET") { const w=store.getWorkspace(url.searchParams.get("workspaceId"));if(!w?.repo_path){badRequest(res,"workspace repo_path required");return true;}const report=await inspectHarness(w.repo_path),surface=harnessMatch[2];const payload=surface==="repo-signals"?report:surface==="github-actions"?report.githubActions:surface==="codeowners"?{path:report.codeowners,covered:Boolean(report.codeowners)}:surface==="instructions"?report.instructions:surface==="design-decisions"?report.designDecisions:surface==="plan"?{commands:report.validationCommands,checks:report.checks}:report;json(res,200,payload);return true; }
  if(path==="/api/fitness/analyze"&&method==="POST") { const b=await readBody(req),w=store.getWorkspace(b.workspaceId);if(!w?.repo_path){badRequest(res,"workspace repo_path required");return true;}json(res,200,await inspectHarness(w.repo_path));return true; }

  const analyze=path.match(/^\/api\/workspaces\/([^/]+)\/repository\/analyze$/);
  if(analyze&&method==="GET") { const w=store.getWorkspace(analyze[1]); if(!w?.repo_path){badRequest(res,"workspace repo_path required");return true;} json(res,200,await analyzeRepository(w.repo_path)); return true; }

  const toolNames=["read_file","write_file","list_files","search_files","run_command","git_status","git_diff"];
  if(path==="/api/mcp/tools"&&method==="GET") { json(res,200,{tools:toolNames}); return true; }
  if(path==="/api/mcp/tools"&&method==="POST") { const b=await readBody(req),w=store.getWorkspace(b.workspaceId); if(!w?.repo_path){badRequest(res,"workspace repo_path required");return true;} const policy=JSON.parse(w.sandbox_policy||"{}"); const ex=new ToolExecutor({root:b.root||w.repo_path,policy}); try{json(res,200,{ok:true,result:await ex.execute(b.tool,b.arguments||{})});}catch(e){badRequest(res,e.message);} return true; }
  if(path==="/api/mcp"&&method==="POST") {
    const rpc=await readBody(req),params=rpc.params||{};
    if(rpc.method==="tools/list"){json(res,200,{jsonrpc:"2.0",id:rpc.id,result:{tools:toolNames.map((name)=>({name,description:`LucaPi ${name} tool`,inputSchema:{type:"object"}}))}});return true;}
    if(rpc.method==="tools/call"){const w=store.getWorkspace(params.workspaceId);if(!w?.repo_path){json(res,200,{jsonrpc:"2.0",id:rpc.id,error:{code:-32602,message:"workspace repo_path required"}});return true;}try{const ex=new ToolExecutor({root:params.root||w.repo_path,policy:JSON.parse(w.sandbox_policy||"{}")} ),result=await ex.execute(params.name,params.arguments||{});json(res,200,{jsonrpc:"2.0",id:rpc.id,result:{content:[{type:"text",text:JSON.stringify(result)}]}});}catch(e){json(res,200,{jsonrpc:"2.0",id:rpc.id,error:{code:-32000,message:e.message}});}return true;}
    json(res,200,{jsonrpc:"2.0",id:rpc.id,error:{code:-32601,message:"Method not found"}});return true;
  }
  if(path==="/api/sandboxes/explain"&&method==="POST") { const b=await readBody(req),w=store.getWorkspace(b.workspaceId),policy={allowedCommands:["node","npm","npx","git","cargo","python","python3","pytest","go","make"],timeoutMs:120000,...(w?.sandbox_policy?JSON.parse(w.sandbox_policy):{}),...(b.policy||{})}; json(res,200,{root:b.root||w?.repo_path,policy,enforcement:"realpath/symlink containment + execFile without shell + command/argument allowlist + timeout + optional Docker isolation"}); return true; }
  if(path==="/api/sandboxes"&&method==="GET") { if(!(await dockerSandboxes.available())){json(res,200,{available:false,containers:[]});return true;}json(res,200,{available:true,containers:await dockerSandboxes.list()});return true; }
  if(path==="/api/sandboxes"&&method==="POST") { const b=await readBody(req),w=store.getWorkspace(b.workspaceId);if(!w?.repo_path){badRequest(res,"workspace repo_path required");return true;}if(b.network===true&&!authorizeOperation(w,"sandbox.network",b.workspaceId,b.approvalId)){json(res,403,{error:"approved operation approval required"});return true;}if(!(await dockerSandboxes.available())){badRequest(res,"Docker daemon unavailable");return true;}try{json(res,201,await dockerSandboxes.create({repoPath:b.root||w.repo_path,image:b.image,network:b.network===true,memory:b.memory}));}catch(e){badRequest(res,e.message);}return true; }
  const sandboxMatch=path.match(/^\/api\/sandboxes\/([^/]+)$/);
  if(sandboxMatch&&method==="GET") { try{json(res,200,await dockerSandboxes.inspect(sandboxMatch[1]));}catch(e){notFound(res);}return true; }
  if(sandboxMatch&&method==="DELETE") { try{json(res,200,await dockerSandboxes.remove(sandboxMatch[1]));}catch(e){badRequest(res,e.message);}return true; }
  const sandboxExecute=path.match(/^\/api\/sandboxes\/([^/]+)\/execute$/);
  if(sandboxExecute&&method==="POST") { const b=await readBody(req);try{json(res,200,await dockerSandboxes.execute(sandboxExecute[1],b));}catch(e){badRequest(res,e.message);}return true; }

  return false;
}
