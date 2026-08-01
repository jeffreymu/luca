/* LucaPi SPA — board rendering, operations console, drawer and SSE live updates. */
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
  const queryToken=new URLSearchParams(location.search).get("token");if(queryToken){localStorage.setItem("lucapi.apiToken",queryToken);history.replaceState({},"",location.pathname);}
  const authToken=()=>localStorage.getItem("lucapi.apiToken")||"";
  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      headers: { "content-type": "application/json",...(authToken()?{authorization:`Bearer ${authToken()}`}:{}) },
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
    $("#drawer-meta").textContent = `${laneName}${card.branch_name ? ` · ⎇ ${card.branch_name}` : ""} · 创建于 ${new Date(card.created_at).toLocaleString()}`;
    const deliverBtn=$("#deliver-card-btn");
    deliverBtn.classList.toggle("hidden",!card.head_commit);
    deliverBtn.textContent=card.pr_url?"↗ 打开 PR":"↑ Push & PR";
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
            <span class="pill ${s.verdict ?? ""}">${esc(s.verdict ?? s.status)}</span>${s.status==="ACTIVE"?`<button class="btn danger cancel-session" data-id="${s.id}">取消</button>`:""}
          </div>
          <div class="trace-list hidden" id="traces-${s.id}"></div>
        </div>`
        )
        .join("") || `<div class="empty-hint">尚无 session。</div>`;
    list.querySelectorAll(".cancel-session").forEach((button)=>button.addEventListener("click",async(e)=>{e.stopPropagation();await api(`/api/sessions/${button.dataset.id}/cancel`,{method:"POST"});toast("Session 取消请求已发送。");await renderDrawer(card);}));
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

  async function approvedOperation(operation,resourceId){const list=await api(`/api/operation-approvals?workspaceId=${state.workspace.id}`);return list.find((a)=>a.operation===operation&&a.resource_id===resourceId&&a.status==="APPROVED"&&!a.consumed_at)?.id;}
  async function requestOperationApproval(operation,resourceId,payload={}){const approval=await api("/api/operation-approvals",{method:"POST",body:{workspaceId:state.workspace.id,operation,resourceId,payload}});toast(`操作需要审批，已创建请求 ${approval.id.slice(0,8)}。请在 Platform → Operation Approvals 批准。`,7000);return approval;}

  /* ── Actions ── */
  $("#run-board-btn").addEventListener("click", async () => {
    if (!state.board || state.running) return;
    state.running = true;
    const btn = $("#run-board-btn");
    btn.disabled = true;
    btn.textContent = "⏳ 已进入持久化队列…";
    try {
      let job = await api(`/api/boards/${state.board.id}/run`, { method: "POST", body:{async:true} });
      while (["PENDING","RUNNING"].includes(job.status)) {
        await new Promise((r)=>setTimeout(r,500));
        job=await api(`/api/jobs/${job.id}`);
        btn.textContent=`⏳ Automation ${job.status} · attempt ${job.attempts}`;
      }
      if(job.status!=="COMPLETED") throw new Error(job.error||job.status);
      toast("Automation 已由持久化 Worker 完成；服务重启时也可恢复未完成任务。");
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

  $("#deliver-card-btn").addEventListener("click",async()=>{
    const card=state.cards.find((c)=>c.id===state.openCardId);if(!card)return;
    if(card.pr_url){window.open(card.pr_url,"_blank");return;}
    try{const approvalId=await approvedOperation("card.deliver",card.id),r=await api(`/api/cards/${card.id}/deliver`,{method:"POST",body:{title:card.title,body:card.objective,approvalId}});toast(r.pr?`PR #${r.pr.number} 已创建`:r.note);await loadState();}
    catch(err){if(err.message.includes("approved operation"))await requestOperationApproval("card.deliver",card.id,{title:card.title});else toast(`交付失败：${err.message}`,5000);}
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
    // repo_path 默认 = LucaPi 启动目录，可修改
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
          <button class="btn" data-act="test">连通</button>
          <button class="btn" data-act="diagnose">能力诊断</button>
          ${p.isActive ? `<button class="btn" data-act="deactivate">停用</button>` : `<button class="btn" data-act="activate">启用</button>`}
          <button class="btn danger" data-act="delete">删除</button>
        </div>`
        )
        .join("") || `<div class="empty-hint">尚未配置 Provider。也可以直接用环境变量 LUCAPI_LLM_BASE_URL / LUCAPI_LLM_API_KEY / LUCAPI_LLM_MODEL。</div>`;

    list.querySelectorAll(".provider-row").forEach((row) => {
      const id = row.dataset.id;
      row.querySelectorAll("button").forEach((btn) =>
        btn.addEventListener("click", async () => {
          const act = btn.dataset.act;
          try {
            if (act === "test" || act === "diagnose") {
              btn.disabled = true;
              btn.textContent = "测试中…";
              const r = await api(`/api/providers/${id}/${act}`, { method: "POST" });
              const detail=act==="diagnose"?Object.entries(r.checks).map(([name,c])=>`${name}: ${c.ok?"✓":"✗"} ${c.detail}`).join("；"): `${r.detail}（${r.latencyMs}ms）`;
              toast(`${r.ok ? "✅" : "❌"} ${detail}`, 8000);
              btn.disabled = false;
              btn.textContent = act==="diagnose"?"能力诊断":"连通";
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
      for (const k of ["name","baseUrl","model"]) if (!body[k]) throw new Error(`请填写完整：${k}`);
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
    $("#sandbox-mode").value = w.sandboxPolicy?.mode ?? "local";
    $("#sandbox-image").value = w.sandboxPolicy?.image ?? "node:22-alpine";
    $("#sandbox-network").value=String(w.sandboxPolicy?.network===true);
    $("#approval-operations").value=(w.sandboxPolicy?.requireApprovalFor??[]).join(", ");
    $("#validation-commands").value = w.validationCommands?JSON.stringify(w.validationCommands):"";
    if (!w.repoPath) {
      box.innerHTML = `<div class="empty-hint">该 workspace 尚未配置 repo_path。下方已默认填入 LucaPi 启动目录，可直接保存或改为你的仓库路径。</div>`;
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
      const approvalId=await approvedOperation("git.push",state.workspace.id);
      let r;try{r=await api(`/api/workspaces/${state.workspace.id}/git/push`, {method:"POST",body:{message:$("#git-commit-msg").value.trim(),approvalId}});}catch(err){if(err.message.includes("approved operation")){await requestOperationApproval("git.push",state.workspace.id,{message:$("#git-commit-msg").value.trim()});return;}throw err;}
      toast(r.note);
      $("#git-commit-msg").value = "";
    })
  );
  $("#git-pr-btn").addEventListener("click", (e) =>
    gitOp(e.currentTarget, async () => {
      const title = $("#git-pr-title").value.trim();
      if (!title) throw new Error("请填写 PR 标题");
      const approvalId=await approvedOperation("git.pr",state.workspace.id);
      let r;try{r=await api(`/api/workspaces/${state.workspace.id}/git/pr`,{method:"POST",body:{title,body:$("#git-pr-body").value.trim(),base:$("#git-pr-base").value.trim()||"main",approvalId}});}catch(err){if(err.message.includes("approved operation")){await requestOperationApproval("git.pr",state.workspace.id,{title});return;}throw err;}
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
          sandboxPolicy:{...state.workspace.sandboxPolicy,mode:$("#sandbox-mode").value,image:$("#sandbox-image").value.trim()||"node:22-alpine",network:$("#sandbox-network").value==="true",requireApprovalFor:$("#approval-operations").value.split(",").map((v)=>v.trim()).filter(Boolean)},
          validationCommands:$("#validation-commands").value.trim()?JSON.parse($("#validation-commands").value):undefined,
        },
      });
      toast("Git 设置已保存。");
      await loadState();
      await renderGitStatus();
    } catch (err) {
      toast(err.message);
    }
  });

  $("#api-token-btn").addEventListener("click",()=>{const value=prompt("输入 LUCAPI_API_TOKEN（仅保存在当前浏览器；留空清除）",authToken());if(value===null)return;if(value)localStorage.setItem("lucapi.apiToken",value);else localStorage.removeItem("lucapi.apiToken");location.reload();});

  /* ── Platform operations console ── */
  const platformResources={
    jobs:{label:"Jobs",get:()=>`/api/jobs?workspaceId=${state.workspace.id}`,submit:()=>["/api/jobs/process","POST"],actions:(i)=>[{label:"取消",path:`/api/jobs/${i.id}`,method:"DELETE"},{label:"重试",path:`/api/jobs/${i.id}/retry`,method:"POST"}],help:"刷新持久化队列；提交会触发一次 Worker tick。",sample:{}},
    agents:{label:"Agents",get:()=>`/api/agents?workspaceId=${state.workspace.id}`,submit:()=>["/api/agents","POST"],actions:(i)=>[{label:"删除",path:`/api/agents/${i.id}`,method:"DELETE"}],help:"注册真实参与 Team Run 的 Agent；providerId 可选。",sample:{name:"Crafter A",role:"CRAFTER",providerId:null,metadata:{lanes:["dev"]}}},
    teams:{label:"Teams / Approval",get:()=>`/api/team-runs?workspaceId=${state.workspace.id}`,submit:()=>["/api/team-runs","POST"],help:"启动有界并发团队；approvalRequired=true 时必须先在资源卡片中批准。",sample:{goal:"交付当前 Ready Cards",maxConcurrency:2,approvalRequired:true}},
    approvals:{label:"Operation Approvals",get:()=>`/api/operation-approvals?workspaceId=${state.workspace.id}`,submit:()=>["/api/operation-approvals","POST"],actions:(i)=>i.status==="PENDING"?[{label:"批准",path:`/api/operation-approvals/${i.id}`,method:"POST",body:{status:"APPROVED",response:"web operator"}},{label:"拒绝",path:`/api/operation-approvals/${i.id}`,method:"POST",body:{status:"REJECTED",response:"web operator"}}]:[],help:"为 Git Push、PR、交付、删除或 Sandbox 网络请求一次性审批。",sample:{operation:"git.push",resourceId:"",payload:{reason:"release"}}},
    workflows:{label:"Workflows",get:()=>`/api/workflows?workspaceId=${state.workspace.id}`,submit:()=>["/api/workflows","POST"],actions:(i)=>[{label:"触发",path:`/api/workflows/${i.id}/trigger`,method:"POST"},{label:"删除",path:`/api/workflows/${i.id}`,method:"DELETE"}],help:"用 steps 定义任务 DAG。",sample:{name:"Release",definition:{autoRun:true,steps:[{type:"card.create",title:"Release check",objective:"Validate release"}]}}},
    schedules:{label:"Schedules",get:()=>`/api/schedules?workspaceId=${state.workspace.id}`,submit:()=>["/api/schedules","POST"],actions:(i)=>[{label:i.enabled?"暂停":"恢复",path:`/api/schedules/${i.id}`,method:"PATCH",body:{enabled:!i.enabled}},{label:"删除",path:`/api/schedules/${i.id}`,method:"DELETE"}],help:"支持 intervalMinutes 或五段 cronExpression、timezone 和 FORBID/ALLOW/REPLACE。",sample:{workflowId:"",name:"Daily",cronExpression:"0 9 * * 1-5",timezone:"Asia/Shanghai",concurrencyPolicy:"FORBID"}},
    webhooks:{label:"Webhooks",get:()=>`/api/webhooks/configs?workspaceId=${state.workspace.id}`,submit:()=>["/api/webhooks/configs","POST"],actions:(i)=>[{label:"删除",path:"/api/webhooks/configs",method:"DELETE",body:{id:i.id}}],help:"配置 HMAC Webhook；filters 支持 payload 点路径精确匹配。",sample:{workflowId:"",event:"push",secret:"",filters:{ref:"refs/heads/main"}}},
    skills:{label:"Skills",get:()=>`/api/skills?workspaceId=${state.workspace.id}&includeDrafts=true`,submit:()=>["/api/skills/import","POST"],actions:(i)=>[{label:"版本",path:`/api/skills/${i.id}/versions`,method:"GET",show:true},...((i.status==="DRAFT"||i.hasDraft)?[{label:"申请发布",path:`/api/skills/${i.id}/request-publish`,method:"POST",body:{workspaceId:state.workspace.id}},{label:"发布",path:`/api/skills/${i.id}/publish`,method:"POST",body:{workspaceId:state.workspace.id}}]:[]),{label:"删除",path:`/api/skills/${i.id}`,method:"DELETE"}],help:"从 SKILL.md 内容、本地目录或 Git 仓库导入；导入版本先进入 DRAFT。生成 Skill 使用 POST /api/skills/generate。",sample:{source:{type:"content",skillMarkdown:"---\nname: review-skill\nversion: 1.0.0\ndescription: Review changes\n---\n\n1. Read the diff. Completion: every changed file reviewed.\n2. Report findings. Completion: every finding has severity and file."}}},
    skillGenerator:{label:"Generate Skill",get:()=>`/api/skills?workspaceId=${state.workspace.id}&includeDrafts=true`,submit:()=>["/api/skills/generate","POST"],help:"使用当前真实 Provider 从需求描述生成经过 Manifest 校验的 DRAFT。",sample:{prompt:"Review code changes against acceptance criteria and report normalized findings"}},
    builtins:{label:"Built-in Skills",get:()=>`/api/skills?workspaceId=${state.workspace.id}&includeDrafts=true`,submit:()=>["/api/skills/builtins","POST"],help:"安装 code-review、security-scan 和 sonarqube 三个内置 Skill 草稿。",sample:{}},
    profiles:{label:"Scan Profiles",get:()=>`/api/scan-profiles?workspaceId=${state.workspace.id}`,submit:()=>["/api/scan-profiles","POST"],actions:(i)=>[{label:"删除",path:`/api/scan-profiles/${i.id}`,method:"DELETE"}],help:"配置 Review/Manual 扫描器和门禁。CLI 缺失且 failOnScannerError=true 时明确阻断。",sample:{name:"Security Gate",hook:"review",scanners:["lucapi-secret","gitleaks","semgrep","trivy","osv-scanner"],policy:{blockOn:["critical","high"],failOnScannerError:true,newFindingsOnly:true},config:{},enabled:true}},
    scans:{label:"Scan Reports",get:()=>`/api/scans?workspaceId=${state.workspace.id}`,submit:()=>["/api/scans/run","POST"],actions:(i)=>[{label:"详情",path:`/api/scans/${i.id}`,method:"GET",show:true},{label:"重跑",path:"/api/scans/run",method:"POST",body:{profileId:i.profile_id,cardId:i.card_id}},{label:"发布 GitHub",path:`/api/scans/${i.id}/publish-github`,method:"POST",body:{headSha:i.head_commit,name:"LucaPi Scan"},show:true},{label:"SARIF",path:`/api/scans/${i.id}/sarif`,method:"GET",show:true}],help:"将 Profile 作为持久化 Job 执行；可查看 Findings、导出 SARIF 或发布 GitHub Check。",sample:{profileId:"",cardId:null}},
    sarif:{label:"Import SARIF",get:()=>`/api/scans?workspaceId=${state.workspace.id}`,submit:()=>["/api/scans/import-sarif","POST"],help:"导入任意 SARIF 2.1.0 报告并归一化为 LucaPi Findings。",sample:{cardId:null,sarif:{version:"2.1.0",runs:[]}}},
    specialists:{label:"Specialists",get:()=>"/api/specialists",submit:()=>["/api/specialists","PUT"],help:"覆盖泳道名称、Prompt、Provider 和启停状态。",sample:{lane:"review",name:"Security Gate",systemPrompt:"",providerId:null,enabled:true}},
    github:{label:"GitHub",get:()=>`/api/github/overview?workspaceId=${state.workspace.id}`,submit:()=>["/api/github/pr-comment","POST"],help:"浏览开放 Issues/PR，并向 PR 发布评论。",sample:{number:0,body:"Reviewed by LucaPi"}},
    repository:{label:"Repo / Fitness",get:()=>`/api/workspaces/${state.workspace.id}/repository/analyze`,submit:()=>["/api/fitness/analyze","POST"],help:"查看仓库智能分析并生成 Harness/Fitness 评分。",sample:{}},
    mcp:{label:"MCP",get:()=>"/api/mcp/tools",submit:()=>["/api/mcp/tools","POST"],help:"在 Sandbox Policy 下调用 MCP 工具。",sample:{tool:"git_status",arguments:{}}},
    sandboxes:{label:"Sandboxes",get:()=>"/api/sandboxes",submit:()=>["/api/sandboxes","POST"],actions:(i)=>i.ID||i.Names?[{label:"删除",path:`/api/sandboxes/${i.Names||i.ID}`,method:"DELETE"}]:[],help:"创建可选 Docker Sandbox；network 默认关闭。",sample:{image:"node:22-alpine",network:false,memory:"1g"}},
    maintenance:{label:"Maintenance",get:()=>"/api/admin/schema",submit:()=>["/api/worktrees/cleanup","POST"],help:"查看迁移版本；提交可清理已完成任务 Worktree。备份使用 POST /api/admin/backup。",sample:{olderThanDays:7,force:false}},
  };
  let platformTab="jobs";
  const platformBody=(sample)=>({workspaceId:state.workspace?.id,boardId:state.board?.id,...sample});
  function renderPlatformTabs(){const box=$("#platform-tabs");box.innerHTML=Object.entries(platformResources).map(([id,c])=>`<button class="btn ghost ${id===platformTab?"active":""}" data-tab="${id}">${esc(c.label)}</button>`).join("");box.querySelectorAll("button").forEach((b)=>b.addEventListener("click",()=>{platformTab=b.dataset.tab;renderPlatformTabs();loadPlatformResource(true);}));}
  function renderScanFindings(run){const box=$("#platform-findings");box.innerHTML=(run?.findings??[]).map((f)=>`<div class="platform-item"><strong>${esc(f.severity)} · ${esc(f.scanner)}/${esc(f.rule_id)}</strong><div>${esc(f.file??"")}${f.start_line?`:${f.start_line}`:""} — ${esc(f.message)}</div><button class="btn finding-suppress" data-id="${f.id}" data-value="${f.suppressed?"false":"true"}">${f.suppressed?"恢复":"抑制"}</button></div>`).join("");box.querySelectorAll(".finding-suppress").forEach((b)=>b.addEventListener("click",async()=>{await api(`/api/scan-findings/${b.dataset.id}/suppress`,{method:"POST",body:{suppressed:b.dataset.value==="true"}});renderScanFindings(await api(`/api/scans/${run.id}`));}));}
  async function loadPlatformResource(reset=false){const c=platformResources[platformTab];$("#platform-title").textContent=c.label;$("#platform-help").textContent=c.help;if(reset)$("#platform-json").value=JSON.stringify(platformBody(c.sample),null,2);const data=await api(c.get());const rows=Array.isArray(data)?data:Array.isArray(data.containers)?data.containers:Array.isArray(data.tools)?data.tools:[data];$("#platform-list").innerHTML=rows.length?rows.map((item,index)=>`<div class="platform-item"><strong>${esc(item.name||item.title||item.type||item.id||item.Names||String(item)||c.label)}</strong><pre>${esc(JSON.stringify(item,null,2))}</pre>${item.approvals?.filter((a)=>a.status==="PENDING").map((a)=>`<button class="btn primary approval-btn" data-id="${a.id}">批准</button> <button class="btn danger rejection-btn" data-id="${a.id}">拒绝</button>`).join("")||""}${(c.actions?.(item)||[]).map((a,i)=>`<button class="btn resource-action" data-row="${index}" data-action="${i}">${esc(a.label)}</button>`).join(" ")}</div>`).join(""):`<div class="empty-hint">暂无资源</div>`;$("#platform-list").querySelectorAll(".approval-btn,.rejection-btn").forEach((b)=>b.addEventListener("click",async()=>{await api(`/api/approvals/${b.dataset.id}`,{method:"POST",body:{status:b.classList.contains("approval-btn")?"APPROVED":"REJECTED",response:"web operator"}});await loadPlatformResource();}));$("#platform-list").querySelectorAll(".resource-action").forEach((b)=>b.addEventListener("click",async()=>{const action=c.actions(rows[Number(b.dataset.row)])[Number(b.dataset.action)],result=await api(action.path,{method:action.method,body:action.body});if(action.show){$("#platform-result").textContent=JSON.stringify(result,null,2);renderScanFindings(result);}else await loadPlatformResource();}));}
  $("#platform-btn").addEventListener("click",()=>{$("#platform-modal").classList.remove("hidden");renderPlatformTabs();loadPlatformResource(true).catch((e)=>toast(e.message));});
  $("#platform-close").addEventListener("click",()=>$("#platform-modal").classList.add("hidden"));
  $("#platform-refresh").addEventListener("click",()=>loadPlatformResource().catch((e)=>toast(e.message)));
  $("#platform-submit").addEventListener("click",async()=>{try{const c=platformResources[platformTab],[path,method]=c.submit(),body=JSON.parse($("#platform-json").value||"{}");const result=await api(path,{method,body});$("#platform-result").textContent=JSON.stringify(result,null,2);await loadPlatformResource();}catch(e){toast(e.message);}});

  /* ── SSE live updates（使用 Authorization header，不在 URL 泄漏 Token） ── */
  let reloadTimer=null;
  const onPlatformEvent=(event)=>{if(event.type==="hello")return;clearTimeout(reloadTimer);reloadTimer=setTimeout(()=>loadState(),250);};
  async function connectEvents(){
    while(true){
      try{
        const response=await fetch("/api/events",{headers:authToken()?{authorization:`Bearer ${authToken()}`}:{}});if(!response.ok)throw new Error(`SSE HTTP ${response.status}`);
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="";
        while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let split;while((split=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,split);buffer=buffer.slice(split+2);const data=frame.split("\n").find((line)=>line.startsWith("data: "))?.slice(6);if(data)onPlatformEvent(JSON.parse(data));}}
      }catch{await new Promise((r)=>setTimeout(r,2000));}
    }
  }
  void connectEvents();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  loadState();
})();
