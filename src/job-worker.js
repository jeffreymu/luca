import { randomUUID } from "node:crypto";
import { ScanService } from "./scan-service.js";

export class DurableWorker {
  constructor({ store, engine, broadcast, intervalMs = 250, maxConcurrency = 2, workerId = process.env.LUCAPI_WORKER_ID ?? `worker-${randomUUID().slice(0,8)}` }) {
    this.store=store; this.engine=engine; this.broadcast=broadcast; this.intervalMs=intervalMs; this.maxConcurrency=maxConcurrency; this.workerId=workerId;this.timer=null; this.active=0; this.scheduling=false;this.stopping=false;this.processed=0;this.failed=0;
  }
  start() {
    this.store.recoverExpiredJobs();
    this.timer=setInterval(()=>this.tick(),this.intervalMs); this.timer.unref?.();
  }
  async stop({drainMs=30_000}={}) { this.stopping=true;if(this.timer) clearInterval(this.timer);this.timer=null;const until=Date.now()+drainMs;while(this.active&&Date.now()<until)await new Promise((r)=>setTimeout(r,50));return{drained:this.active===0,active:this.active}; }
  metrics(){return{workerId:this.workerId,active:this.active,maxConcurrency:this.maxConcurrency,processed:this.processed,failed:this.failed,stopping:this.stopping};}
  async tick() {
    if(this.stopping||this.active>=this.maxConcurrency) return;
    if(!this.scheduling) {
      this.scheduling=true;
      try {
        for(let i=0;i<100;i++){
          const schedule=this.store.claimDueSchedule(this.workerId);if(!schedule)break;
          const active=this.store.activeScheduleJobs(schedule.id);
          if(active.length&&schedule.concurrency_policy==="FORBID"){this.store.logScheduleRun(schedule.id,null,"SKIPPED_CONCURRENT");this.store.markScheduleRun(schedule.id);continue;}
          if(active.length&&schedule.concurrency_policy==="REPLACE")active.forEach((job)=>this.store.cancelJob(job.id));
          const job=this.store.createJob({type:"workflow.run",workspaceId:schedule.workspace_id,payload:{workflowId:schedule.workflow_id,source:"schedule",scheduleId:schedule.id}});
          this.store.logScheduleRun(schedule.id,job.id,"ENQUEUED");this.store.markScheduleRun(schedule.id);
        }
      } finally { this.scheduling=false; }
    }
    const job=this.store.claimJob(120_000,this.workerId); if(!job) return;
    this.active++;
    this.process(job).finally(()=>{this.active--;});
  }
  async process(job) {
    this.broadcast({type:"job",jobId:job.id,status:"RUNNING"});
    const resourceType=job.board_id?"board":job.card_id?"card":"job",resourceId=job.board_id??job.card_id??job.id,lease=this.store.acquireExecutionLease(resourceType,resourceId,this.workerId);
    if(!lease){this.store.releaseJobLease(job.id,{delayMs:1000,refundAttempt:true});this.broadcast({type:"job",jobId:job.id,status:"RETRY"});return;}
    const heartbeat=setInterval(()=>{this.store.renewJobLease(job.id);this.store.renewExecutionLease(resourceType,resourceId,this.workerId);},30_000); heartbeat.unref?.();
    try { const result=await this.execute(job); const completed=this.store.completeJob(job.id,result);if(completed){this.processed++;if(job.payload.scheduleId)this.store.updateScheduleRunByJob(job.id,"COMPLETED");}this.broadcast({type:"job",jobId:job.id,status:completed?"COMPLETED":"CANCELLED"}); }
    catch(err) { this.failed++;const before=this.store.getJob(job.id),retry=this.store.failJob(job.id,err.message,Math.min(30_000,1000*2**job.attempts));if(job.payload.scheduleId)this.store.updateScheduleRunByJob(job.id,retry?"RETRY":"FAILED");this.broadcast({type:"job",jobId:job.id,status:before?.status==="CANCELLED"?"CANCELLED":retry?"RETRY":"FAILED",error:err.message}); }
    finally { clearInterval(heartbeat);this.store.releaseExecutionLease(resourceType,resourceId,this.workerId); }
  }
  async execute(job) {
    if(job.type==="scan.run"){
      const workspace=this.store.getWorkspace(job.workspace_id),profile=this.store.getScanProfile(job.payload.profileId),card=job.card_id?this.store.getCard(job.card_id):null;if(!workspace||!profile)throw new Error("Scan workspace or profile not found");const root=job.payload.root||card?.worktree_path||workspace.repo_path,provider=this.engine.getProviders(profile.config?.providerId??null);const story=card?[...card.artifacts].reverse().find((a)=>a.type==="story")?.data?.story:null;return new ScanService(this.store).runProfile({profile,workspace,card,root,baseCommit:job.payload.baseCommit??card?.base_commit,headCommit:job.payload.headCommit??card?.head_commit,provider:provider.mode==="llm"?provider.primary:null,acceptanceCriteria:story?.acceptance_criteria??[],shouldCancel:()=>this.store.getJob(job.id)?.status==="CANCELLED"});
    }
    if(job.type==="card.run") return this.engine.runCard(job.card_id);
    if(job.type==="board.run") return this.engine.runBoard(job.board_id);
    if(job.type==="team.run") {
      const run=this.store.getTeamRun(job.payload.teamRunId); if(!run) throw new Error("Team run not found");
      const pending=run.approvals.find((a)=>a.status==="PENDING"),rejected=run.approvals.find((a)=>a.status==="REJECTED");
      if(pending){this.store.updateTeamRunStatus(run.id,"WAITING_APPROVAL");return{teamRunId:run.id,status:"WAITING_APPROVAL",approvalId:pending.id};}
      if(rejected){this.store.updateTeamRunStatus(run.id,"CANCELLED");return{teamRunId:run.id,status:"CANCELLED",approvalId:rejected.id};}
      this.store.updateTeamRunStatus(run.id,"ACTIVE");
      const agents=this.store.listAgents(run.workspace_id).slice(0,run.max_concurrency);
      if(!agents.length) throw new Error("Team run requires at least one registered agent");
      agents.forEach((a)=>this.store.updateAgentStatus(a.id,"ACTIVE"));
      let executions=0,assignmentIndex=0;
      try {
        for(let round=0;round<20;round++) {
          const ready=this.store.listReadyCards(run.board_id).filter((c)=>!["done","blocked"].includes(c.column_id));
          if(!ready.length) break;
          const batch=ready.slice(0,run.max_concurrency).map((card)=>{
            const eligible=agents.filter((a)=>!a.metadata?.lanes?.length||a.metadata.lanes.includes(card.column_id)),explicit=eligible.find((a)=>a.id===card.assignee||a.name===card.assignee),agent=explicit??eligible[assignmentIndex++%eligible.length]??agents[assignmentIndex++%agents.length];
            this.store.updateCard(card.id,{assignee:agent.id});
            this.store.addTeamMessage({teamRunId:run.id,agentId:agent.id,role:"coordinator",content:`Assigned “${card.title}” (${card.column_id}) to ${agent.name} [${agent.role}].`});
            return{card,agent};
          });
          const settled=await Promise.allSettled(batch.map(({card,agent})=>this.engine.runCard(card.id,{agent}))),results=[];
          for(let i=0;i<settled.length;i++){
            if(settled[i].status==="fulfilled"){results.push(settled[i].value);continue;}
            const {card,agent}=batch[i],replacement=agents.find((a)=>a.id!==agent.id);
            if(!replacement)throw settled[i].reason;
            this.store.addTeamMessage({teamRunId:run.id,agentId:replacement.id,role:"coordinator",content:`Reassigned “${card.title}” from ${agent.name} to ${replacement.name} after failure: ${settled[i].reason.message}`});
            this.store.updateCard(card.id,{assignee:replacement.id});results.push(await this.engine.runCard(card.id,{agent:replacement}));
          }
          for(let i=0;i<results.length;i++)if(results[i].decision?.target==="blocked"){const failedAgent=batch[i]?.agent,replacement=agents.find((a)=>a.id!==failedAgent?.id);if(replacement){this.store.updateCard(batch[i].card.id,{assignee:replacement.id});this.store.addTeamMessage({teamRunId:run.id,agentId:replacement.id,role:"coordinator",content:`Failure handoff: ${replacement.name} will recover “${batch[i].card.title}” after ${failedAgent.name}.`});}}
          executions+=results.length;
          if(!results.some((r)=>r.moved)) break;
        }
        const remaining=this.store.listCards(run.board_id).filter((c)=>c.column_id!=="done");
        const status=remaining.length?"BLOCKED":"COMPLETED";
        this.store.updateTeamRunStatus(run.id,status);
        this.store.addTeamMessage({teamRunId:run.id,role:"coordinator",content:`Team run ${status}: ${executions} specialist executions, ${remaining.length} cards remaining.`});
        return {teamRunId:run.id,status,executions,remaining:remaining.map((c)=>c.id)};
      } finally { agents.forEach((a)=>this.store.updateAgentStatus(a.id,"IDLE")); }
    }
    if(job.type==="workflow.run") {
      const workflow=this.store.getWorkflow(job.payload.workflowId); if(!workflow) throw new Error("Workflow not found");
      const board=this.store.getBoardByWorkspace(workflow.workspace_id); if(!board) throw new Error("Workspace board not found");
      const created=[];
      for(const step of workflow.definition.steps??[]) {
        if(step.type==="card.create") {
          const dependencies=(step.dependsOn??[]).map((index)=>created[index]?.id).filter(Boolean);
          created.push(this.store.createCard({boardId:board.id,title:step.title,objective:step.objective??"",dependencies,priority:step.priority??0,tags:step.tags??[]}));
        }
      }
      if(workflow.definition.autoRun!==false) this.store.createJob({type:"board.run",workspaceId:workflow.workspace_id,boardId:board.id,payload:{source:"workflow",workflowId:workflow.id}});
      return {workflowId:workflow.id,created:created.map((c)=>c.id)};
    }
    throw new Error(`Unknown job type: ${job.type}`);
  }
}
