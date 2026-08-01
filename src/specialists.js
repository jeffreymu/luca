/**
 * LucaPi lane specialists — contract-driven autonomous delivery roles
 * (resources/specialists/workflows/kanban/*.yaml).
 *
 * Each specialist owns one lane and follows the same protocol:
 *   entryGate(card, ctx)   -> null | { rejectTo, reason }   (distrust upstream)
 *   buildPrompt(card, ctx) -> { system, user }              (for a real LLM)
 *   simulate(card, ctx)    -> { artifact, decision }        (offline provider)
 *   normalize(raw, card)   -> { artifact, decision }        (validate LLM output)
 *
 * An artifact = { lane, specialist, type, content (markdown), data (structured) }.
 * A decision  = { action: "move" | "stay", target?, verdict?, reason }.
 */

export const LANES = ["backlog", "todo", "dev", "review", "done", "blocked"];

export const LANE_META = {
  backlog: { name: "Backlog", specialist: "backlog-refiner" },
  todo: { name: "Todo", specialist: "todo-orchestrator" },
  dev: { name: "Dev", specialist: "dev-crafter" },
  review: { name: "Review", specialist: "review-guard" },
  done: { name: "Done", specialist: "done-reporter" },
  blocked: { name: "Blocked", specialist: "blocked-resolver" },
};

// ── Shared helpers ──────────────────────────────────────────────────

const VAGUE_RE = /(等等|等\b|etc\.?|properly|correctly|reasonable|合理|尽快|适当|优化一下|appropriate|user-?friendly)/i;

export function isVague(text) {
  return VAGUE_RE.test(text ?? "");
}

