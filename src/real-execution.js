import { CodingAgentRuntime } from "./agent-runtime.js";
import { WorktreeManager } from "./worktree.js";
import { collectGitEvidence, detectValidationCommands, evidenceMarkdown, runValidation } from "./evidence.js";
import { runGit } from "./git.js";
import { DockerSandboxManager } from "./sandbox.js";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ScanService } from "./scan-service.js";

function latest(card, type) { return [...card.artifacts].reverse().find((a)=>a.type===type); }
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

export class RealExecutionService {
  constructor(store) { this.store=store; this.worktrees=new WorktreeManager(); this.sandboxes=new DockerSandboxManager(); }

  async createSandbox(workspace,repoPath,labels={}){
    const policy=parse(workspace.sandbox_policy,{});
    if(!["docker","auto"].includes(policy.mode))return{policy,sandbox:null};
    const available=await this.sandboxes.available();
    if(available){if(policy.network===true&&!this.store.consumeNextOperationApproval(workspace.id,"sandbox.network",labels.card??workspace.id)){const resourceId=labels.card??workspace.id,pending=this.store.listOperationApprovals(workspace.id).find((a)=>a.operation==="sandbox.network"&&a.resource_id===resourceId&&a.status==="PENDING");if(!pending)this.store.createOperationApproval({workspaceId:workspace.id,operation:"sandbox.network",resourceId,payload:{phase:labels.phase,image:policy.image}});throw new Error("Docker network requires an approved sandbox.network operation approval");}return{policy,sandbox:await this.sandboxes.create({repoPath,image:policy.image,network:policy.network===true,memory:policy.memory,labels})};}
    if(policy.mode==="docker")throw new Error("Docker sandbox is required but the Docker daemon is unavailable");
    return{policy,sandbox:null};
  }

  async materializeSkills(worktreePath,skills){const root=path.join(worktreePath,".lucapi-skills"),materialized=[];await rm(root,{recursive:true,force:true});for(const skill of skills){const files=this.store.getPublishedSkillPackage(skill.id);if(!files)continue;const packageRoot=path.join(root,skill.name);for(const [relative,content] of Object.entries(files)){const target=path.resolve(packageRoot,relative);if(target!==packageRoot&&!target.startsWith(packageRoot+path.sep))throw new Error("Published skill package contains an unsafe path");await mkdir(path.dirname(target),{recursive:true});await writeFile(target,content,"utf8");if(relative.startsWith("scripts/")||String(content).startsWith("#!"))await chmod(target,0o700);}materialized.push({name:skill.name,path:path.relative(worktreePath,packageRoot),files:Object.keys(files)});}return{root,materialized};}

  async runScanHook({workspace,hook,card,root,provider,story,shouldCancel=()=>false}){const runs=await new ScanService(this.store).runWorkspaceProfiles({workspace,hook,card,root,baseCommit:card.base_commit,headCommit:card.head_commit,provider,acceptanceCriteria:story?.acceptance_criteria??[],shouldCancel}),blocked=runs.filter((run)=>["BLOCKED","FAILED"].includes(run.status));if(blocked.length)throw new Error(`${hook} scan gate blocked: ${blocked.map((run)=>run.id).join(", ")}`);return runs;}

