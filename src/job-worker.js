export class DurableWorker {
  constructor({ store, engine, broadcast, intervalMs = 250, maxConcurrency = 2 }) {
    this.store=store; this.engine=engine; this.broadcast=broadcast; this.intervalMs=intervalMs; this.maxConcurrency=maxConcurrency; this.timer=null; this.active=0; this.scheduling=false;
  }
  start() {
    this.store.recoverExpiredJobs();
    this.timer=setInterval(()=>this.tick(),this.intervalMs); this.timer.unref?.();
  }
  stop() { if(this.timer) clearInterval(this.timer); this.timer=null; }
  async tick() {
    if(this.active>=this.maxConcurrency) return;
    if(!this.scheduling) {
      this.scheduling=true;
      try {
        for (const schedule of this.store.dueSchedules()) {
          this.store.createJob({type:"workflow.run",workspaceId:schedule.workspace_id,payload:{workflowId:schedule.workflow_id,source:"schedule"}});
          this.store.markScheduleRun(schedule.id,schedule.interval_minutes);
        }
      } finally { this.scheduling=false; }
    }
    const job=this.store.claimJob(); if(!job) return;
    this.active++;
    this.process(job).finally(()=>{this.active--;});
  }
  async process(job) {
    this.broadcast({type:"job",jobId:job.id,status:"RUNNING"});
    const heartbeat=setInterval(()=>this.store.renewJobLease(job.id),30_000); heartbeat.unref?.();
    try { const result=await this.execute(job); const completed=this.store.completeJob(job.id,result); this.broadcast({type:"job",jobId:job.id,status:completed?"COMPLETED":"CANCELLED"}); }
    catch(err) { const before=this.store.getJob(job.id),retry=this.store.failJob(job.id,err.message,Math.min(30_000,1000*2**job.attempts)); this.broadcast({type:"job",jobId:job.id,status:before?.status==="CANCELLED"?"CANCELLED":retry?"RETRY":"FAILED",error:err.message}); }
    finally { clearInterval(heartbeat); }
  }
  async execute(job) {
    if(job.type==="card.run") return this.engine.runCard(job.card_id);
    if(job.type==="board.run") return this.engine.runBoard(job.board_id);
    if(job.type==="team.run") {
      const run=this.store.getTeamRun(job.payload.teamRunId); if(!run) throw new Error("Team run not found");
      this.store.updateTeamRunStatus(run.id,"ACTIVE");
      const agents=this.store.listAgents(run.workspace_id).slice(0,run.max_concurrency);
      agents.forEach((a)=>this.store.updateAgentStatus(a.id,"ACTIVE"));
      let executions=0;
      for(let round=0;round<20;round++) {
        const ready=this.store.listReadyCards(run.board_id).filter((c)=>!["done","blocked"].includes(c.column_id));
        if(!ready.length) break;
        const results=await Promise.all(ready.slice(0,run.max_concurrency).map((card)=>this.engine.runCard(card.id)));
        executions+=results.length;
        if(!results.some((r)=>r.moved)) break;
      }
      const remaining=this.store.listCards(run.board_id).filter((c)=>c.column_id!=="done");
      const status=remaining.length?"BLOCKED":"COMPLETED";
      this.store.updateTeamRunStatus(run.id,status);
      agents.forEach((a)=>this.store.updateAgentStatus(a.id,"IDLE"));
      this.store.addTeamMessage({teamRunId:run.id,role:"coordinator",content:`Team run ${status}: ${executions} specialist executions, ${remaining.length} cards remaining.`});
      return {teamRunId:run.id,status,executions,remaining:remaining.map((c)=>c.id)};
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