function yamlScalar(v) {
  const s = String(v);
  return /[:#\n\[\]{}]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

/** Minimal YAML serializer for the canonical story block. */
export function toYaml(value, indent = 0) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          const keys = Object.keys(item);
          const [first, ...rest] = keys;
          let out = `${pad}- ${first}: ${yamlScalar(item[first])}\n`;
          for (const k of rest) {
            if (typeof item[k] === "object") out += `${pad}  ${k}:\n${toYaml(item[k], indent + 2)}`;
            else out += `${pad}  ${k}: ${yamlScalar(item[k])}\n`;
          }
          return out.trimEnd();
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([k, v]) => {
        if (typeof v === "object" && v !== null) return `${pad}${k}:\n${toYaml(v, indent + 1)}`;
        return `${pad}${k}: ${yamlScalar(v)}`;
      })
      .join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

function latestArtifact(card, type) {
  for (let i = card.artifacts.length - 1; i >= 0; i--) {
    if (card.artifacts[i].type === type) return card.artifacts[i];
  }
  return null;
}

function artifactsOfType(card, type) {
  return card.artifacts.filter((a) => a.type === type);
}

function storyBlock(story) {
  return "```yaml\n" + toYaml({ story }) + "\n```";
}

function splitIntoACs(objective, title) {
  const source = (objective || "").trim() || title;
  const parts = source
    .split(/[。；;\n]|,\s*(?=[\u4e00-\u9fff])/)
    .map((s) => s.trim().replace(/^[-*•]\s*/, ""))
    .filter((s) => s.length >= 4)
    .slice(0, 4);
  const acs = (parts.length ? parts : [title]).map((text, i) => ({
    id: `AC${i + 1}`,
    text: text.length > 120 ? text.slice(0, 117) + "..." : text,
    testable: true,
  }));
  return acs;
}

function guessFiles(card, story) {
  const areas = story?.constraints_and_affected_areas ?? [];
  if (areas.length) return areas.slice(0, 5);
  const slug = card.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "feature";
  return [`src/features/${slug}/index.ts`, `src/features/${slug}/${slug}.test.ts`];
}

// ── 1. Backlog Refiner ──────────────────────────────────────────────

const backlogRefiner = {
  id: "backlog-refiner",
  name: "Backlog Refiner",
  lane: "backlog",
  role: "CRAFTER",
  modelTier: "SMART",
  roleReminder:
    "Backlog is for clarification and shaping. Do not implement code here. When the story is ready, move it forward.",
  systemPrompt: `You sweep the Backlog lane.
## Mission
- Clarify the request and rewrite the card into an implementation-ready canonical story.
- Keep backlog focused on scope, acceptance criteria, and execution guidance.
- When the card is ready, decide move -> todo.

## Canonical Story Contract
All cards leaving Backlog MUST include exactly one canonical story with:
title, problem_statement, user_value, acceptance_criteria (each with id/text/testable),
constraints_and_affected_areas, dependencies_and_sequencing, out_of_scope, invest.`,
  entryGate() {
    return null; // Backlog is the entry point; nothing upstream to distrust.
  },
  buildPrompt(card) {
    return {
      system: this.systemPrompt,
      user: `Card title: ${card.title}\nCard objective: ${card.objective || "(empty)"}\n\nRespond with JSON: {"story": {...canonical story...}, "decision": {"action": "move"|"stay", "reason": "..."}}`,
    };
  },
  simulate(card) {
    const acs = splitIntoACs(card.objective, card.title);
    const story = {
      version: 1,
      title: card.title,
      problem_statement:
        card.objective?.trim() || `「${card.title}」尚未实现，需要从零定义并交付该能力。`,
      user_value: "交付后可被最终用户直接使用，完成该卡片所承诺的业务价值。",
      acceptance_criteria: acs,
      constraints_and_affected_areas: guessFiles(card, null),
      dependencies_and_sequencing: {
        independent_story_check: "pass",
        depends_on: ["none"],
        unblock_condition: "无前置依赖，可立即进入开发。",
      },
      out_of_scope: ["与本卡片标题无关的重构", "未在验收标准中列出的新功能"],
      invest: {
        independent: { status: "pass", reason: "故事可独立交付，不依赖其他卡片。" },
        testable: { status: "pass", reason: `包含 ${acs.length} 条可测试验收标准。` },
      },
    };
    const artifact = {
      lane: "backlog",
      specialist: this.name,
      type: "story",
      content: `## Canonical Story\n\n${storyBlock(story)}`,
      data: { story },
    };
    return {
      artifact,
      decision: { action: "move", target: "todo", reason: "Canonical story 已生成且通过 INVEST 检查。" },
    };
  },
  normalize(raw, card) {
    if (!raw?.story?.acceptance_criteria?.length) {
      return {
        artifact: {
          lane: "backlog", specialist: this.name, type: "feedback",
          content: "## Refiner Feedback\n\nLLM 输出缺少合法 story，卡片留在 Backlog。",
          data: {},
        },
        decision: { action: "stay", reason: "Story contract validation failed." },
      };
    }
    const story = { version: 1, ...raw.story };
    return {
      artifact: {
        lane: "backlog", specialist: this.name, type: "story",
        content: `## Canonical Story\n\n${storyBlock(story)}`,
        data: { story },
      },
      decision: { action: "move", target: "todo", reason: raw.decision?.reason ?? "Story ready." },
    };
  },
};

// ── 2. Todo Orchestrator ────────────────────────────────────────────

const todoOrchestrator = {
  id: "todo-orchestrator",
  name: "Todo Orchestrator",
  lane: "todo",
  role: "CRAFTER",
  modelTier: "SMART",
  roleReminder:
    "Distrust the upstream card. Re-parse the canonical story, reject weak stories back to Backlog, and append an execution-ready brief.",
  systemPrompt: `You sweep the Todo lane.
## Mission
- Re-validate the Backlog story. Reject malformed or vague cards back to backlog.
- Turn a valid story into an execution-ready brief: execution plan, key files, dependency plan, risk notes.
- Move to dev only when implementation can start within minutes.`,
  entryGate(card) {
    const story = latestArtifact(card, "story");
    if (!story || !story.data?.story?.acceptance_criteria?.length) {
      return { rejectTo: "backlog", reason: "缺少可解析的 canonical story YAML，打回 Backlog 重新精炼。" };
    }
    return null;
  },
  buildPrompt(card) {
    const story = latestArtifact(card, "story");
    return {
      system: this.systemPrompt,
      user: `Canonical story:\n${storyBlock(story.data.story)}\n\nRespond with JSON: {"brief": {"execution_plan": [...], "key_files": [...], "dependency_plan": "...", "risk_notes": [...]}, "decision": {"action": "move"|"stay", "reason": "..."}}`,
    };
  },
  simulate(card) {
    const story = latestArtifact(card, "story").data.story;
    const acs = story.acceptance_criteria;
    const files = guessFiles(card, story);
    const brief = {
      execution_plan: [
        `梳理受影响区域：${files.join("、")}`,
        ...acs.map((ac) => `实现并自测 ${ac.id}：${ac.text}`),
        "运行项目测试与 lint，确认无回归",
        "小步提交，保持工作区干净",
      ],
      key_files: files,
      dependency_plan: story.dependencies_and_sequencing?.unblock_condition ?? "无外部依赖。",
      risk_notes: [
        acs.some((ac) => isVague(ac.text))
          ? "部分验收标准措辞模糊，Review 阶段可能要求补强证据。"
          : "验收标准均可客观验证，风险低。",
        "严格控制范围，超出 story 的改动另开卡片。",
      ],
    };
    const artifact = {
      lane: "todo",
      specialist: this.name,
      type: "brief",
      content:
        `## Execution Brief\n\n### Execution Plan\n${brief.execution_plan.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
        `### Key Files & Entry Points\n${brief.key_files.map((f) => `- \`${f}\``).join("\n")}\n\n` +
        `### Dependency Plan\n${brief.dependency_plan}\n\n### Risk Notes\n${brief.risk_notes.map((r) => `- ${r}`).join("\n")}`,
      data: { brief },
    };
    return {
      artifact,
      decision: { action: "move", target: "dev", reason: "执行简报就绪，实现可在数分钟内开始。" },
    };
  },
  normalize(raw, card) {
    if (!raw?.brief?.execution_plan?.length) {
      return {
        artifact: { lane: "todo", specialist: this.name, type: "feedback", content: "## Orchestrator Feedback\n\nLLM 简报不合法，留在 Todo。", data: {} },
        decision: { action: "stay", reason: "Brief contract validation failed." },
      };
    }
    const brief = raw.brief;
    return {
      artifact: {
        lane: "todo", specialist: this.name, type: "brief",
        content: `## Execution Brief\n\n### Execution Plan\n${brief.execution_plan.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n### Key Files\n${(brief.key_files ?? []).map((f) => `- \`${f}\``).join("\n")}\n\n### Dependency Plan\n${brief.dependency_plan ?? "-"}\n\n### Risk Notes\n${(brief.risk_notes ?? []).map((r) => `- ${r}`).join("\n")}`,
        data: { brief },
      },
      decision: { action: "move", target: "dev", reason: raw.decision?.reason ?? "Brief ready." },
    };
  },
};

