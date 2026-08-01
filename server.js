/**
 * LucaPi HTTP server — zero-dependency REST + SSE + static SPA.
 *
 * Exports createServer() for tests; listens only when run directly.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, Store } from "./src/db.js";
import { Engine } from "./src/engine.js";
import { RealExecutionService } from "./src/real-execution.js";
import { DurableWorker } from "./src/job-worker.js";
import { handlePlatformApi } from "./src/platform-api.js";
import { gitStatus, gitPull, gitPush } from "./src/git.js";
import { parseGitHubSlug, createPullRequest } from "./src/github.js";
import {
  resolveProvider,
  providerFromRow,
  maskApiKey,
  testProvider,
  diagnoseProvider,
  SimulatedProvider,
} from "./src/providers.js";
import { LANES, LANE_META, listSpecialists } from "./src/specialists.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
};

export function createApp({ dbPath = "lucapi.db", apiToken = process.env.LUCAPI_API_TOKEN, startWorker = true } = {}) {
  const store = new Store(openDb(dbPath));
  const sseClients = new Set();
  const broadcast = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) res.write(payload);
  };
  const engine = new Engine(store, (providerId = null) => {
    const active = providerId ? store.getProvider(providerId) : store.getActiveProvider();
    if (active) {
      return { primary: providerFromRow(active), fallback: new SimulatedProvider(), mode: "llm", source: "db" };
    }
    return resolveProvider(); // env vars, else simulated
  }, broadcast, new RealExecutionService(store));
  const worker = new DurableWorker({ store, engine, broadcast });
  if(startWorker) worker.start();

  const providerInfo = () => {
    const p = engine.getProviders();
    if (p.mode === "llm") return { mode: "llm", name: p.primary.name, source: p.source };
    return { mode: "simulated", name: "simulated", source: "simulated" };
  };

  /** Never leak the raw GitHub token through the API. */
  const serializeWorkspace = (w) =>
    w && {
      id: w.id,
      name: w.name,
      repoPath: w.repo_path,
      createdAt: w.created_at,
      validationCommands: (()=>{try{return JSON.parse(w.validation_commands||"null");}catch{return null;}})(),
      sandboxPolicy: (()=>{try{return JSON.parse(w.sandbox_policy||"{}");}catch{return {};}})(),
      github: {
        hasToken: Boolean(w.github_token),
        tokenMasked: w.github_token ? maskApiKey(w.github_token) : null,
        repo: w.github_repo ?? null,
        apiBase: w.github_api_base ?? null,
      },
    };

  const approvalRequired=(workspace,operation)=>{try{return JSON.parse(workspace?.sandbox_policy||"{}").requireApprovalFor?.includes(operation);}catch{return false;}};
  const authorizeOperation=(workspace,operation,resourceId,approvalId)=>!approvalRequired(workspace,operation)||store.consumeOperationApproval(approvalId,operation,resourceId);

  const requireWorkspaceRepo = (res, workspaceId) => {
    const w = store.getWorkspace(workspaceId);
    if (!w) {
      notFound(res);
      return null;
    }
    if (!w.repo_path) {
      badRequest(res, "该 workspace 未配置 repo_path，请先在 Git 面板中设置本地仓库路径。");
      return null;
    }
    return w;
  };

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  const notFound = (res) => json(res, 404, { error: "Not found" });
  const badRequest = (res, msg) => json(res, 400, { error: msg });

  async function readBody(req) {
    let raw = "";
    for await (const chunk of req) { raw += chunk;if(Buffer.byteLength(raw)>1_048_576)throw new Error("Request body exceeds 1 MiB"); }
    req.rawBody = raw;
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Invalid JSON body");
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;

    try {
      const webhookDelivery=method==="POST"&&/^\/api\/webhooks\/[^/]+$/.test(path)&&path!=="/api/webhooks/configs";
      if(apiToken&&path.startsWith("/api/")&&path!=="/api/health"&&!webhookDelivery){
        const supplied=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"")||"",suppliedBytes=Buffer.from(supplied),expectedBytes=Buffer.from(String(apiToken));
        const valid=suppliedBytes.length===expectedBytes.length&&timingSafeEqual(suppliedBytes,expectedBytes);
        if(!valid)return json(res,401,{error:"Unauthorized"});
      }
      // ── SSE ────────────────────────────────────────────────────
      if (path === "/api/events" && method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      }

      // ── API ────────────────────────────────────────────────────
      if (path === "/api/health" && method === "GET") {
        return json(res, 200, { ok: true, database: "sqlite", worker: worker.metrics(), jobs: { pending: store.listJobs({status:"PENDING"}).length, running: store.listJobs({status:"RUNNING"}).length, failed: store.listJobs({status:"FAILED"}).length }, now: new Date().toISOString() });
      }
      if (path === "/api/state" && method === "GET") {
        const workspaces = store.listWorkspaces();
        let workspaceId = url.searchParams.get("workspaceId") ?? workspaces[0]?.id;
        let workspace = workspaceId ? store.getWorkspace(workspaceId) : null;
        if (!workspace && workspaces.length) {
          workspace = workspaces[0];
          workspaceId = workspace.id;
        }
        const board = workspace ? store.getBoardByWorkspace(workspace.id) : null;
        const cards = board ? store.listCards(board.id) : [];
        const sessions = board ? store.listSessionsForBoard(board.id, 30) : [];
        return json(res, 200, {
          workspaces: workspaces.map(serializeWorkspace),
          workspace: serializeWorkspace(workspace),
          serverCwd: process.cwd(),
          board,
          cards,
          sessions,
          lanes: LANES.map((id) => ({ id, ...LANE_META[id] })),
          specialists: listSpecialists(),
          provider: providerInfo(),
        });
      }

      // ── Extended platform APIs: durable jobs, workflows, skills, MCP, repository intelligence ──
      if (await handlePlatformApi({ req, res, url, store, engine, worker, json, badRequest, notFound, readBody, broadcast })) return;

      // ── Provider management ────────────────────────────────────
      if (path === "/api/providers" && method === "GET") {
        return json(res, 200, {
          current: providerInfo(),
          providers: store.listProviders().map((p) => ({
            id: p.id,
            name: p.name,
            baseUrl: p.base_url,
            model: p.model,
            apiKeyMasked: maskApiKey(p.api_key),
            isActive: p.is_active === 1,
            createdAt: p.created_at,
          })),
        });
      }

      if (path === "/api/providers" && method === "POST") {
        const body = await readBody(req);
        for (const field of ["name", "baseUrl", "model"]) {
          if (!body[field]?.trim?.()) return badRequest(res, `${field} is required`);
        }
        const row = store.createProvider({
          name: body.name.trim(),
          baseUrl: body.baseUrl.trim(),
          apiKey: body.apiKey?.trim() ?? "",
          model: body.model.trim(),
          setActive: body.setActive === true,
        });
        broadcast({ type: "provider" });
        return json(res, 201, { id: row.id, isActive: row.is_active === 1 });
      }

      if (path === "/api/providers/deactivate" && method === "POST") {
        store.setActiveProvider(null); // fall back to env vars, else simulated
        broadcast({ type: "provider" });
        return json(res, 200, { ok: true, current: providerInfo() });
      }

      const providerMatch = path.match(/^\/api\/providers\/([^/]+)$/);
      if (providerMatch) {
        const row = store.getProvider(providerMatch[1]);
        if (!row) return notFound(res);
        if (method === "PATCH") {
          const body = await readBody(req);
          const updated = store.updateProvider(row.id, {
            name: body.name?.trim() || undefined,
            baseUrl: body.baseUrl?.trim() || undefined,
            model: body.model?.trim() || undefined,
            // empty apiKey means "keep the stored one"
            apiKey: body.apiKey?.trim() || undefined,
          });
          broadcast({ type: "provider" });
          return json(res, 200, { id: updated.id });
        }
        if (method === "DELETE") {
          store.deleteProvider(row.id);
          broadcast({ type: "provider" });
          return json(res, 200, { ok: true });
        }
      }

      const providerActivateMatch = path.match(/^\/api\/providers\/([^/]+)\/activate$/);
      if (providerActivateMatch && method === "POST") {
        if (!store.getProvider(providerActivateMatch[1])) return notFound(res);
        store.setActiveProvider(providerActivateMatch[1]);
        broadcast({ type: "provider" });
        return json(res, 200, { ok: true, current: providerInfo() });
      }

      const providerTestMatch = path.match(/^\/api\/providers\/([^/]+)\/(test|diagnose)$/);
      if (providerTestMatch && method === "POST") {
        const row = store.getProvider(providerTestMatch[1]);
        if (!row) return notFound(res);
        const provider=providerFromRow(row);
        const result = providerTestMatch[2] === "diagnose" ? await diagnoseProvider(provider) : await testProvider(provider);
        return json(res, 200, result);
      }

      if (path === "/api/workspaces" && method === "POST") {
        const body = await readBody(req);
        if (!body.name?.trim()) return badRequest(res, "name is required");
        const result = store.createWorkspace({
          name: body.name.trim(),
          // default: the directory LucaPi was started from; editable later via PATCH / Git panel
          repoPath: body.repoPath?.trim() || process.cwd(),
        });
        broadcast({ type: "workspace" });
        return json(res, 201, result);
      }

      const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
      if (wsMatch && method === "DELETE") {
        const workspace=store.getWorkspace(wsMatch[1]),board=store.getBoardByWorkspace(wsMatch[1]);
        if(workspace&&board)for(const card of store.listCards(board.id).filter((c)=>c.worktree_path))await new RealExecutionService(store).worktrees.remove(workspace.repo_path,card.worktree_path,{force:true}).catch(()=>{});
        store.deleteWorkspace(wsMatch[1]);
        broadcast({ type: "workspace" });
        return json(res, 200, { ok: true });
      }
      if (wsMatch && method === "PATCH") {
        const body = await readBody(req);
        const updated = store.updateWorkspace(wsMatch[1], {
          name: body.name?.trim() || undefined,
          repoPath: body.repoPath !== undefined ? String(body.repoPath).trim() || null : undefined,
          githubToken: body.githubToken?.trim() || undefined,
          githubRepo: body.githubRepo !== undefined ? String(body.githubRepo).trim() || null : undefined,
          githubApiBase: body.githubApiBase !== undefined ? String(body.githubApiBase).trim() || null : undefined,
          validationCommands: body.validationCommands,
          sandboxPolicy: body.sandboxPolicy,
        });
        if (!updated) return notFound(res);
        broadcast({ type: "workspace" });
        return json(res, 200, serializeWorkspace(updated));
      }

      // ── Git operations on the workspace worktree ─────────────────
      const gitMatch = path.match(/^\/api\/workspaces\/([^/]+)\/git\/([a-z]+)$/);
      if (gitMatch) {
        const [, workspaceId, op] = gitMatch;
        const w = requireWorkspaceRepo(res, workspaceId);
        if (!w) return;

        try {
          if (op === "status" && method === "GET") {
            const status = await gitStatus(w.repo_path);
            return json(res, 200, {
              ...status,
              repoSlug: w.github_repo ?? parseGitHubSlug(status.remoteUrl),
            });
          }

          if (op === "pull" && method === "POST") {
            const body = await readBody(req);
            const result = await gitPull(w.repo_path, { rebase: body.rebase === true });
            return json(res, 200, result);
          }

          if (op === "push" && method === "POST") {
            const body = await readBody(req);
            if(!authorizeOperation(w,"git.push",workspaceId,body.approvalId))return json(res,403,{error:"approved operation approval required"});
            const result = await gitPush(w.repo_path, { message: body.message });
            broadcast({ type: "git", workspaceId });
            return json(res, 200, result);
          }

          if (op === "pr" && method === "POST") {
            const body = await readBody(req);
            if(!authorizeOperation(w,"git.pr",workspaceId,body.approvalId))return json(res,403,{error:"approved operation approval required"});
            const token = w.github_token ?? process.env.GITHUB_TOKEN;
            if (!token) return badRequest(res, "未配置 GitHub token：请在 Git 面板中保存 token，或设置 GITHUB_TOKEN 环境变量。");
            const status = await gitStatus(w.repo_path);
            const slug = w.github_repo ?? parseGitHubSlug(status.remoteUrl);
            if (!slug) return badRequest(res, "无法从 origin 推断 GitHub 仓库（owner/repo），请在 Git 面板中手动填写。");
            const head = body.head?.trim() || status.branch;
            const base = body.base?.trim() || "main";
            if (!body.title?.trim()) return badRequest(res, "title is required");
            const pr = await createPullRequest({
              apiBase: w.github_api_base ?? process.env.LUCAPI_GITHUB_API ?? process.env.LUCA_GITHUB_API ?? "https://api.github.com",
              token,
              slug,
              title: body.title.trim(),
              body: body.body ?? "",
              head,
              base,
            });
            return json(res, pr.existed ? 200 : 201, { ...pr, slug, head, base });
          }

          return notFound(res);
        } catch (err) {
          // git CLI failures (not a repo, no remote, diverged...) -> readable 400
          return badRequest(res, err.message);
        }
      }

      const boardCardsMatch = path.match(/^\/api\/boards\/([^/]+)\/cards$/);
      if (boardCardsMatch && method === "POST") {
        const body = await readBody(req);
        if (!body.title?.trim()) return badRequest(res, "title is required");
        const card = store.createCard({
          boardId: boardCardsMatch[1],
          title: body.title.trim(),
          objective: body.objective ?? "",
          parentId: body.parentId ?? null,
          dependencies: body.dependencies ?? [],
          priority: body.priority ?? 0,
          assignee: body.assignee ?? null,
          tags: body.tags ?? [],
        });
        broadcast({ type: "card", cardId: card.id, boardId: card.board_id });
        return json(res, 201, card);
      }

      const boardRunMatch = path.match(/^\/api\/boards\/([^/]+)\/run$/);
      if (boardRunMatch && method === "POST") {
        const body = await readBody(req);
        if (body.async === true) {
          const board=store.getBoard(boardRunMatch[1]);
          const job=store.createJob({type:"board.run",workspaceId:board?.workspace_id,boardId:boardRunMatch[1],payload:{source:"api"}});
          return json(res,202,job);
        }
        const result = await engine.runBoard(boardRunMatch[1]);
        return json(res, result.ok === false ? 409 : 200, result);
      }

      const cardMatch = path.match(/^\/api\/cards\/([^/]+)$/);
      if (cardMatch) {
        const card = store.getCard(cardMatch[1]);
        if (!card) return notFound(res);
        if (method === "GET") return json(res, 200, card);
        if (method === "PATCH") {
          const body = await readBody(req);
          const updated = store.updateCard(card.id, {
            title: body.title?.trim() || undefined,
            objective: body.objective !== undefined ? String(body.objective) : undefined,
            dependencies: body.dependencies,
            priority: body.priority,
            assignee: body.assignee,
            tags: body.tags,
          });
          broadcast({ type: "card", cardId: card.id, boardId: card.board_id });
          return json(res, 200, updated);
        }
        if (method === "DELETE") {
          const workspace=store.getWorkspaceByBoard(card.board_id);const body=await readBody(req);
          if(!authorizeOperation(workspace,"card.delete",card.id,body.approvalId))return json(res,403,{error:"approved operation approval required"});
          if(card.worktree_path){await new RealExecutionService(store).worktrees.remove(workspace.repo_path,card.worktree_path,{force:true}).catch(()=>{});}
          store.deleteCard(card.id);
          broadcast({ type: "card", cardId: card.id, boardId: card.board_id });
          return json(res, 200, { ok: true });
        }
      }

      const cardMoveMatch = path.match(/^\/api\/cards\/([^/]+)\/move$/);
      if (cardMoveMatch && method === "POST") {
        const body = await readBody(req);
        const card = store.getCard(cardMoveMatch[1]);
        if (!card) return notFound(res);
        if (!LANES.includes(body.column)) return badRequest(res, `column must be one of ${LANES.join(", ")}`);
        const patch = { columnId: body.column };
        if (body.column === "blocked") patch.blockedFrom = card.column_id;
        const updated = store.updateCard(card.id, patch);
        broadcast({ type: "card", cardId: card.id, boardId: card.board_id });
        return json(res, 200, updated);
      }

      const cardRunMatch = path.match(/^\/api\/cards\/([^/]+)\/run$/);
      if (cardRunMatch && method === "POST") {
        const card = store.getCard(cardRunMatch[1]);
        if (!card) return notFound(res);
        const result = await engine.runCard(card.id);
        return json(res, 200, result);
      }

      const cardSessionsMatch = path.match(/^\/api\/cards\/([^/]+)\/sessions$/);
      if (cardSessionsMatch && method === "GET") {
        return json(res, 200, store.listSessionsForCard(cardSessionsMatch[1]));
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && method === "GET") {
        const session = store.getSession(sessionMatch[1]);
        if (!session) return notFound(res);
        return json(res, 200, { session, traces: store.listTraces(session.id) });
      }

      // ── Static SPA ─────────────────────────────────────────────
      if (method === "GET") {
        let filePath = path === "/" ? "/index.html" : path;
        const full = normalize(join(PUBLIC_DIR, filePath));
        if (!full.startsWith(PUBLIC_DIR)) return notFound(res);
        try {
          const content = await readFile(full);
          res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
          return res.end(content);
        } catch {
          return notFound(res);
        }
      }

      notFound(res);
    } catch (err) {
      const status=err.message==="Invalid JSON body"?400:err.message.includes("exceeds 1 MiB")?413:500;
      json(res, status, { error: err.message });
    }
  });

  server.on("close", () => { void worker.stop(); });
  return { server, store, engine, worker };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3210);
  const host = process.env.HOST ?? "127.0.0.1"; // tool/file APIs are local-only by default
  const dbPath = process.env.LUCAPI_DB ?? process.env.LUCA_DB ?? (existsSync("luca.db") ? "luca.db" : "lucapi.db");
  const { server, engine, worker } = createApp({ dbPath, startWorker:process.env.LUCAPI_EMBEDDED_WORKER!=="false" });
  server.listen(port, host, () => {
    console.log(`\n  ◆ LucaPi — workspace-first multi-agent delivery board`);
    console.log(`  ◆ http://${host}:${port}`);
    console.log(`  ◆ provider: ${engine.getProviders().mode === "llm" ? engine.getProviders().primary.name : "simulated (configure one in ⚙ Providers, or set LUCAPI_LLM_BASE_URL/API_KEY/MODEL)"}`);
    console.log(`  ◆ db: ${dbPath}\n`);
  });
  const shutdown=async()=>{console.log("\n  ◆ draining worker…");await worker.stop();server.close();};
  process.once("SIGTERM",shutdown);process.once("SIGINT",shutdown);
}
