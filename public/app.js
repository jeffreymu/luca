/* Luca SPA — board rendering, drawer, SSE live updates. */
(() => {
  const state = {
    workspaces: [],
    workspace: null,
    board: null,
    cards: [],
    lanes: [],
    sessions: [],
    provider: null,
    serverCwd: null,
    openCardId: null,
    running: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      headers: { "content-type": "application/json" },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  };

  function toast(msg, ms = 3200) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), ms);
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ── Loading state ── */
  async function loadState(keepDrawer = true) {
    const params = state.workspace ? `?workspaceId=${state.workspace.id}` : "";
    const data = await api(`/api/state${params}`);
    Object.assign(state, data);
    renderTopbar();
    renderBoard();
    if (state.openCardId && keepDrawer) {
      const card = state.cards.find((c) => c.id === state.openCardId);
      if (card) await renderDrawer(card);
      else closeDrawer();
    }
  }

  /* ── Topbar ── */
  function renderTopbar() {
    const sel = $("#workspace-select");
    sel.innerHTML = state.workspaces
      .map((w) => `<option value="${w.id}" ${w.id === state.workspace?.id ? "selected" : ""}>${esc(w.name)}</option>`)
      .join("");
    // Providers 按钮同时承担状态展示：llm 模式绿点 + 当前 provider 名
    const pBtn = $("#providers-btn");
    if (state.provider?.mode === "llm") {
      pBtn.innerHTML = `⚙ ${esc(state.provider.name)}`;
      pBtn.style.borderColor = "var(--green)";
      pBtn.style.color = "var(--green)";
    } else {
      pBtn.innerHTML = "⚙ Providers";
      pBtn.style.borderColor = "";
      pBtn.style.color = "";
    }
  }

  /* ── Board ── */
  function renderBoard() {
    const board = $("#board");
    if (!state.board) {
      board.innerHTML = `<div class="empty-hint" style="margin:auto">还没有 Workspace。点击右上角「+ Workspace」开始。</div>`;
      return;
    }
    board.innerHTML = state.lanes
      .map((lane) => {
        const cards = state.cards.filter((c) => c.column_id === lane.id);
        return `
        <section class="column lane-accent-${lane.id}">
          <div class="column-head">
            <div>
              <div class="lane-name">${esc(lane.name)}</div>
              <div class="specialist">◈ ${esc(lane.specialist)}</div>
            </div>
            <span class="count">${cards.length}</span>
          </div>
          <div class="column-body">
            ${cards.map(renderCard).join("") || `<div class="empty-hint">空</div>`}
          </div>
          ${lane.id === "backlog" ? `<button class="btn ghost add-card-btn" data-lane="${lane.id}">+ 新建卡片</button>` : ""}
        </section>`;
      })
      .join("");

    board.querySelectorAll(".card").forEach((el) =>
      el.addEventListener("click", () => openDrawer(el.dataset.cardId))
    );
    board.querySelectorAll(".add-card-btn").forEach((el) =>
      el.addEventListener("click", () => $("#card-modal").classList.remove("hidden"))
    );
  }

  function renderCard(card) {
    const artifactTypes = [...new Set(card.artifacts.map((a) => a.type))];
    return `
      <div class="card" data-card-id="${card.id}">
        <div class="card-title">${esc(card.title)}</div>
        <div class="card-foot">
          ${card.verdict ? `<span class="pill ${card.verdict}">${card.verdict}</span>` : ""}
          ${card.review_rejections ? `<span class="pill">打回 ×${card.review_rejections}</span>` : ""}
          ${artifactTypes.map((t) => `<span class="pill">${esc(t)}</span>`).join("")}
        </div>
      </div>`;
  }

  /* ── Drawer ── */
  async function openDrawer(cardId) {
    state.openCardId = cardId;
    const card = state.cards.find((c) => c.id === cardId);
    if (!card) return;
    $("#drawer").classList.remove("hidden");
    $("#drawer-overlay").classList.remove("hidden");
    await renderDrawer(card);
  }

  function closeDrawer() {
    state.openCardId = null;
    $("#drawer").classList.add("hidden");
    $("#drawer-overlay").classList.add("hidden");
  }

  async function renderDrawer(card) {
    $("#drawer-title").textContent = card.title;
    const laneName = state.lanes.find((l) => l.id === card.column_id)?.name ?? card.column_id;
    $("#drawer-meta").textContent = `${laneName} · 创建于 ${new Date(card.created_at).toLocaleString()}`;
    $("#drawer-objective").textContent = card.objective || "（无目标描述）";
    $("#move-select").innerHTML =
      `<option value="">移动到…</option>` +
      state.lanes.map((l) => `<option value="${l.id}" ${l.id === card.column_id ? "disabled" : ""}>${esc(l.name)}</option>`).join("");
    $("#run-card-btn").textContent = `▶ 运行 ${card.column_id} 泳道 Specialist`;

    const timeline = $("#artifact-timeline");
    timeline.innerHTML =
      card.artifacts
        .map(
          (a, i) => `
        <div class="artifact type-${a.type}">
          <div class="artifact-head" data-artifact="${i}">
            <span><span class="type">${esc(a.type)}</span> · ${esc(a.specialist)} · ${esc(a.lane)}</span>
            <span class="muted">${new Date(a.createdAt).toLocaleTimeString()}</span>
          </div>
          <div class="artifact-body hidden">${esc(a.content)}</div>
        </div>`
        )
        .join("") || `<div class="empty-hint">尚无工件。运行 Backlog Refiner 开始精炼。</div>`;
    timeline.querySelectorAll(".artifact-head").forEach((el) =>
      el.addEventListener("click", () => el.nextElementSibling.classList.toggle("hidden"))
    );

    const sessions = await api(`/api/cards/${card.id}/sessions`);
    const list = $("#session-list");
    list.innerHTML =
      sessions
        .map(
          (s) => `
        <div class="session">
          <div class="session-head" data-session="${s.id}">
            <span>◈ ${esc(s.specialist_name)} <span class="muted">· ${esc(s.lane)} · ${esc(s.provider)}</span></span>
            <span class="pill ${s.verdict ?? ""}">${esc(s.verdict ?? s.status)}</span>
          </div>
          <div class="trace-list hidden" id="traces-${s.id}"></div>
        </div>`
        )
        .join("") || `<div class="empty-hint">尚无 session。</div>`;
    list.querySelectorAll(".session-head").forEach((el) =>
      el.addEventListener("click", async () => {
        const box = el.nextElementSibling;
        if (box.classList.contains("hidden")) {
          const { traces } = await api(`/api/sessions/${el.dataset.session}`);
          box.innerHTML = traces
            .map(
              (t) => `<div class="trace k-${t.kind}"><span class="kind">${esc(t.kind)}</span><span>${esc(t.message)}</span></div>`
            )
            .join("");
        }
        box.classList.toggle("hidden");
      })
    );
  }

  /* ── Actions ── */
  $("#run-board-btn").addEventListener("click", async () => {
    if (!state.board || state.running) return;
    state.running = true;
    const btn = $("#run-board-btn");
    btn.disabled = true;
    btn.textContent = "⏳ Automation 运行中…";
    try {
      const result = await api(`/api/boards/${state.board.id}/run`, { method: "POST" });
      toast(`Automation 完成：${result.sweeps} 轮 sweep，${result.runs} 次 specialist 运行，${result.moves} 次移动。`);
    } catch (err) {
      toast(`Automation 失败：${err.message}`);
    } finally {
      state.running = false;
      btn.disabled = false;
      btn.textContent = "▶ Run Board Automation";
      await loadState();
    }
  });

  $("#run-card-btn").addEventListener("click", async () => {
    if (!state.openCardId) return;
    try {
      const result = await api(`/api/cards/${state.openCardId}/run`, { method: "POST" });
      toast(result.decision?.reason ?? "已运行。");
      await loadState();
    } catch (err) {
      toast(`运行失败：${err.message}`);
    }
  });

  $("#move-select").addEventListener("change", async (e) => {
    if (!e.target.value || !state.openCardId) return;
    await api(`/api/cards/${state.openCardId}/move`, { method: "POST", body: { column: e.target.value } });
    await loadState();
  });

  $("#delete-card-btn").addEventListener("click", async () => {
    if (!state.openCardId || !confirm("确认删除该卡片及其全部 session/trace？")) return;
    await api(`/api/cards/${state.openCardId}`, { method: "DELETE" });
    closeDrawer();
    await loadState();
  });

  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-overlay").addEventListener("click", closeDrawer);

  $("#workspace-select").addEventListener("change", async (e) => {
    state.workspace = { id: e.target.value };
    closeDrawer();
    await loadState();
  });

  /* ── Modals ── */
  const bindModal = (modalSel, cancelSel, createSel, onCreate) => {
    $(cancelSel).addEventListener("click", () => $(modalSel).classList.add("hidden"));
    $(createSel).addEventListener("click", async () => {
      try {
        await onCreate();
        $(modalSel).classList.add("hidden");
      } catch (err) {
        toast(err.message);
      }
    });
  };

  $("#new-workspace-btn").addEventListener("click", () => {
    // repo_path 默认 = Luca 启动目录，可修改
    $("#ws-repo-input").value = state.serverCwd ?? "";
    $("#ws-modal").classList.remove("hidden");
  });
  bindModal("#ws-modal", "#ws-modal-cancel", "#ws-modal-create", async () => {
    const name = $("#ws-name-input").value.trim();
    if (!name) throw new Error("请填写 workspace 名称");
    await api("/api/workspaces", { method: "POST", body: { name, repoPath: $("#ws-repo-input").value.trim() } });
    $("#ws-name-input").value = "";
    state.workspace = null;
    await loadState();
  });
  bindModal("#card-modal", "#card-modal-cancel", "#card-modal-create", async () => {
    const title = $("#card-title-input").value.trim();
    if (!title) throw new Error("请填写卡片标题");
    await api(`/api/boards/${state.board.id}/cards`, {
      method: "POST",
      body: { title, objective: $("#card-objective-input").value.trim() },
    });
    $("#card-title-input").value = "";
    $("#card-objective-input").value = "";
    await loadState();
  });

  /* ── Providers modal ── */
  async function renderProvidersModal() {
    const data = await api("/api/providers");
    const cur = data.current;
    $("#provider-current").textContent =
      cur.mode === "llm"
        ? `当前生效：${cur.name}（来源：${cur.source === "db" ? "下方配置" : "环境变量"}）`
        : "当前生效：simulated provider（离线确定性模式，配置并启用一个 Provider 即可接入真实大模型）";
    const list = $("#provider-list");
    list.innerHTML =
      data.providers
        .map(
          (p) => `
        <div class="provider-row ${p.isActive ? "active" : ""}" data-id="${p.id}">
          <span class="dot"></span>
          <div class="info">
            <div class="pname">${esc(p.name)} <span class="muted">${esc(p.model)}</span></div>
            <div class="pmeta">${esc(p.baseUrl)} · key: ${esc(p.apiKeyMasked)}</div>
          </div>
          <button class="btn" data-act="test">测试</button>
          ${p.isActive ? `<button class="btn" data-act="deactivate">停用</button>` : `<button class="btn" data-act="activate">启用</button>`}
          <button class="btn danger" data-act="delete">删除</button>
        </div>`
        )
        .join("") || `<div class="empty-hint">尚未配置 Provider。也可以直接用环境变量 LUCA_LLM_BASE_URL / LUCA_LLM_API_KEY / LUCA_LLM_MODEL。</div>`;

    list.querySelectorAll(".provider-row").forEach((row) => {
      const id = row.dataset.id;
      row.querySelectorAll("button").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const act = btn.dataset.act;
          try {
            if (act === "test") {
              btn.disabled = true;
              btn.textContent = "测试中…";
              const r = await api(`/api/providers/${id}/test`, { method: "POST" });
              toast(`${r.ok ? "✅" : "❌"} ${r.detail}（${r.latencyMs}ms）`, 5000);
              btn.disabled = false;
              btn.textContent = "测试";
              return;
            }
            if (act === "activate") await api(`/api/providers/${id}/activate`, { method: "POST" });
            if (act === "deactivate") await api(`/api/providers/deactivate`, { method: "POST" });
            if (act === "delete" && confirm("确认删除该 Provider？")) await api(`/api/providers/${id}`, { method: "DELETE" });
            await renderProvidersModal();
            await loadState();
          } catch (err) {
            toast(err.message);
          }
        })
      );
    });
  }

  const openProviders = () => {
    $("#providers-modal").classList.remove("hidden");
    renderProvidersModal().catch((e) => toast(e.message));
  };
  $("#providers-btn").addEventListener("click", openProviders);
  $("#providers-close").addEventListener("click", () => $("#providers-modal").classList.add("hidden"));
  $("#prov-add").addEventListener("click", async () => {
    try {
      const body = {
        name: $("#prov-name").value.trim(),
        baseUrl: $("#prov-base").value.trim(),
        apiKey: $("#prov-key").value.trim(),
        model: $("#prov-model").value.trim(),
        setActive: true,
      };
      for (const [k, v] of Object.entries(body)) if (!v) throw new Error(`请填写完整：${k}`);
      await api("/api/providers", { method: "POST", body });
      ["#prov-name", "#prov-base", "#prov-key", "#prov-model"].forEach((s) => ($(s).value = ""));
      toast("Provider 已添加并启用。后续 specialist 运行将使用真实大模型。");
      await renderProvidersModal();
      await loadState();
    } catch (err) {
      toast(err.message);
    }
  });

  /* ── Git modal ── */
  const defaultRepoPath = () => state.serverCwd ?? "";

  async function renderGitStatus() {
    const box = $("#git-status-box");
    const w = state.workspace;
    if (!w) {
      box.innerHTML = `<div class="empty-hint">请先创建 workspace。</div>`;
      return;
    }
    $("#git-repo-path").value = w.repoPath ?? defaultRepoPath();
    $("#github-token").value = "";
    $("#github-token").placeholder = w.github?.hasToken ? `已保存（${w.github.tokenMasked}），留空保持不变` : "ghp_...";
    $("#github-repo").value = w.github?.repo ?? "";
    $("#github-api-base").value = w.github?.apiBase ?? "";
    if (!w.repoPath) {
      box.innerHTML = `<div class="empty-hint">该 workspace 尚未配置 repo_path。下方已默认填入 Luca 启动目录，可直接保存或改为你的仓库路径。</div>`;
      return;
    }
    box.innerHTML = `<div class="empty-hint">加载中…</div>`;
    try {
      const s = await api(`/api/workspaces/${w.id}/git/status`);
      box.innerHTML = `
        <div class="provider-row">
          <div class="info">
            <div class="pname">⎇ ${esc(s.branch)} ${s.upstream ? `<span class="muted">→ ${esc(s.upstream)}</span>` : ""}
              ${s.ahead ? `<span class="pill">ahead ${s.ahead}</span>` : ""}
              ${s.behind ? `<span class="pill NOT_APPROVED">behind ${s.behind}</span>` : ""}
              ${s.clean ? `<span class="pill APPROVED">clean</span>` : `<span class="pill">${s.changes.length} 个变更</span>`}
            </div>
            <div class="pmeta">${esc(s.repoPath)}${s.repoSlug ? ` · GitHub: ${esc(s.repoSlug)}` : ""}${s.lastCommit ? ` · 最后提交 ${esc(s.lastCommit.hash)} ${esc(s.lastCommit.subject)}（${esc(s.lastCommit.when)}）` : ""}</div>
          </div>
          <button class="btn" id="git-refresh">刷新</button>
        </div>
        ${s.changes.length ? `<div class="git-changes">${s.changes.map((c) => `<div class="trace"><span class="kind">${esc(c.xy.trim() || "??")}</span><span>${esc(c.path)}</span></div>`).join("")}</div>` : ""}`;
      $("#git-refresh").addEventListener("click", renderGitStatus);
    } catch (err) {
      box.innerHTML = `<div class="empty-hint">❌ ${esc(err.message)}</div>`;
    }
  }

  const gitOp = async (btn, fn) => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳ 执行中…";
    try {
      await fn();
    } catch (err) {
      toast(`❌ ${err.message}`, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      await renderGitStatus();
    }
  };

  $("#git-btn").addEventListener("click", () => {
    $("#git-modal").classList.remove("hidden");
    renderGitStatus();
  });
  $("#git-close").addEventListener("click", () => $("#git-modal").classList.add("hidden"));

  $("#git-pull-btn").addEventListener("click", (e) =>
    gitOp(e.currentTarget, async () => {
      const r = await api(`/api/workspaces/${state.workspace.id}/git/pull`, { method: "POST", body: {} });
      toast(`Pull 完成：${r.output.split("\n")[0]}`);
    })
  );
  $("#git-pull-rebase-btn").addEventListener("click", (e) =>
    gitOp(e.currentTarget, async () => {
      const r = await api(`/api/workspaces/${state.workspace.id}/git/pull`, { method: "POST", body: { rebase: true } });
      toast(`Pull --rebase 完成：${r.output.split("\n")[0]}`);
    })
  );
  $("#git-push-btn").addEventListener("click", (e) =>
    gitOp(e.currentTarget, async () => {
      const r = await api(`/api/workspaces/${state.workspace.id}/git/push`, {
        method: "POST",
        body: { message: $("#git-commit-msg").value.trim() },
      });
      toast(r.note);
      $("#git-commit-msg").value = "";
    })
  );
  $("#git-pr-btn").addEventListener("click", (e) =>
    gitOp(e.currentTarget, async () => {
      const title = $("#git-pr-title").value.trim();
      if (!title) throw new Error("请填写 PR 标题");
      const r = await api(`/api/workspaces/${state.workspace.id}/git/pr`, {
        method: "POST",
        body: {
          title,
          body: $("#git-pr-body").value.trim(),
          base: $("#git-pr-base").value.trim() || "main",
        },
      });
      $("#git-pr-result").innerHTML = `${r.existed ? "已存在同分支 PR" : "PR 已创建"}：<a href="${esc(r.url)}" target="_blank" style="color:var(--accent)">#${r.number} ${esc(r.url)}</a>`;
      toast(`${r.existed ? "已存在 PR" : "PR 创建成功"}：#${r.number}`);
    })
  );
  $("#git-save-settings").addEventListener("click", async () => {
    try {
      await api(`/api/workspaces/${state.workspace.id}`, {
        method: "PATCH",
        body: {
          repoPath: $("#git-repo-path").value.trim(),
          githubToken: $("#github-token").value.trim(),
          githubRepo: $("#github-repo").value.trim(),
          githubApiBase: $("#github-api-base").value.trim(),
        },
      });
      toast("Git 设置已保存。");
      await loadState();
      await renderGitStatus();
    } catch (err) {
      toast(err.message);
    }
  });

  /* ── SSE live updates ── */
  const es = new EventSource("/api/events");
  let reloadTimer = null;
  es.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "hello") return;
    // Debounce reloads during automation sweeps.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => loadState(), 250);
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  loadState();
})();