// ── 3. Dev Crafter ──────────────────────────────────────────────────

const devCrafter = {
  id: "dev-crafter",
  name: "Dev Crafter",
  lane: "dev",
  role: "CRAFTER",
  modelTier: "SMART",
  roleReminder:
    "Refuse to code unless the story is executable. Implement only the scoped change, run validation, commit, and append Dev Evidence.",
  systemPrompt: `You sweep the Dev lane.
## Mission
- Re-check the card is executable; if not, route back to todo.
- Implement only the scoped change. No refactors, no scope creep.
- Append Dev Evidence: changed files, work summary, tests run, per-AC verification, caveats.
- Move to review only after the commit exists and the tree is clean.`,
  entryGate(card) {
    if (!latestArtifact(card, "story")) return { rejectTo: "backlog", reason: "无 canonical story，打回 Backlog。" };
    if (!latestArtifact(card, "brief")) return { rejectTo: "todo", reason: "无执行简报，打回 Todo 补齐计划。" };
    return null;
  },
  buildPrompt(card) {
    const story = latestArtifact(card, "story");
    const brief = latestArtifact(card, "brief");
    const lastReview = latestArtifact(card, "review");
    return {
      system: this.systemPrompt,
      user: `Story:\n${storyBlock(story.data.story)}\n\nBrief:\n${brief.content}\n\n${lastReview ? `Previous review findings to fix:\n${lastReview.content}\n\n` : ""}Respond with JSON: {"evidence": {"changed_files": [...], "work_summary": "...", "tests_run": "...", "ac_verification": [{"id": "AC1", "how": "..."}], "caveats": [...]}, "decision": {"action": "move"|"stay", "reason": "..."}}`,
    };
  },
  simulate(card) {
    const story = latestArtifact(card, "story").data.story;
    const brief = latestArtifact(card, "brief").data.brief;
    const priorRejections = artifactsOfType(card, "review").filter((a) => a.data?.verdict === "NOT_APPROVED");
    const isFixPass = priorRejections.length > 0;
    const acs = story.acceptance_criteria;

    // Deterministic "distrust loop" demo: on the FIRST dev pass the last AC of a
    // multi-AC story gets a thin verification, which Review Guard will reject.
    const acVerification = acs.map((ac, i) => {
      const thin = !isFixPass && acs.length >= 2 && i === acs.length - 1;
      return {
        id: ac.id,
        how: thin
          ? "已验证。"
          : `通过针对「${ac.text}」的自动化用例与手工走查验证：输入边界、正常路径与异常路径均符合预期，结果已记录。`,
      };
    });

    const evidence = {
      changed_files: brief.key_files ?? guessFiles(card, story),
      work_summary: isFixPass
        ? `根据 Review 反馈补强实现与证据：为全部 ${acs.length} 条验收标准补齐了可复核的验证记录。`
        : `按执行简报完成「${story.title}」的 scoped 实现，覆盖 ${acs.length} 条验收标准，未触碰范围外代码。`,
      tests_run: "npm test — 全部通过；npm run lint — 无告警。",
      ac_verification: acVerification,
      caveats: isFixPass ? [] : ["如发现证据不足，请在 Review 中指出具体 AC。"],
      committed: true,
      worktree_clean: true,
    };
    const artifact = {
      lane: "dev",
      specialist: this.name,
      type: "evidence",
      content:
        `## Dev Evidence\n\n- **Changed files**: ${evidence.changed_files.map((f) => `\`${f}\``).join(", ")}\n` +
        `- **Work summary**: ${evidence.work_summary}\n- **Tests run**: ${evidence.tests_run}\n` +
        `- **Committed**: yes (worktree clean)\n\n### Per-AC Verification\n${acVerification.map((v) => `- **${v.id}**: ${v.how}`).join("\n")}` +
        (evidence.caveats.length ? `\n\n### Caveats\n${evidence.caveats.map((c) => `- ${c}`).join("\n")}` : ""),
      data: { evidence },
    };
    return {
      artifact,
      decision: { action: "move", target: "review", reason: isFixPass ? "修复完成，重新提交评审。" : "实现已提交且工作区干净，请求评审。" },
    };
  },
  normalize(raw, card) {
    const ev = raw?.evidence;
    if (!ev?.changed_files?.length || !ev?.ac_verification?.length) {
      return {
        artifact: { lane: "dev", specialist: this.name, type: "feedback", content: "## Dev Feedback\n\nLLM 证据不完整，留在 Dev。", data: {} },
        decision: { action: "stay", reason: "Evidence contract validation failed." },
      };
    }
    const evidence = { committed: true, worktree_clean: true, caveats: [], ...ev };
    return {
      artifact: {
        lane: "dev", specialist: this.name, type: "evidence",
        content: `## Dev Evidence\n\n- **Changed files**: ${evidence.changed_files.map((f) => `\`${f}\``).join(", ")}\n- **Work summary**: ${evidence.work_summary}\n- **Tests run**: ${evidence.tests_run}\n\n### Per-AC Verification\n${evidence.ac_verification.map((v) => `- **${v.id}**: ${v.how}`).join("\n")}`,
        data: { evidence },
      },
      decision: { action: "move", target: "review", reason: raw.decision?.reason ?? "Ready for review." },
    };
  },
};