  async executeDev({ card, provider, onEvent, shouldCancel, agent = null }) {
    const workspace=this.store.getWorkspaceByBoard(card.board_id);
    if (!workspace?.repo_path) throw new Error("Workspace has no repo_path");
    const wt=await this.worktrees.ensure({repoPath:workspace.repo_path,card});
    card=this.store.updateCard(card.id,{worktreePath:wt.path,branchName:wt.branch,baseBranch:wt.baseBranch??card.base_branch,baseCommit:wt.baseCommit??card.base_commit});
    const story=latest(card,"story")?.data?.story;
    const brief=latest(card,"brief")?.data?.brief;
    const {policy,sandbox}=await this.createSandbox(workspace,wt.path,{card:card.id,workspace:workspace.id,phase:"dev"});
    if(sandbox) policy.containerId=sandbox.id;
    const preDevScans=await this.runScanHook({workspace,hook:"pre-dev",card,root:wt.path,provider,story,shouldCancel});
    const runtime=new CodingAgentRuntime(provider);
    const skills=this.store.listSkills(workspace.id),packages=await this.materializeSkills(wt.path,skills);
    const enrichedBrief={...brief,assignedAgent:agent?{id:agent.id,name:agent.name,role:agent.role,metadata:agent.metadata}:null,skills:skills.map((s)=>({name:s.name,instructions:s.instructions,tools:s.tools,package:packages.materialized.find((p)=>p.name===s.name)??null}))};
    let run,validation;
    try{
      run=await runtime.run({worktreePath:wt.path,card,story,brief:enrichedBrief,policy,onEvent,shouldCancel});
      const configured=parse(workspace.validation_commands,null);
      const commands=Array.isArray(configured)?configured:await detectValidationCommands(wt.path);
      await rm(packages.root,{recursive:true,force:true});
      validation=await runValidation(wt.path,commands,{containerId:sandbox?.id,shouldCancel});
    }finally{await rm(packages.root,{recursive:true,force:true});if(sandbox&&!policy.keepContainer)await this.sandboxes.remove(sandbox.id).catch(()=>{});}
    const configured=parse(workspace.validation_commands,null);
    const commands=Array.isArray(configured)?configured:await detectValidationCommands(wt.path);
    const postDevScans=await this.runScanHook({workspace,hook:"post-dev",card,root:wt.path,provider,story,shouldCancel});
    await runGit(["add","-A"],wt.path);
    const staged=(await runGit(["diff","--cached","--name-only"],wt.path)).stdout.trim();
    if (staged) await runGit(["commit","-m",`feat: ${card.title}`],wt.path);
    const git=await collectGitEvidence(wt.path,card.base_commit);
    const evidence={real:true,worktreePath:wt.path,branch:wt.branch,sandbox:sandbox?{mode:"docker",id:sandbox.id,image:sandbox.image,removed:!policy.keepContainer}:{mode:"local"},changed_files:git.changedFiles,work_summary:run.summary,tests_run:validation.map((v)=>`${v.command}: exit ${v.exitCode}`).join("; ")||"No validation command detected",ac_verification:(story?.acceptance_criteria??[]).map((ac)=>({id:ac.id,how:`真实代码变更与验证命令用于检查：${ac.text}`})),committed:Boolean(staged),worktree_clean:git.clean,git,commands:validation,toolCalls:run.toolCalls,scanRunIds:[...preDevScans,...postDevScans].map((scan)=>scan.id)};
    this.store.updateCard(card.id,{headCommit:git.headCommit});
    return {artifact:{lane:"dev",specialist:"Dev Crafter",type:"evidence",content:evidenceMarkdown({git,commands:validation,toolCalls:run.toolCalls,summary:run.summary}),data:{evidence}},decision:{action:"move",target:"review",reason:"真实编码 Agent 已完成执行、验证和提交。"}};
  }

