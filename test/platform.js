import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createApp } from "../server.js";

const check=(name,value)=>{assert.ok(value,name);console.log(`  ✓ ${name}`);};
const tmp=mkdtempSync(path.join(os.tmpdir(),"lucapi-platform-"));
const git=(args,cwd)=>execFileSync("git",args,{cwd,stdio:"pipe"}).toString().trim();
git(["init","--bare","-b","main","remote.git"],tmp);git(["clone","remote.git","work"],tmp);
const work=path.join(tmp,"work");git(["config","user.email","agent@test.local"],work);git(["config","user.name","LucaPi Agent"],work);writeFileSync(path.join(work,"README.md"),"# Fixture\n");git(["add","-A"],work);git(["commit","-m","init"],work);git(["push","-u","origin","main"],work);

const external=http.createServer(async(req,res)=>{
  let raw="";for await(const c of req)raw+=c;
  if(req.url==="/v1/models"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({data:[{id:"fake-code"}]}));return;}
  if(req.url==="/v1/chat/completions"){
    const body=JSON.parse(raw),used=body.messages.some((m)=>m.role==="tool"),probe=body.tools?.some((t)=>t.function?.name==="capability_probe");
    const message=body.response_format?{role:"assistant",content:JSON.stringify({verdict:"APPROVED",findings:[]})}:probe?{role:"assistant",content:null,tool_calls:[{id:"probe-1",type:"function",function:{name:"capability_probe",arguments:'{"ok":true}'}}]}:used?{role:"assistant",content:"Implemented agent-output.txt with a real file tool."}:{role:"assistant",content:null,tool_calls:[{id:"call-1",type:"function",function:{name:"write_file",arguments:JSON.stringify({path:"agent-output.txt",content:"implemented by LucaPi coding agent\n"})}}]};
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message}]}));return;
  }
  if(req.url==="/repos/octo/platform/pulls"&&req.method==="POST"){const b=JSON.parse(raw);res.writeHead(201,{"content-type":"application/json"});res.end(JSON.stringify({number:11,html_url:"http://mock/pr/11",title:b.title,state:"open"}));return;}
  if(req.url.startsWith("/repos/octo/platform/issues?")&&req.method==="GET"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify([{number:2,title:"Bug"},{number:11,title:"PR",pull_request:{}}]));return;}
  if(req.url.startsWith("/repos/octo/platform/pulls?")&&req.method==="GET"){res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify([{number:11,title:"Agent delivery",html_url:"http://mock/pr/11"}]));return;}
  if(req.url==="/repos/octo/platform/issues/11/comments"&&req.method==="POST"){res.writeHead(201,{"content-type":"application/json"});res.end(JSON.stringify({id:99,body:JSON.parse(raw).body,html_url:"http://mock/comment/99"}));return;}
  res.writeHead(404);res.end("{}");
});
await new Promise((r)=>external.listen(0,r));const externalBase=`http://127.0.0.1:${external.address().port}`;
const {server}=createApp({dbPath:":memory:"});await new Promise((r)=>server.listen(0,r));const base=`http://127.0.0.1:${server.address().port}`;
const api=async(p,o={})=>{const r=await fetch(base+p,{headers:{"content-type":"application/json"},...o,body:o.body?JSON.stringify(o.body):undefined});const body=await r.json().catch(()=>({}));return{status:r.status,body};};