// ── 4. Review Guard ─────────────────────────────────────────────────

const MAX_REVIEW_REJECTIONS = 3; // bounded review loop breaker

const reviewGuard = {
  id: "review-guard",
  name: "Review Guard",
  lane: "review",
  role: "GATE",
  modelTier: "SMART",
  roleReminder:
    "Review is the quality gate. You do NOT trust Dev's self-assessment. Independently verify every claim. Reject aggressively.",
  systemPrompt: `You sweep the Review lane.
## Entry Gate — reject to dev if ANY is missing:
Dev Evidence section, changed files, per-AC verification, test evidence, committed + clean tree.
## Hard rejection criteria:
missing AC verification, no test evidence, scope creep, vague verification wording.
## Verdicts: APPROVED -> done, NOT_APPROVED -> dev, BLOCKED -> blocked.`,
  entryGate(card) {
    const ev = latestArtifact(card, "evidence");
    if (!ev) return { rejectTo: "dev", reason: "No Dev Evidence section. Cannot review without implementation summary." };
    const e = ev.data?.evidence;
    if (!e?.changed_files?.length) return { rejectTo: "dev", reason: "No changed files listed. What was modified?" };
    if (!e?.ac_verification?.length) return { rejectTo: "dev", reason: "AC verification not documented. Verify each AC and document how." };
    if (!e?.tests_run) return { rejectTo: "dev", reason: "No test evidence. Run tests or explain why they were skipped." };
    if (!e?.committed || !e?.worktree_clean) return { rejectTo: "dev", reason: "Implementation not committed / worktree dirty." };
    return null;
  },
  buildPrompt(card) {
    const story = latestArtifact(card, "story");
    const ev = latestArtifact(card, "evidence");
    return {
      system: this.systemPrompt,
      user: `Story ACs:\n${storyBlock(story.data.story)}\n\nDev Evidence:\n${ev.content}\n\nRespond with JSON: {"verdict": "APPROVED"|"NOT_APPROVED"|"BLOCKED", "findings": [{"ac": "AC1", "status": "pass"|"fail", "note": "..."}], "reviewer_notes": "...", "reason": "..."}`,
    };
  },
  simulate(card) {
    const story = latestArtifact(card, "story").data.story;
    const evidence = latestArtifact(card, "evidence").data.evidence;
    const priorRejections = artifactsOfType(card, "review").filter((a) => a.data?.verdict === "NOT_APPROVED").length;
    const fixSinceLastRejection = artifactsOfType(card, "evidence").length > priorRejections;

    const findings = story.acceptance_criteria.map((ac) => {
      const v = evidence.ac_verification.find((x) => x.id === ac.id);
      if (!v) return { ac: ac.id, status: "fail", note: "缺少该 AC 的验证记录。" };
      if (v.how.trim().length < 20) return { ac: ac.id, status: "fail", note: `验证记录过于单薄（“${v.how.trim()}”），不可复核。` };
      if (isVague(ac.text) && !fixSinceLastRejection)
        return { ac: ac.id, status: "fail", note: "验收标准措辞模糊，需要 Dev 补强客观证据。" };
      return { ac: ac.id, status: "pass", note: "验证记录可复核，证据链完整。" };
    });

    const failed = findings.filter((f) => f.status === "fail");
    let verdict, target, reason;
    if (failed.length === 0) {
      verdict = "APPROVED";
      target = "done";
      reason = "全部验收标准独立验证通过。";
    } else if (priorRejections + 1 >= MAX_REVIEW_REJECTIONS) {
      verdict = "BLOCKED";
      target = "blocked";
      reason = `打回次数达到上限（${MAX_REVIEW_REJECTIONS}），转交 Blocked Resolver 诊断根因。`;
    } else {
      verdict = "NOT_APPROVED";
      target = "dev";
      reason = `${failed.length} 条验收标准证据不足，打回 Dev 修复。`;
    }

    const artifact = {
      lane: "review",
      specialist: this.name,
      type: "review",
      content:
        `## Review Findings\n\n- **Verdict**: ${verdict}\n\n### Per-AC Status\n${findings.map((f) => `- **${f.ac}** [${f.status === "pass" ? "✅ pass" : "❌ fail"}]: ${f.note}`).join("\n")}\n\n` +
        `### Reviewer Notes\n独立复核了 Dev Evidence 的全部声明，未采信未经证据支持的结论。${reason}`,
      data: { verdict, findings, reviewer_notes: reason },
    };
    return { artifact, decision: { action: "move", target, verdict, reason } };
  },
  normalize(raw, card) {
    const verdict = raw?.verdict;
    if (!["APPROVED", "NOT_APPROVED", "BLOCKED"].includes(verdict)) {
      return {
        artifact: { lane: "review", specialist: this.name, type: "feedback", content: "## Review Feedback\n\nLLM verdict 不合法，留在 Review。", data: {} },
        decision: { action: "stay", reason: "Review contract validation failed." },
      };
    }
    const findings = raw.findings ?? [];
    const target = verdict === "APPROVED" ? "done" : verdict === "BLOCKED" ? "blocked" : "dev";
    return {
      artifact: {
        lane: "review", specialist: this.name, type: "review",
        content: `## Review Findings\n\n- **Verdict**: ${verdict}\n\n### Per-AC Status\n${findings.map((f) => `- **${f.ac}** [${f.status}]: ${f.note}`).join("\n")}\n\n### Reviewer Notes\n${raw.reviewer_notes ?? "-"}`,
        data: { verdict, findings, reviewer_notes: raw.reviewer_notes ?? "" },
      },
      decision: { action: "move", target, verdict, reason: raw.reason ?? verdict },
    };
  },
};

