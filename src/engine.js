/**
 * LucaPi delivery engine — runs lane specialists against cards, enforces
 * distrust gates, records sessions and moves cards through the delivery board.
 */
import { SPECIALISTS, LANES } from "./specialists.js";

const SWEEP_ORDER = ["backlog", "todo", "dev", "review", "blocked", "done"];
const MAX_SWEEPS = 10;

export class Engine {
  constructor(store, getProviders, broadcast = () => {}, realExecution = null) {
    this.store = store;
    this.realExecution = realExecution;
    // getProviders() is evaluated on every run so provider config changes
    // (activate / deactivate / edit) take effect without a restart.
    this.getProviders = getProviders;
    this.broadcast = broadcast;
    this.boardLocks = new Set();
  }

  /**
   * Run the specialist of the card's current lane exactly once.
   * Returns { card, sessionId, moved, decision }.
   */
  async runCard(cardId, { agent = null } = {}) {
    const card = this.store.getCard(cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);
    const lane = card.column_id;
    const baseSpecialist = SPECIALISTS[lane];
    if (!baseSpecialist) throw new Error(`No specialist for lane ${lane}`);
    const config = this.store.listSpecialistConfigs().find((c) => c.lane === lane);
    const specialist = config ? { ...baseSpecialist, name: config.name || baseSpecialist.name, systemPrompt: config.system_prompt || baseSpecialist.systemPrompt } : baseSpecialist;
    if (config?.enabled === 0) return { card, sessionId: null, moved: false, decision: { action: "stay", reason: `${lane} specialist is disabled` } };

    // Terminal-lane no-op: e.g. Done Reporter stays silent once summarized.
    if (specialist.shouldRun && !specialist.shouldRun(card)) {
      return { card, sessionId: null, moved: false, decision: { action: "stay", reason: "No-op: already reported." } };
    }

    const providers = this.getProviders(agent?.provider_id ?? config?.provider_id ?? null);
    const providerName = providers.primary.name;
    const sessionId = this.store.createSession({
      cardId: card.id,
      boardId: card.board_id,
      lane,
      specialistId: specialist.id,
      specialistName: specialist.name,
      provider: providerName,
      agentId: agent?.id ?? null,
    });
    let seq = 0;
    const trace = (kind, message, data) => this.store.trace(sessionId, ++seq, kind, message, data);

    trace("info", `${specialist.name} 进入 ${lane} 泳道，开始处理「${card.title}」`);
    trace("info", `角色提醒: ${specialist.roleReminder}`);

    const finish = (status, verdict, summary) => {
      this.store.finishSession(sessionId, { status, verdict, summary });
      this.broadcast({ type: "card", cardId: card.id, boardId: card.board_id });
    };

    // ── Entry gate: distrust upstream ──────────────────────────────
    const rejection = specialist.entryGate(card);
    if (rejection) {
      trace("gate", `Entry gate 未通过: ${rejection.reason}`);
      this.store.appendArtifact(card.id, {
        lane,
        specialist: specialist.name,
        type: "feedback",
        content: `## ${specialist.name} Feedback\n\n**Entry gate rejected**: ${rejection.reason}`,
        data: { entryGateRejection: true, reason: rejection.reason },
      });
      const updated = this.store.updateCard(card.id, { columnId: rejection.rejectTo });
      trace("decision", `卡片打回 ${rejection.rejectTo}`, { reason: rejection.reason });
      finish("COMPLETED", "REJECTED", rejection.reason);
      return { card: updated, sessionId, moved: true, decision: { action: "move", target: rejection.rejectTo, reason: rejection.reason } };
    }
    trace("gate", "Entry gate 通过，上游工件齐备且可解析。");

    // ── Produce artifact: LLM first (if configured), else simulated ─
    let produced = null;
    // Dev and Review use the real coding/runtime boundary when an LLM provider is active.
    if (this.realExecution && providers.mode === "llm" && lane === "dev") {
      try {
        trace("info", "启动任务级 worktree 与真实 Coding Agent Runtime。");
        produced = await this.realExecution.executeDev({
          card,
          provider: providers.primary,
          onEvent: (event) => trace("tool", `${event.tool}: ${event.type}`, event),
          shouldCancel: () => this.store.isSessionCancelRequested(sessionId),
          agent,
        });
      } catch (err) {
        trace("error", `真实编码执行失败: ${err.message}`);
        produced = {
          artifact: { lane, specialist: specialist.name, type: "feedback", content: `## Real Execution Failure\n\n${err.message}`, data: { realExecutionFailure: true } },
          decision: { action: "move", target: "blocked", verdict: "BLOCKED", reason: "真实编码执行失败，需要恢复或人工处理。" },
        };
      }
    }
    if (this.realExecution && lane === "review") {
      try { produced = await this.realExecution.executeReview({ card, provider: providers.mode === "llm" ? providers.primary : null }); }
      catch (err) {
        trace("error", `独立真实评审失败: ${err.message}`);
        const hasRealEvidence=[...card.artifacts].reverse().find((artifact)=>artifact.type==="evidence")?.data?.evidence?.real===true;
        if(hasRealEvidence)produced={artifact:{lane,specialist:specialist.name,type:"feedback",content:`## Independent Review Infrastructure Failure\n\n${err.message}`,data:{realReviewFailure:true}},decision:{action:"move",target:"blocked",verdict:"BLOCKED",reason:"真实评审基础设施失败，禁止降级批准。"}};
      }
    }
    if (!produced && providers.mode === "llm") {
      try {
        const { system, user } = specialist.buildPrompt(card);
        trace("info", `调用 LLM provider (${providers.primary.name})...`);
        const raw = await providers.primary.complete({ system, user });
        produced = specialist.normalize(raw, card);
        trace("info", "LLM 输出已通过契约校验。");
      } catch (err) {
        trace("error", `LLM 调用失败，回退到 simulated provider: ${err.message}`);
      }
    }
    if (!produced && providers.mode === "llm") trace("info", "使用 simulated provider 产出工件。");
    if (!produced) produced = specialist.simulate(card);

    const { artifact, decision } = produced;
    this.store.appendArtifact(card.id, artifact);
    trace("artifact", `已追加工件 [${artifact.type}]`, { preview: artifact.content.slice(0, 200) });
    trace("decision", `决策: ${decision.action}${decision.target ? ` -> ${decision.target}` : ""}。${decision.reason ?? ""}`);

    // ── Apply decision ─────────────────────────────────────────────
    let patch = {};
    let moved = false;
    if (decision.action === "move" && decision.target && LANES.includes(decision.target)) {
      patch.columnId = decision.target;
      moved = decision.target !== lane;
      if (decision.target === "blocked") patch.blockedFrom = lane;
      if (lane === "review" && decision.verdict === "NOT_APPROVED")
        patch.reviewRejections = card.review_rejections + 1;
      if (lane === "blocked") patch.reviewRejections = 0; // resolver resets the loop counter
      trace("decision", `卡片移动: ${lane} → ${decision.target}`);
    } else {
      trace("decision", `卡片留在 ${lane}。`);
    }
    if (decision.verdict) patch.verdict = decision.verdict;
    const updated = this.store.updateCard(card.id, patch);
    finish("COMPLETED", decision.verdict ?? (moved ? "ADVANCED" : "STAYED"), decision.reason ?? "");
    return { card: updated, sessionId, moved, decision };
  }