  async executeReview({card,provider=null,shouldCancel=()=>false}) {
    const evidence=latest(card,"evidence")?.data?.evidence;
    if (!evidence?.real) return null;
    const workspace=this.store.getWorkspaceByBoard(card.board_id);
    const configured=parse(workspace.validation_commands,null);
    const commands=Array.isArray(configured)?configured:await detectValidationCommands(evidence.worktreePath);
    const {policy,sandbox}=await this.createSandbox(workspace,evidence.worktreePath,{card:card.id,workspace:workspace.id,phase:"review"});
    let validation;try{validation=await runValidation(evidence.worktreePath,commands,{containerId:sandbox?.id});}finally{if(sandbox&&!policy.keepContainer)await this.sandboxes.remove(sandbox.id).catch(()=>{});}
    const git=await collectGitEvidence(evidence.worktreePath,card.base_commit);
    const failed=validation.filter((v)=>v.exitCode!==0);
    const findings=[];
    if (!git.changedFiles.length) findings.push({severity:"high",note:"没有检测到相对 base commit 的代码变更。"});
    if (!git.clean) findings.push({severity:"high",note:"评审时 worktree 不干净。"});
    const sensitiveFiles=git.changedFiles.filter((f)=>/(^|\/)(\.env(?:\.|$)|id_rsa$|.*\.pem$)/i.test(f));
    if(sensitiveFiles.length)findings.push({severity:"high",note:`检测到敏感文件变更: ${sensitiveFiles.join(", ")}`});
    if(/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AKIA[0-9A-Z]{16}|(?:api[_-]?key|token)\s*[=:]\s*["']?[A-Za-z0-9_\-]{20,}/i.test(git.diff))findings.push({severity:"high",note:"Diff 疑似包含 Secret 或私钥。"});
    for (const result of failed) findings.push({severity:"high",note:`验证失败: ${result.command} (exit ${result.exitCode})`});
    const story=latest(card,"story")?.data?.story,profiles=this.store.listScanProfiles(workspace.id,{hook:"review",enabledOnly:true}),scanRuns=[];
    for(const profile of profiles){const run=await new ScanService(this.store).runProfile({profile,workspace,card,root:evidence.worktreePath,baseCommit:card.base_commit,headCommit:git.headCommit,provider,acceptanceCriteria:story?.acceptance_criteria??[],shouldCancel});scanRuns.push(run);const blockingItems=run.findings.filter((f)=>!f.suppressed&&(!profile.policy?.newFindingsOnly||f.is_new)&&((profile.policy?.blockOn??["critical","high"]).includes(f.severity)));if(run.status==="FAILED"&&!blockingItems.length)findings.push({severity:"high",note:`扫描基础设施失败: ${profile.name}`,scanRunId:run.id});for(const item of blockingItems)findings.push({severity:item.severity,note:`${item.scanner}/${item.rule_id}: ${item.message}`,file:item.file,line:item.start_line,scanRunId:run.id});}
    const profileOwnsCodeReview=profiles.some((profile)=>profile.scanners.includes("code-review"));
    if(provider&&!profileOwnsCodeReview&&findings.length===0){
      try{
        const semantic=await provider.complete({system:"You are an independent code review gate. Review only the supplied acceptance criteria and real git diff. Return JSON: {verdict:'APPROVED'|'NOT_APPROVED',findings:[{severity:'high'|'medium'|'low',note:string,ac:string}]}. Never trust developer claims without diff evidence.",user:`Acceptance criteria: ${JSON.stringify(story?.acceptance_criteria??[])}\nChanged files: ${git.changedFiles.join(", ")}\nDiff:\n${git.diff.slice(0,60000)}`});
        if(semantic.verdict!=="APPROVED") findings.push(...(semantic.findings?.length?semantic.findings:[{severity:"high",note:"独立评审模型未批准变更。"}]));
      }catch(err){findings.push({severity:"high",note:`独立评审模型失败: ${err.message}`});}
    }
    const verdict=findings.length?"NOT_APPROVED":"APPROVED";
    const content=`## Independent Real Review\n\n- **Verdict**: ${verdict}\n- **Base**: \`${card.base_commit}\`\n- **Head**: \`${git.headCommit}\`\n- **Changed files**: ${git.changedFiles.join(", ")||"none"}\n- **Diff stat**: ${git.diffStat||"none"}\n\n### Validation\n${validation.map((v)=>`- \`${v.command}\`: exit ${v.exitCode}`).join("\n")||"- no commands"}\n\n### Findings\n${findings.map((f)=>`- [${f.severity}] ${f.note}`).join("\n")||"- none"}`;
    return {artifact:{lane:"review",specialist:"Review Guard",type:"review",content,data:{verdict,findings,real:true,scanRunIds:scanRuns.map((run)=>run.id),sandbox:sandbox?{mode:"docker",image:sandbox.image,removed:!policy.keepContainer}:{mode:"local"},git,commands:validation}},decision:{action:"move",target:verdict==="APPROVED"?"done":"dev",verdict,reason:verdict==="APPROVED"?"真实 diff 与验证命令独立复核通过。":"真实执行证据未通过独立复核。"}};
  }
}