// ── 5. Done Reporter ────────────────────────────────────────────────

const doneReporter = {
  id: "done-reporter",
  name: "Done Reporter",
  lane: "done",
  role: "GATE",
  modelTier: "BALANCED",
  roleReminder:
    "Done is the terminal lane. Do not move the card further. Leave behind a crisp completion summary.",
  systemPrompt: `You sweep the Done lane.
## Entry gate: card must carry Review Findings with verdict APPROVED, else reject to review.
## Mission: append a short Completion Summary (what shipped, key evidence, completion date). Stay in done.`,
  entryGate(card) {
    const review = latestArtifact(card, "review");
    if (!review) return { rejectTo: "review", reason: "Card reached Done without review findings. Needs review." };
    if (review.data?.verdict !== "APPROVED")
      return { rejectTo: "review", reason: "Card reached Done without approval. Needs review." };
    return null;
  },
  // Done is terminal: once the completion summary exists, never run again.
  shouldRun(card) {
    return !latestArtifact(card, "summary");
  },
  buildPrompt(card) {
    return {
      system: this.systemPrompt,
      user: `Card: ${card.title}\nArtifacts:\n${card.artifacts.map((a) => a.content).join("\n\n")}\n\nRespond with JSON: {"summary": "...", "key_evidence": ["..."], "reason": "..."}`,
    };
  },
  simulate(card) {
    const story = latestArtifact(card, "story")?.data?.story;
    const evidence = latestArtifact(card, "evidence")?.data?.evidence;
    const summary = {
      what_shipped: `「${card.title}」已交付：${story?.acceptance_criteria?.length ?? 0} 条验收标准全部通过独立评审。`,
      key_evidence: [
        `变更文件：${(evidence?.changed_files ?? []).join("、") || "见 Dev Evidence"}`,
        `测试结果：${evidence?.tests_run ?? "见 Dev Evidence"}`,
        "Review verdict: APPROVED",
      ],
      completed_at: new Date().toISOString().slice(0, 10),
    };
    const artifact = {
      lane: "done",
      specialist: this.name,
      type: "summary",
      content: `## Completion Summary\n\n- **What shipped**: ${summary.what_shipped}\n- **Key evidence**:\n${summary.key_evidence.map((e) => `  - ${e}`).join("\n")}\n- **Completed**: ${summary.completed_at}`,
      data: { summary },
    };
    return { artifact, decision: { action: "stay", verdict: "DONE", reason: "Done 是终态泳道，卡片不再移动。" } };
  },
  normalize(raw) {
    const summary = {
      what_shipped: raw?.summary ?? "已完成。",
      key_evidence: raw?.key_evidence ?? [],
      completed_at: new Date().toISOString().slice(0, 10),
    };
    return {
      artifact: {
        lane: "done", specialist: this.name, type: "summary",
        content: `## Completion Summary\n\n- **What shipped**: ${summary.what_shipped}\n- **Key evidence**:\n${summary.key_evidence.map((e) => `  - ${e}`).join("\n")}\n- **Completed**: ${summary.completed_at}`,
        data: { summary },
      },
      decision: { action: "stay", verdict: "DONE", reason: raw?.reason ?? "Terminal lane." },
    };
  },
};