try {
  console.log("\nLucaPi platform integration test\n");
  const ws=await api("/api/workspaces",{method:"POST",body:{name:"Platform",repoPath:work}}),workspaceId=ws.body.workspace.id,boardId=ws.body.board.id;
  await api(`/api/workspaces/${workspaceId}`,{method:"PATCH",body:{githubToken:"ghp_test",githubRepo:"octo/platform",githubApiBase:externalBase,sandboxPolicy:{allowedCommands:["node","npm","git"],timeoutMs:30000},validationCommands:[]}});
  const card=(await api(`/api/boards/${boardId}/cards`,{method:"POST",body:{title:"Create agent output",objective:"Create agent-output.txt with the requested content."}})).body;
  await api(`/api/cards/${card.id}/run`,{method:"POST"});await api(`/api/cards/${card.id}/run`,{method:"POST"});
  const provider=await api("/api/providers",{method:"POST",body:{name:"Fake Coding LLM",baseUrl:`${externalBase}/v1`,apiKey:"test",model:"fake-code",setActive:true}});check("coding provider configured",provider.status===201);
  const diagnosis=await api(`/api/providers/${provider.body.id}/diagnose`,{method:"POST"});check("provider capability diagnosis covers tools and structured JSON",diagnosis.body.ok&&diagnosis.body.checks.toolCalling.ok&&diagnosis.body.checks.structuredJson.ok);
  const dev=await api(`/api/cards/${card.id}/run`,{method:"POST"});
  check("real Coding Agent advances Dev to Review",dev.status===200&&dev.body.card.column_id==="review");
  const evidence=dev.body.card.artifacts.findLast((a)=>a.type==="evidence");
  check("evidence is sourced from real execution",evidence.data.evidence.real===true&&evidence.data.evidence.toolCalls.some((t)=>t.tool==="write_file"&&t.ok));
  check("task owns an isolated worktree and branch",Boolean(dev.body.card.worktree_path&&dev.body.card.branch_name&&dev.body.card.base_commit&&dev.body.card.head_commit));
  const review=await api(`/api/cards/${card.id}/run`,{method:"POST"});check("independent real review approves diff",review.body.card.column_id==="done"&&review.body.decision.verdict==="APPROVED");
  const wt=await api(`/api/cards/${card.id}/worktree/validate`,{method:"POST"});check("worktree validation passes",wt.body.healthy===true);
  const delivered=await api(`/api/cards/${card.id}/deliver`,{method:"POST",body:{title:"Agent delivery"}});check("task branch pushed and PR created",delivered.status===201&&delivered.body.pr.number===11);
  const delivery=await api(`/api/cards/${card.id}/delivery`);check("delivery snapshot exposes commit and PR",delivery.body.headCommit&&delivery.body.prUrl==="http://mock/pr/11");
  const issues=await api(`/api/github/issues?workspaceId=${workspaceId}`);check("GitHub issues can be listed",issues.body.length===1&&issues.body[0].number===2);
  const pulls=await api(`/api/github/pulls?workspaceId=${workspaceId}`);check("GitHub pull requests can be listed",pulls.body[0].number===11);
  const comment=await api("/api/github/pr-comment",{method:"POST",body:{workspaceId,number:11,body:"Reviewed by LucaPi"}});check("GitHub PR comment can be posted",comment.status===201&&comment.body.id===99);

  const repo=await api(`/api/workspaces/${workspaceId}/repository/analyze`);check("repository intelligence returns files and commits",repo.body.fileCount>0&&repo.body.recentCommits.length>0);
  const fitness=await api("/api/fitness/analyze",{method:"POST",body:{workspaceId}});check("fitness analysis returns governance score",Number.isInteger(fitness.body.score)&&fitness.body.checks);
  const harness=await api(`/api/harness/repo-signals?workspaceId=${workspaceId}`);check("harness repo signals are inspectable",harness.status===200&&Array.isArray(harness.body.validationCommands));
  const tools=await api("/api/mcp/tools");check("MCP tool catalog is exposed",tools.body.tools.includes("git_status"));
  const toolRun=await api("/api/mcp/tools",{method:"POST",body:{workspaceId,tool:"git_status",arguments:{}}});check("MCP tool executes under sandbox policy",toolRun.body.ok===true);
  writeFileSync(path.join(tmp,"outside.txt"),"secret");symlinkSync(tmp,path.join(work,"escape"),"dir");
  const escaped=await api("/api/mcp/tools",{method:"POST",body:{workspaceId,tool:"read_file",arguments:{path:"escape/outside.txt"}}});check("tool boundary rejects symlink escape",escaped.status===400&&escaped.body.error.includes("Symlink"));
  const rpc=await api("/api/mcp",{method:"POST",body:{jsonrpc:"2.0",id:1,method:"tools/list",params:{}}});check("MCP JSON-RPC tools/list is supported",rpc.body.result.tools.some((t)=>t.name==="read_file"));
  const sandbox=await api("/api/sandboxes/explain",{method:"POST",body:{workspaceId}});check("sandbox policy is explainable",sandbox.body.enforcement.includes("command/argument allowlist"));
  const dockerStatus=await api("/api/sandboxes");check("Docker sandbox availability is reported safely",typeof dockerStatus.body.available==="boolean");
  if(dockerStatus.body.available){const box=await api("/api/sandboxes",{method:"POST",body:{workspaceId,image:"node:22-alpine"}}),inside=await api(`/api/sandboxes/${box.body.id}/execute`,{method:"POST",body:{command:"node",args:["-e","console.log('sandbox-ok')"]}});check("Docker sandbox lifecycle is verified",inside.body.stdout.includes("sandbox-ok")&&(await api(`/api/sandboxes/${box.body.id}`,{method:"DELETE"})).body.ok);}else check("Docker sandbox lifecycle degrades safely without daemon",dockerStatus.body.containers.length===0);

  await api("/api/providers/deactivate",{method:"POST"});
  const ws2=await api("/api/workspaces",{method:"POST",body:{name:"DAG",repoPath:work}}),w2=ws2.body.workspace.id,b2=ws2.body.board.id;
  const dec=await api("/api/kanban/decompose",{method:"POST",body:{boardId:b2,goal:"Create API。Add tests。Update docs",mode:"sequential"}});check("goal decomposes into dependent cards",dec.body.cards.length===3&&dec.body.cards[1].dependencies[0]===dec.body.cards[0].id);
  const ready=await api(`/api/tasks/ready?boardId=${b2}`);check("dependency DAG exposes only ready work",ready.body.some((c)=>c.id===dec.body.cards[0].id)&&!ready.body.some((c)=>c.id===dec.body.cards[1].id));
  const specialist=await api("/api/specialists",{method:"PUT",body:{lane:"review",name:"Security Gate",enabled:true}});check("specialist config is editable",specialist.body.name==="Security Gate");
  const skill=await api("/api/skills",{method:"POST",body:{workspaceId:w2,name:"Security",instructions:"Check auth boundaries",tools:["search_files"]}});check("skill registry persists skills",skill.status===201);
  const workflow=await api("/api/workflows",{method:"POST",body:{workspaceId:w2,name:"Release",definition:{autoRun:false,steps:[{type:"card.create",title:"Release check",objective:"Validate release"}]}}});
  const trigger=await api(`/api/workflows/${workflow.body.id}/trigger`,{method:"POST"});check("workflow trigger creates durable job",trigger.status===202&&trigger.body.status==="PENDING");
  await api("/api/jobs/process",{method:"POST"});const jobs=await api(`/api/jobs?workspaceId=${w2}`);check("durable worker completes or leases workflow job",jobs.body.some((j)=>j.id===trigger.body.id&&["COMPLETED","RUNNING"].includes(j.status)));
  const schedule=await api("/api/schedules",{method:"POST",body:{workspaceId:w2,workflowId:workflow.body.id,name:"Hourly",intervalMinutes:60}});check("schedule is persisted",schedule.status===201);
  const cron=await api("/api/schedules",{method:"POST",body:{workspaceId:w2,workflowId:workflow.body.id,name:"Weekdays",cronExpression:"0 9 * * 1-5",timezone:"Asia/Shanghai",concurrencyPolicy:"FORBID"}}),paused=await api(`/api/schedules/${cron.body.id}`,{method:"PATCH",body:{enabled:false}});check("cron schedule supports timezone and pause",cron.status===201&&cron.body.timezone==="Asia/Shanghai"&&paused.body.enabled===0);
  const hook=await api("/api/webhooks/configs",{method:"POST",body:{workspaceId:w2,workflowId:workflow.body.id,event:"issues"}});check("webhook config is persisted",hook.status===201);
  const webhook=await api(`/api/webhooks/${w2}`,{method:"POST",headers:{"x-github-event":"issues"},body:{action:"opened"}});check("webhook event enqueues workflow",webhook.status===202&&webhook.body.jobs.length===1);
  await api("/api/webhooks/configs",{method:"POST",body:{workspaceId:w2,workflowId:workflow.body.id,event:"push",secret:"hook-secret"}});
  const rejectedHook=await api(`/api/webhooks/${w2}`,{method:"POST",headers:{"x-github-event":"push"},body:{ref:"main"}});check("signed webhook rejects missing signature",rejectedHook.status===401);
  const hookPayload={ref:"main"},signature=`sha256=${createHmac("sha256","hook-secret").update(JSON.stringify(hookPayload)).digest("hex")}`;
  const acceptedHook=await api(`/api/webhooks/${w2}`,{method:"POST",headers:{"x-github-event":"push","x-hub-signature-256":signature,"x-github-delivery":"delivery-1"},body:hookPayload});check("signed webhook accepts valid HMAC",acceptedHook.status===202&&acceptedHook.body.jobs.length===1);
  const duplicateHook=await api(`/api/webhooks/${w2}`,{method:"POST",headers:{"x-github-event":"push","x-hub-signature-256":signature,"x-github-delivery":"delivery-1"},body:hookPayload}),hookLogs=await api(`/api/webhooks/logs?workspaceId=${w2}`);check("webhook delivery is idempotent and auditable",duplicateHook.body.jobs.length===0&&duplicateHook.body.duplicates.length===1&&hookLogs.body.some((l)=>l.delivery_id==="delivery-1"));
  const agent=await api("/api/agents",{method:"POST",body:{workspaceId:w2,name:"Crafter A",role:"CRAFTER",providerId:provider.body.id}});check("agent registry persists agent",agent.status===201);
  const team=await api("/api/team-runs",{method:"POST",body:{workspaceId:w2,boardId:b2,goal:"Ship release",maxConcurrency:2}});check("team run creates coordinator message and durable job",team.status===202&&team.body.run.messages.length===1&&team.body.job.type==="team.run");
  let teamJob=team.body.job;
  for(let i=0;i<80&&["PENDING","RUNNING"].includes(teamJob.status);i++){await new Promise((r)=>setTimeout(r,100));teamJob=(await api(`/api/jobs/${teamJob.id}`)).body;}
  const teamResult=await api(`/api/team-runs/${team.body.run.id}`);check("team worker executes ready cards with bounded concurrency",["COMPLETED","BLOCKED"].includes(teamResult.body.status)&&teamResult.body.messages.length>=2);
  const assignedSessions=await api(`/api/cards/${dec.body.cards[0].id}/sessions`);check("team assigns cards to agents and honors agent provider",assignedSessions.body.some((s)=>s.agent_id===agent.body.id&&s.provider.includes("Fake Coding LLM")));
  const approvalTeam=await api("/api/team-runs",{method:"POST",body:{workspaceId:w2,boardId:b2,goal:"Approved maintenance",maxConcurrency:1,approvalRequired:true}});check("approval gate prevents team job enqueue",approvalTeam.body.run.status==="WAITING_APPROVAL"&&!approvalTeam.body.job&&approvalTeam.body.approval.status==="PENDING");
  const approval=await api(`/api/approvals/${approvalTeam.body.approval.id}`,{method:"POST",body:{status:"APPROVED",response:"integration test"}});check("approval resumes team through durable queue",approval.body.job?.type==="team.run"&&approval.body.run.status!=="WAITING_APPROVAL");
  const health=await api("/api/health");check("health exposes worker identity and queue metrics",health.body.worker.workerId&&Number.isInteger(health.body.jobs.pending));
  const schema=await api("/api/admin/schema");check("database exposes ordered migration version",schema.body.userVersion>=2&&schema.body.migrations.length>=2);
  await api(`/api/workspaces/${w2}`,{method:"PATCH",body:{sandboxPolicy:{requireApprovalFor:["card.delete"]}}});const guarded=(await api(`/api/boards/${b2}/cards`,{method:"POST",body:{title:"Guarded delete"}})).body,deniedDelete=await api(`/api/cards/${guarded.id}`,{method:"DELETE",body:{}}),operationRequest=await api("/api/operation-approvals",{method:"POST",body:{workspaceId:w2,operation:"card.delete",resourceId:guarded.id,payload:{reason:"test"}}});await api(`/api/operation-approvals/${operationRequest.body.id}`,{method:"POST",body:{status:"APPROVED",response:"test"}});const allowedDelete=await api(`/api/cards/${guarded.id}`,{method:"DELETE",body:{approvalId:operationRequest.body.id}});check("operation approval gates and resumes destructive action",deniedDelete.status===403&&allowedDelete.status===200);

  const secured=createApp({dbPath:":memory:",apiToken:"secret-token"}),securedServer=secured.server;await new Promise((r)=>securedServer.listen(0,r));const securedBase=`http://127.0.0.1:${securedServer.address().port}`;
  const publicHealth=await fetch(`${securedBase}/api/health`),denied=await fetch(`${securedBase}/api/state`),authorized=await fetch(`${securedBase}/api/state`,{headers:{authorization:"Bearer secret-token"}});check("optional API token protects platform APIs",publicHealth.status===200&&denied.status===401&&authorized.status===200);securedServer.close();

  console.log("\nPlatform checks passed ✅\n");
} finally { server.close(); external.close(); }