  listRunnableCards(boardId) {
    const cards=this.store.listCards(boardId), doneIds=new Set(cards.filter((c)=>c.column_id==="done").map((c)=>c.id));
    return cards.filter((card)=>{
      if(card.column_id==="done") return SPECIALISTS.done.shouldRun?.(card) ?? false;
      return card.dependencies.every((id)=>doneIds.has(id));
    });
  }

  /**
   * Board automation sweep: iterate lanes in order, run every dependency-ready
   * card once per sweep, repeat until the board is stable.
   */
  async runBoard(boardId) {
    if (this.boardLocks.has(boardId)) return { ok: false, error: "Board automation already running." };
    this.boardLocks.add(boardId);
    const summary = { sweeps: 0, runs: 0, moves: 0, sessions: [] };
    try {
      this.broadcast({ type: "automation", boardId, state: "started" });
      for (let sweep = 1; sweep <= MAX_SWEEPS; sweep++) {
        summary.sweeps = sweep;
        let movedThisSweep = 0;
        for (const lane of SWEEP_ORDER) {
          const cards = this.listRunnableCards(boardId).filter((c) => c.column_id === lane);
          for (const card of cards) {
            const result = await this.runCard(card.id);
            summary.runs++;
            summary.sessions.push(result.sessionId);
            if (result.moved) movedThisSweep++;
            this.broadcast({
              type: "progress",
              boardId,
              sweep,
              lane,
              cardId: card.id,
              moved: result.moved,
              decision: result.decision,
            });
          }
        }
        summary.moves += movedThisSweep;
        if (movedThisSweep === 0) break; // board is stable
      }
      this.broadcast({ type: "automation", boardId, state: "finished", summary });
      return { ok: true, ...summary };
    } finally {
      this.boardLocks.delete(boardId);
    }
  }
}