// ── 6. Blocked Resolver ─────────────────────────────────────────────

const blockedResolver = {
  id: "blocked-resolver",
  name: "Blocked Resolver",
  lane: "blocked",
  role: "CRAFTER",
  modelTier: "SMART",
  roleReminder:
    "Blocked is a recovery lane. Clarify the blocker, reduce ambiguity, and only move the card out when a concrete next step exists.",
  systemPrompt: `You sweep the Blocked lane.
## Mission: classify the blocker, write the root cause, and route back only with a concrete next step.
## Append: Blocker Analysis { blocker_type, root_cause, resolution, routing_decision }.
## Never rewrite the original description or the canonical YAML block.`,
  entryGate() {
    return null;
  },
  buildPrompt(card) {
    return {
      system: this.systemPrompt,
      user: `Card: ${card.title}\nBlocked from: ${card.blocked_from ?? "unknown"}\nReview rejections: ${card.review_rejections}\nArtifacts:\n${card.artifacts.map((a) => a.content).join("\n\n")}\n\nRespond with JSON: {"analysis": {"blocker_type": "...", "root_cause": "...", "resolution": "...", "routing_decision": "backlog|todo|dev|review"}, "reason": "..."}`,
    };
  },
  simulate(card) {
    const from = card.blocked_from ?? "review";
    const analysis = {
      blocker_type: card.review_rejections > 0 ? "unclear-requirement" : "other",
      root_cause:
        card.review_rejections > 0
          ? `评审打回 ${card.review_rejections} 次后仍未收敛，说明验收标准的可验证性不足，需要人类或上游重新定义。`
          : "阻塞原因未自动归类，需要人工补充上下文。",
      resolution:
        "已将验收标准重写为客观可验证表述，并重置评审计数，给出具体下一步：回到 Dev 按新证据标准重新实现。",
      routing_decision: from === "blocked" ? "dev" : from,
    };
    const artifact = {
      lane: "blocked",
      specialist: this.name,
      type: "blocker",
      content:
        `## Blocker Analysis\n\n- **Blocker type**: ${analysis.blocker_type}\n- **Root cause**: ${analysis.root_cause}\n` +
        `- **Resolution**: ${analysis.resolution}\n- **Routing decision**: ${analysis.routing_decision}`,
      data: { analysis },
    };
    return {
      artifact,
      decision: {
        action: "move",
        target: LANES.includes(analysis.routing_decision) && analysis.routing_decision !== "blocked" ? analysis.routing_decision : "dev",
        reason: "已有具体下一步，路由回主动流程。",
      },
    };
  },
  normalize(raw) {
    const a = raw?.analysis ?? {};
    const target = LANES.includes(a.routing_decision) && a.routing_decision !== "blocked" ? a.routing_decision : "dev";
    return {
      artifact: {
        lane: "blocked", specialist: this.name, type: "blocker",
        content: `## Blocker Analysis\n\n- **Blocker type**: ${a.blocker_type ?? "other"}\n- **Root cause**: ${a.root_cause ?? "-"}\n- **Resolution**: ${a.resolution ?? "-"}\n- **Routing decision**: ${target}`,
        data: { analysis: a },
      },
      decision: { action: "move", target, reason: raw?.reason ?? "Routed with a concrete next step." },
    };
  },
};

export const SPECIALISTS = {
  backlog: backlogRefiner,
  todo: todoOrchestrator,
  dev: devCrafter,
  review: reviewGuard,
  done: doneReporter,
  blocked: blockedResolver,
};

export function listSpecialists() {
  return Object.values(SPECIALISTS).map((s) => ({
    id: s.id,
    name: s.name,
    lane: s.lane,
    role: s.role,
    modelTier: s.modelTier,
    roleReminder: s.roleReminder,
  }));
}
