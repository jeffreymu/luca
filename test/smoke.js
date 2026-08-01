/**
 * End-to-end smoke test — boots the real server on an ephemeral port and
 * drives the full delivery loop:
 *   workspace -> card -> board automation -> Done with artifacts,
 *   including the Review Guard rejection loop and entry-gate rejections.
 */
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createApp } from "../server.js";

// Ensure the no-token test path is deterministic.
const savedGhToken = process.env.GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;

const { server } = createApp({ dbPath: ":memory:" });

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const api = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

let passed = 0;
const check = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
};

try {
  console.log("\nLuca smoke test\n");

  // 1. Workspace + board
  const ws = await api("/api/workspaces", { method: "POST", body: { name: "Smoke WS", repoPath: "/tmp/repo" } });
  check("POST /api/workspaces -> 201", ws.status === 201);
  const boardId = ws.body.board.id;

  const state0 = await api(`/api/state?workspaceId=${ws.body.workspace.id}`);
  check("GET /api/state returns 6 lanes", state0.body.lanes.length === 6);
  check("provider mode is simulated by default", state0.body.provider.mode === "simulated");
  check("state exposes server cwd", typeof state0.body.serverCwd === "string" && state0.body.serverCwd.length > 0);

  // workspace created without explicit repoPath defaults to the server cwd, and stays editable
  const wsDefault = await api("/api/workspaces", { method: "POST", body: { name: "Default Path WS" } });
  const wsDefaultId = wsDefault.body.workspace.id;
  const stateDefault = await api(`/api/state?workspaceId=${wsDefaultId}`);
  check("repo_path defaults to server cwd", stateDefault.body.workspace.repoPath === stateDefault.body.serverCwd);

  // 2. Create cards: one multi-AC (will exercise the rejection loop), one simple
  const c1 = await api(`/api/boards/${boardId}/cards`, {
    method: "POST",
    body: {
      title: "用户登录与密码重置",
      objective: "用户可以用邮箱和密码登录。登录失败三次后锁定账户十分钟。用户可以通过邮件链接重置密码。",
    },
  });
  check("card 1 created in backlog", c1.body.column_id === "backlog");
  const c2 = await api(`/api/boards/${boardId}/cards`, {
    method: "POST",
    body: { title: "修复分页组件越界", objective: "当总页数为 0 时分页组件显示空态而不是第 1 页。" },
  });

  // 3. Single-card run: Backlog Refiner produces canonical story, moves to todo
  const run1 = await api(`/api/cards/${c1.body.id}/run`, { method: "POST" });
  check("backlog refiner moved card to todo", run1.body.card.column_id === "todo");
  const storyArt = run1.body.card.artifacts.find((a) => a.type === "story");
  check("canonical story artifact exists with yaml block", storyArt && storyArt.content.includes("```yaml"));
  check("story has >= 2 acceptance criteria", storyArt.data.story.acceptance_criteria.length >= 2);

  // 4. Full board automation
  const auto = await api(`/api/boards/${boardId}/run`, { method: "POST" });
  check("board automation ok", auto.body.ok === true);
  check("automation ran multiple sweeps", auto.body.sweeps >= 2);

  const finalState = await api(`/api/state?workspaceId=${ws.body.workspace.id}`);
  const f1 = finalState.body.cards.find((c) => c.id === c1.body.id);
  const f2 = finalState.body.cards.find((c) => c.id === c2.body.id);

  check("card 1 reached done", f1.column_id === "done");
  check("card 2 reached done", f2.column_id === "done");
  check("card 1 verdict DONE (terminal)", f1.verdict === "DONE");

  const types1 = f1.artifacts.map((a) => a.type);
  for (const t of ["story", "brief", "evidence", "review", "summary"])
    check(`card 1 has ${t} artifact`, types1.includes(t));

  // 5. The distrust loop actually happened for the multi-AC card:
  //    first dev pass leaves a thin verification, review rejects, dev fixes, review approves.
  const reviews1 = f1.artifacts.filter((a) => a.type === "review");
  check("card 1 was rejected at least once (distrust loop)", reviews1.some((a) => a.data.verdict === "NOT_APPROVED"));
  check("card 1 final review APPROVED", reviews1.at(-1).data.verdict === "APPROVED");
  check("loop breaker never tripped (card not stuck in blocked)", f1.column_id !== "blocked");

  // 6. Sessions & traces are auditable
  const sessions = await api(`/api/cards/${c1.body.id}/sessions`);
  check("card 1 has multiple sessions", sessions.body.length >= 5);
  const detail = await api(`/api/sessions/${sessions.body[0].id}`);
  check("session has ordered traces", detail.body.traces.length >= 2 && detail.body.traces[0].seq === 1);

  // 7. Entry gate: a card manually dropped into review with no evidence gets bounced to dev
  const c3 = await api(`/api/boards/${boardId}/cards`, { method: "POST", body: { title: "空降评审的卡片" } });
  await api(`/api/cards/${c3.body.id}/move`, { method: "POST", body: { column: "review" } });
  const gateRun = await api(`/api/cards/${c3.body.id}/run`, { method: "POST" });
  check("review entry gate rejects card without evidence to dev", gateRun.body.card.column_id === "dev");

  // 8. Done Reporter entry gate: card moved to done without approval bounces to review
  const c4 = await api(`/api/boards/${boardId}/cards`, { method: "POST", body: { title: "空降完成的卡片" } });
  await api(`/api/cards/${c4.body.id}/move`, { method: "POST", body: { column: "done" } });
  const doneRun = await api(`/api/cards/${c4.body.id}/run`, { method: "POST" });
  check("done entry gate rejects card without approval to review", doneRun.body.card.column_id === "review");

  // 9. Blocked Resolver routes a blocked card back with analysis
  await api(`/api/cards/${c3.body.id}/move`, { method: "POST", body: { column: "blocked" } });
  const blockedRun = await api(`/api/cards/${c3.body.id}/run`, { method: "POST" });
  check("blocked resolver routes card out of blocked", blockedRun.body.card.column_id !== "blocked");
  check("blocker analysis artifact appended", blockedRun.body.card.artifacts.some((a) => a.type === "blocker"));

  // 10. PATCH + DELETE
  const patched = await api(`/api/cards/${c4.body.id}`, { method: "PATCH", body: { title: "改名后的卡片" } });
  check("PATCH card title works", patched.body.title === "改名后的卡片");
  const del = await api(`/api/cards/${c4.body.id}`, { method: "DELETE" });
  check("DELETE card works", del.status === 200);

  // 11. Provider management: configure, activate, fallback, deactivate
  const prov = await api("/api/providers", {
    method: "POST",
    body: {
      name: "测试Provider",
      baseUrl: "http://127.0.0.1:9/v1", // unreachable on purpose
      apiKey: "sk-test-1234567890abcd",
      model: "test-model",
      setActive: true,
    },
  });
  check("POST /api/providers -> 201", prov.status === 201);
  const provId = prov.body.id;

  const provList = await api("/api/providers");
  check("provider list shows active llm current", provList.body.current.mode === "llm" && provList.body.current.source === "db");
  check("api key is masked in list", !JSON.stringify(provList.body).includes("sk-test-1234567890abcd") && provList.body.providers[0].apiKeyMasked.includes("…"));

  const stateLlm = await api(`/api/state?workspaceId=${ws.body.workspace.id}`);
  check("state reflects active llm provider", stateLlm.body.provider.mode === "llm");

  // unreachable LLM -> engine falls back to simulated, card still advances, trace records it
  const c5 = await api(`/api/boards/${boardId}/cards`, { method: "POST", body: { title: "回退验证卡片", objective: "验证 LLM 不可用时回退到 simulated provider。" } });
  const fbRun = await api(`/api/cards/${c5.body.id}/run`, { method: "POST" });
  check("card advances via fallback despite dead LLM", fbRun.body.card.column_id === "todo");
  const fbSessions = await api(`/api/cards/${c5.body.id}/sessions`);
  check("session records the llm provider name", fbSessions.body[0].provider.includes("测试Provider"));
  const fbDetail = await api(`/api/sessions/${fbSessions.body[0].id}`);
  check("trace records the fallback", fbDetail.body.traces.some((t) => t.kind === "error" && t.message.includes("回退")));

  const provTest = await api(`/api/providers/${provId}/test`, { method: "POST" });
  check("test endpoint reports unreachable provider", provTest.body.ok === false && provTest.body.detail.length > 0);

  const provPatch = await api(`/api/providers/${provId}`, { method: "PATCH", body: { model: "test-model-v2", apiKey: "" } });
  check("PATCH provider model works (empty apiKey keeps stored key)", provPatch.status === 200);
  const provList2 = await api("/api/providers");
  check("patched model visible", provList2.body.providers[0].model === "test-model-v2");

  const deact = await api("/api/providers/deactivate", { method: "POST" });
  check("deactivate falls back to simulated", deact.body.current.mode === "simulated");
  const react = await api(`/api/providers/${provId}/activate`, { method: "POST" });
  check("re-activate restores llm mode", react.body.current.mode === "llm");
  const provDel = await api(`/api/providers/${provId}`, { method: "DELETE" });
  check("delete provider works", provDel.status === 200);
  const stateSim = await api(`/api/state?workspaceId=${ws.body.workspace.id}`);
  check("state back to simulated after delete", stateSim.body.provider.mode === "simulated");

  // 12. Git / GitHub operations (offline: bare repo as remote + mock GitHub API)
  const tmp = mkdtempSync(path.join(os.tmpdir(), "luca-git-"));
  const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  git(["init", "--bare", "-b", "main", "remote.git"], tmp);
  git(["clone", "remote.git", "work"], tmp);
  const work = path.join(tmp, "work");
  git(["config", "user.email", "luca@test.local"], work);
  git(["config", "user.name", "Luca Test"], work);
  writeFileSync(path.join(work, "a.txt"), "hello\n");
  git(["add", "-A"], work);
  git(["commit", "-m", "init"], work);
  git(["push", "-u", "origin", "main"], work);

  // Mock GitHub API: first PR creation succeeds, second time answers 422 (already exists)
  let ghMode = "create";
  const gh = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      if (req.method === "POST" && req.url === "/repos/octo/demo/pulls") {
        if (ghMode === "create") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ number: 7, html_url: "http://gh.mock/pr/7", title: JSON.parse(raw).title, state: "open" }));
        } else {
          res.writeHead(422, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "Validation Failed", errors: [{ message: "A pull request already exists" }] }));
        }
      } else if (req.method === "GET" && req.url.startsWith("/repos/octo/demo/pulls")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ number: 7, html_url: "http://gh.mock/pr/7", title: "existing", state: "open" }]));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  await new Promise((r) => gh.listen(0, r));
  const ghBase = `http://127.0.0.1:${gh.address().port}`;

  const wsGit = await api("/api/workspaces", { method: "POST", body: { name: "Git WS", repoPath: work } });
  const gitWsId = wsGit.body.workspace.id;
  const patchedWs = await api(`/api/workspaces/${gitWsId}`, {
    method: "PATCH",
    body: { githubToken: "ghp_secret_token_123456", githubRepo: "octo/demo", githubApiBase: ghBase },
  });
  check("PATCH workspace github settings works", patchedWs.status === 200);
  check("github token masked in response", patchedWs.body.github.hasToken === true && !JSON.stringify(patchedWs.body).includes("ghp_secret_token_123456"));
  const stateGit = await api(`/api/state?workspaceId=${gitWsId}`);
  check("state never leaks raw github token", !JSON.stringify(stateGit.body).includes("ghp_secret_token_123456"));

  const st0 = await api(`/api/workspaces/${gitWsId}/git/status`);
  check("git status: branch main, clean", st0.body.branch === "main" && st0.body.clean === true);
  check("git status: slug from workspace config", st0.body.repoSlug === "octo/demo");

  writeFileSync(path.join(work, "b.txt"), "new file\n");
  const st1 = await api(`/api/workspaces/${gitWsId}/git/status`);
  check("git status detects worktree change", st1.body.clean === false && st1.body.changes.some((c) => c.path === "b.txt"));

  const push = await api(`/api/workspaces/${gitWsId}/git/push`, { method: "POST", body: { message: "feat: add b" } });
  check("push commits worktree changes", push.status === 200 && push.body.committed);
  const remoteLog = git(["--git-dir", path.join(tmp, "remote.git"), "log", "-1", "--format=%s", "main"], tmp);
  check("remote received the pushed commit", remoteLog === "feat: add b");

  // another clone pushes a commit, then Luca pulls it in
  git(["clone", "remote.git", "work2"], tmp);
  const work2 = path.join(tmp, "work2");
  git(["config", "user.email", "luca@test.local"], work2);
  git(["config", "user.name", "Luca Test"], work2);
  writeFileSync(path.join(work2, "c.txt"), "from upstream\n");
  git(["add", "-A"], work2);
  git(["commit", "-m", "upstream change"], work2);
  git(["push", "origin", "main"], work2);
  const pull = await api(`/api/workspaces/${gitWsId}/git/pull`, { method: "POST", body: {} });
  check("pull succeeds", pull.status === 200);
  check("pulled file exists locally", existsSync(path.join(work, "c.txt")));

  const pr = await api(`/api/workspaces/${gitWsId}/git/pr`, { method: "POST", body: { title: "My PR", base: "main" } });
  check("PR created via GitHub API", pr.status === 201 && pr.body.number === 7 && pr.body.existed === false);
  ghMode = "exists";
  const pr2 = await api(`/api/workspaces/${gitWsId}/git/pr`, { method: "POST", body: { title: "My PR again", base: "main" } });
  check("existing PR returned instead of error", pr2.status === 200 && pr2.body.existed === true && pr2.body.number === 7);

  const wsNoToken = await api("/api/workspaces", { method: "POST", body: { name: "No Token WS", repoPath: work } });
  const prNoToken = await api(`/api/workspaces/${wsNoToken.body.workspace.id}/git/pr`, { method: "POST", body: { title: "x" } });
  check("PR without token -> helpful 400", prNoToken.status === 400 && prNoToken.body.error.includes("token"));

  const wsNoRepo = await api("/api/workspaces", { method: "POST", body: { name: "No Repo WS", repoPath: os.tmpdir() } });
  const stNoRepo = await api(`/api/workspaces/${wsNoRepo.body.workspace.id}/git/status`);
  check("git status on non-git dir -> readable 400", stNoRepo.status === 400 && stNoRepo.body.error.includes("git"));

  // repo_path stays editable: point the workspace at the real repo and status works
  const repointed = await api(`/api/workspaces/${wsNoRepo.body.workspace.id}`, { method: "PATCH", body: { repoPath: work } });
  check("repo_path editable via PATCH", repointed.status === 200 && repointed.body.repoPath === work);
  const stRepointed = await api(`/api/workspaces/${wsNoRepo.body.workspace.id}/git/status`);
  check("git status works after repointing", stRepointed.status === 200 && stRepointed.body.branch === "main");

  gh.close();

  console.log(`\nAll ${passed} checks passed ✅\n`);} finally {
  if (savedGhToken) process.env.GITHUB_TOKEN = savedGhToken;
  server.close();
}
