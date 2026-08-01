import { CodingAgentRuntime } from "./agent-runtime.js";
import { WorktreeManager } from "./worktree.js";
import { collectGitEvidence, detectValidationCommands, evidenceMarkdown, runValidation } from "./evidence.js";
import { runGit } from "./git.js";

function latest(card, type) { return [...card.artifacts].reverse().find((a)=>a.type===type); }
function parse(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }

export class RealExecutionService {
  constructor(store) { this.store=store; this.worktrees=new WorktreeManager(); }

  async executeDev({ card, provider, onEvent, shouldCancel }) {
    const workspace=this.store.getWorkspaceByBoard(card.board_id);
    if (!workspace?.repo_path) throw new Error("Workspace has no repo_path");
    const wt=await this.worktrees.ensure({repoPath:workspace.repo_path,card});
    card=this.store.updateCard(card.id,{worktreePath:wt.path,branchName:wt.branch,baseBranch:wt.baseBranch??card.base_branch,baseCommit:wt.baseCommit??card.base_commit});
    const story=latest(card,"story")?.data?.story;
    const brief=latest(card,"brief")?.data?.brief;
    const policy=parse(workspace.sandbox_policy,{});
    const agent=new CodingAgentRuntime(provider);
    const skills=this.store.listSkills(workspace.id);
    const enrichedBrief={...brief,skills:skills.map((s)=>({name:s.name,instructions:s.instructions,tools:s.tools}))};
    const run=await agent.run({worktreePath:wt.path,card,story,brief:enrichedBrief,policy,onEvent,shouldCancel});
    const configured=parse(workspace.validation_commands,null);
    const commands=Array.isArray(configured)?configured:await detectValidationCommands(wt.path);
    const validation=await runValidation(wt.path,commands);
    await runGit(["add","-A"],wt.path);
    const staged=(await runGit(["diff","--cached","--name-only"],wt.path)).stdout.trim();
    if (staged) await runGit(["commit","-m",`feat: ${card.title}`],wt.path);
    const git=await collectGitEvidence(wt.path,card.base_commit);
    const evidence={real:true,worktreePath:wt.path,branch:wt.branch,changed_files:git.changedFiles,work_summary:run.summary,tests_run:validation.map((v)=>`${v.command}: exit ${v.exitCode}`).join("; ")||"No validation command detected",ac_verification:(story?.acceptance_criteria??[]).map((ac)=>({id:ac.id,how:`真实代码变更与验证命令用于检查：${ac.text}`})),committed:Boolean(staged),worktree_clean:git.clean,git,commands:validation,toolCalls:run.toolCalls};
    this.store.updateCard(card.id,{headCommit:git.headCommit});
    return {artifact:{lane:"dev",specialist:"Dev Crafter",type:"evidence",content:evidenceMarkdown({git,commands:validation,toolCalls:run.toolCalls,summary:run.summary}),data:{evidence}},decision:{action:"move",target:"review",reason:"真实编码 Agent 已完成执行、验证和提交。"}};
  }

  async executeReview({card,provider=null}) {
    const evidence=latest(card,"evidence")?.data?.evidence;
    if (!evidence?.real) return null;
    const workspace=this.store.getWorkspaceByBoard(card.board_id);
    const configured=parse(workspace.validation_commands,null);
    const commands=Array.isArray(configured)?configured:await detectValidationCommands(evidence.worktreePath);
    const validation=await runValidation(evidence.worktreePath,commands);
    const git=await collectGitEvidence(evidence.worktreePath,card.base_commit);
    const failed=validation.filter((v)=>v.exitCode!==0);
    const findings=[];
    if (!git.changedFiles.length) findings.push({severity:"high",note:"没有检测到相对 base commit 的代码变更。"});
    if (!git.clean) findings.push({severity:"high",note:"评审时 worktree 不干净。"});
    for (const result of failed) findings.push({severity:"high",note:`验证失败: ${result.command} (exit ${result.exitCode})`});
    if(provider&&findings.length===0){
      try{
        const story=latest(card,"story")?.data?.story;
        const semantic=await provider.complete({system:"You are an independent code review gate. Review only the supplied acceptance criteria and real git diff. Return JSON: {verdict:'APPROVED'|'NOT_APPROVED',findings:[{severity:'high'|'medium'|'low',note:string,ac:string}]}. Never trust developer claims without diff evidence.",user:`Acceptance criteria: ${JSON.stringify(story?.acceptance_criteria??[])}\nChanged files: ${git.changedFiles.join(", ")}\nDiff:\n${git.diff.slice(0,60000)}`});
        if(semantic.verdict!=="APPROVED") findings.push(...(semantic.findings?.length?semantic.findings:[{severity:"high",note:"独立评审模型未批准变更。"}]));
      }catch(err){findings.push({severity:"high",note:`独立评审模型失败: ${err.message}`});}
    }
    const verdict=findings.length?"NOT_APPROVED":"APPROVED";
    const content=`## Independent Real Review\n\n- **Verdict**: ${verdict}\n- **Base**: \`${card.base_commit}\`\n- **Head**: \`${git.headCommit}\`\n- **Changed files**: ${git.changedFiles.join(", ")||"none"}\n- **Diff stat**: ${git.diffStat||"none"}\n\n### Validation\n${validation.map((v)=>`- \`${v.command}\`: exit ${v.exitCode}`).join("\n")||"- no commands"}\n\n### Findings\n${findings.map((f)=>`- [${f.severity}] ${f.note}`).join("\n")||"- none"}`;
    return {artifact:{lane:"review",specialist:"Review Guard",type:"review",content,data:{verdict,findings,real:true,git,commands:validation}},decision:{action:"move",target:verdict==="APPROVED"?"done":"dev",verdict,reason:verdict==="APPROVED"?"真实 diff 与验证命令独立复核通过。":"真实执行证据未通过独立复核。"}};
  }
}
