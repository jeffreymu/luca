/**
 * Luca persistence layer — node:sqlite (zero dependencies).
 *
 * Entities (borrowed from Routa's workspace-first model):
 *   workspaces -> boards -> cards (with growing artifacts)
 *   sessions + traces (every specialist run is auditable)
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export function openDb(dbPath = "luca.db") {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      column_id TEXT NOT NULL DEFAULT 'backlog',
      position INTEGER NOT NULL DEFAULT 0,
      artifacts TEXT NOT NULL DEFAULT '[]',
      verdict TEXT,
      blocked_from TEXT,
      review_rejections INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      specialist_id TEXT NOT NULL,
      specialist_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      verdict TEXT,
      summary TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      workspace_id TEXT,
      board_id TEXT,
      card_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'PENDING',
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      run_after TEXT NOT NULL,
      lease_until TEXT,
      error TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS specialist_configs (
      id TEXT PRIMARY KEY,
      lane TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      system_prompt TEXT,
      provider_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      definition TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      name TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      instructions TEXT NOT NULL,
      tools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_configs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      event TEXT NOT NULL,
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id TEXT PRIMARY KEY,
      config_id TEXT,
      event TEXT NOT NULL,
      delivery_id TEXT,
      status TEXT NOT NULL,
      payload TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      provider_id TEXT,
      parent_id TEXT,
      status TEXT NOT NULL DEFAULT 'IDLE',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      max_concurrency INTEGER NOT NULL DEFAULT 2,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_messages (
      id TEXT PRIMARY KEY,
      team_run_id TEXT NOT NULL,
      agent_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      team_run_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      response TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_card ON sessions(card_id);
    CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
  `);
  // Idempotent column migrations for existing databases.
  for (const ddl of [
    "ALTER TABLE workspaces ADD COLUMN github_token TEXT",
    "ALTER TABLE workspaces ADD COLUMN github_repo TEXT",
    "ALTER TABLE workspaces ADD COLUMN github_api_base TEXT",
    "ALTER TABLE workspaces ADD COLUMN validation_commands TEXT",
    "ALTER TABLE workspaces ADD COLUMN sandbox_policy TEXT",
    "ALTER TABLE cards ADD COLUMN worktree_path TEXT",
    "ALTER TABLE cards ADD COLUMN branch_name TEXT",
    "ALTER TABLE cards ADD COLUMN base_branch TEXT",
    "ALTER TABLE cards ADD COLUMN base_commit TEXT",
    "ALTER TABLE cards ADD COLUMN head_commit TEXT",
    "ALTER TABLE cards ADD COLUMN pr_url TEXT",
    "ALTER TABLE cards ADD COLUMN parent_id TEXT",
    "ALTER TABLE cards ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE cards ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE cards ADD COLUMN assignee TEXT",
    "ALTER TABLE cards ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE sessions ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE sessions ADD COLUMN resumed_from TEXT",
  ]) {
    try {
      db.exec(ddl);
    } catch {
      /* column already exists */
    }
  }
  return db;
}

const now = () => new Date().toISOString();

function hydrateCard(row) {
  if (!row) return row;
  return {
    ...row,
    artifacts: JSON.parse(row.artifacts || "[]"),
    dependencies: JSON.parse(row.dependencies || "[]"),
    tags: JSON.parse(row.tags || "[]"),
  };
}

function parseJsonColumns(row, columns) {
  if (!row) return row;
  const result = { ...row };
  for (const column of columns) result[column] = JSON.parse(result[column] || (column === "definition" ? "{}" : "[]"));
  return result;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  // ── Workspaces / Boards ──────────────────────────────────────────
  createWorkspace({ name, repoPath }) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO workspaces (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, repoPath ?? null, now());
    const boardId = randomUUID();
    this.db
      .prepare("INSERT INTO boards (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run(boardId, id, "Delivery Board", now());
    return { workspace: this.getWorkspace(id), board: this.getBoard(boardId) };
  }

  listWorkspaces() {
    return this.db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC").all();
  }

  getWorkspace(id) {
    return this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
  }

  updateWorkspace(id, patch) {
    const row = this.getWorkspace(id);
    if (!row) return null;
    this.db
      .prepare(
        "UPDATE workspaces SET name=?, repo_path=?, github_token=?, github_repo=?, github_api_base=?, validation_commands=?, sandbox_policy=? WHERE id=?"
      )
      .run(
        patch.name ?? row.name,
        patch.repoPath !== undefined ? patch.repoPath : row.repo_path,
        // empty string keeps the stored token; there is no "clear" via PATCH
        patch.githubToken ? patch.githubToken : row.github_token,
        patch.githubRepo !== undefined ? patch.githubRepo : row.github_repo,
        patch.githubApiBase !== undefined ? patch.githubApiBase : row.github_api_base,
        patch.validationCommands !== undefined ? JSON.stringify(patch.validationCommands) : row.validation_commands,
        patch.sandboxPolicy !== undefined ? JSON.stringify(patch.sandboxPolicy) : row.sandbox_policy,
        id
      );
    return this.getWorkspace(id);
  }

  getBoard(id) {
    return this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id);
  }

  getBoardByWorkspace(workspaceId) {
    return this.db
      .prepare("SELECT * FROM boards WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(workspaceId);
  }

  getWorkspaceByBoard(boardId) {
    return this.db.prepare("SELECT w.* FROM workspaces w JOIN boards b ON b.workspace_id=w.id WHERE b.id=?").get(boardId);
  }

  deleteWorkspace(id) {
    const boards = this.db.prepare("SELECT id FROM boards WHERE workspace_id = ?").all(id);
    for (const b of boards) {
      const cards = this.db.prepare("SELECT id FROM cards WHERE board_id = ?").all(b.id);
      for (const c of cards) this.deleteCard(c.id);
      this.db.prepare("DELETE FROM boards WHERE id = ?").run(b.id);
    }
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  }

  // ── Cards ────────────────────────────────────────────────────────
  createCard({ boardId, title, objective, parentId = null, dependencies = [], priority = 0, assignee = null, tags = [] }) {
    const id = randomUUID();
    const maxPos = this.db
      .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM cards WHERE board_id = ? AND column_id = 'backlog'")
      .get(boardId).p;
    this.db
      .prepare(
        `INSERT INTO cards (id, board_id, title, objective, column_id, position, artifacts, parent_id, dependencies, priority, assignee, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'backlog', ?, '[]', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, boardId, title, objective ?? "", maxPos + 1, parentId, JSON.stringify(dependencies), priority, assignee, JSON.stringify(tags), now(), now());
    return this.getCard(id);
  }

  getCard(id) {
    return hydrateCard(this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id));
  }

  listCards(boardId) {
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE board_id = ? ORDER BY column_id, position ASC, created_at ASC")
      .all(boardId);
    return rows.map(hydrateCard);
  }

  updateCard(id, patch) {
    const card = this.getCard(id);
    if (!card) return null;
    const next = {
      title: patch.title ?? card.title,
      objective: patch.objective ?? card.objective,
      column_id: patch.columnId ?? card.column_id,
      artifacts: patch.artifacts ?? card.artifacts,
      verdict: patch.verdict !== undefined ? patch.verdict : card.verdict,
      blocked_from: patch.blockedFrom !== undefined ? patch.blockedFrom : card.blocked_from,
      review_rejections:
        patch.reviewRejections !== undefined ? patch.reviewRejections : card.review_rejections,
      worktree_path: patch.worktreePath !== undefined ? patch.worktreePath : card.worktree_path,
      branch_name: patch.branchName !== undefined ? patch.branchName : card.branch_name,
      base_branch: patch.baseBranch !== undefined ? patch.baseBranch : card.base_branch,
      base_commit: patch.baseCommit !== undefined ? patch.baseCommit : card.base_commit,
      head_commit: patch.headCommit !== undefined ? patch.headCommit : card.head_commit,
      pr_url: patch.prUrl !== undefined ? patch.prUrl : card.pr_url,
      parent_id: patch.parentId !== undefined ? patch.parentId : card.parent_id,
      dependencies: patch.dependencies ?? card.dependencies,
      priority: patch.priority ?? card.priority,
      assignee: patch.assignee !== undefined ? patch.assignee : card.assignee,
      tags: patch.tags ?? card.tags,
    };
    this.db
      .prepare(
        `UPDATE cards SET title=?, objective=?, column_id=?, artifacts=?, verdict=?, blocked_from=?,
         review_rejections=?, worktree_path=?, branch_name=?, base_branch=?, base_commit=?, head_commit=?, pr_url=?,
         parent_id=?, dependencies=?, priority=?, assignee=?, tags=?, updated_at=? WHERE id=?`
      )
      .run(
        next.title,
        next.objective,
        next.column_id,
        JSON.stringify(next.artifacts),
        next.verdict,
        next.blocked_from,
        next.review_rejections,
        next.worktree_path,
        next.branch_name,
        next.base_branch,
        next.base_commit,
        next.head_commit,
        next.pr_url,
        next.parent_id,
        JSON.stringify(next.dependencies),
        next.priority,
        next.assignee,
        JSON.stringify(next.tags),
        now(),
        id
      );
    return this.getCard(id);
  }

  appendArtifact(id, artifact) {
    const card = this.getCard(id);
    const artifacts = [...card.artifacts, { ...artifact, createdAt: now() }];
    return this.updateCard(id, { artifacts });
  }

  deleteCard(id) {
    const sessions = this.db.prepare("SELECT id FROM sessions WHERE card_id = ?").all(id);
    for (const s of sessions) this.db.prepare("DELETE FROM traces WHERE session_id = ?").run(s.id);
    this.db.prepare("DELETE FROM sessions WHERE card_id = ?").run(id);
    this.db.prepare("DELETE FROM jobs WHERE card_id = ?").run(id);
    this.db.prepare("DELETE FROM cards WHERE id = ?").run(id);
  }

  listReadyCards(boardId) {
    const cards = this.listCards(boardId);
    const done = new Set(cards.filter((c) => c.column_id === "done").map((c) => c.id));
    return cards.filter((c) => c.column_id !== "done" && c.dependencies.every((id) => done.has(id)));
  }

  // ── Durable jobs ────────────────────────────────────────────────
  createJob({ type, workspaceId = null, boardId = null, cardId = null, payload = {}, priority = 0, maxAttempts = 3, runAfter = now() }) {
    const id = randomUUID();
    this.db.prepare(
      `INSERT INTO jobs (id,type,workspace_id,board_id,card_id,payload,status,priority,attempts,max_attempts,run_after,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'PENDING',?,0,?,?,?,?)`
    ).run(id, type, workspaceId, boardId, cardId, JSON.stringify(payload), priority, maxAttempts, runAfter, now(), now());
    return this.getJob(id);
  }

  getJob(id) {
    return parseJsonColumns(this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id), ["payload"]);
  }

  listJobs({ workspaceId, status, limit = 100 } = {}) {
    let sql = "SELECT * FROM jobs WHERE 1=1";
    const args = [];
    if (workspaceId) { sql += " AND workspace_id=?"; args.push(workspaceId); }
    if (status) { sql += " AND status=?"; args.push(status); }
    sql += " ORDER BY priority DESC, created_at ASC LIMIT ?"; args.push(limit);
    return this.db.prepare(sql).all(...args).map((r) => parseJsonColumns(r, ["payload"]));
  }

  recoverExpiredJobs() {
    this.db.prepare("UPDATE jobs SET status='PENDING', lease_until=NULL, updated_at=? WHERE status='RUNNING' AND lease_until < ?")
      .run(now(), now());
  }

  claimJob(leaseMs = 120_000) {
    this.recoverExpiredJobs();
    const timestamp=now(), leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const row=this.db.prepare(
      `UPDATE jobs SET status='RUNNING',attempts=attempts+1,lease_until=?,updated_at=?
       WHERE id=(SELECT id FROM jobs WHERE status='PENDING' AND run_after<=? ORDER BY priority DESC,created_at ASC LIMIT 1)
       AND status='PENDING' RETURNING *`
    ).get(leaseUntil,timestamp,timestamp);
    return parseJsonColumns(row,["payload"]);
  }

  renewJobLease(id, leaseMs = 120_000) {
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    return this.db.prepare("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND status='RUNNING'")
      .run(leaseUntil, now(), id).changes === 1;
  }

  completeJob(id, result) {
    return this.db.prepare("UPDATE jobs SET status='COMPLETED', result=?, lease_until=NULL, updated_at=? WHERE id=? AND status='RUNNING'")
      .run(JSON.stringify(result ?? {}), now(), id).changes === 1;
  }

  failJob(id, error, retryDelayMs = 1000) {
    const job = this.getJob(id);
    if(!job || job.status!=="RUNNING") return false;
    const retry = job.attempts < job.max_attempts;
    this.db.prepare("UPDATE jobs SET status=?, error=?, lease_until=NULL, run_after=?, updated_at=? WHERE id=? AND status='RUNNING'")
      .run(retry ? "PENDING" : "FAILED", String(error).slice(0, 1000), new Date(Date.now() + retryDelayMs).toISOString(), now(), id);
    return retry;
  }

  cancelJob(id) {
    const job=this.getJob(id);
    this.db.prepare("UPDATE jobs SET status='CANCELLED', lease_until=NULL, updated_at=? WHERE id=? AND status IN ('PENDING','RUNNING')")
      .run(now(), id);
    if(job?.card_id) this.db.prepare("UPDATE sessions SET cancel_requested=1 WHERE card_id=? AND status='ACTIVE'").run(job.card_id);
    return this.getJob(id);
  }

  // ── Configurable specialists ────────────────────────────────────
  listSpecialistConfigs() { return this.db.prepare("SELECT * FROM specialist_configs ORDER BY lane").all(); }
  upsertSpecialistConfig({ lane, name, systemPrompt = null, providerId = null, enabled = true }) {
    const existing = this.db.prepare("SELECT id FROM specialist_configs WHERE lane=?").get(lane);
    const id = existing?.id ?? randomUUID();
    this.db.prepare(
      `INSERT INTO specialist_configs (id,lane,name,system_prompt,provider_id,enabled,updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(lane) DO UPDATE SET name=excluded.name,system_prompt=excluded.system_prompt,provider_id=excluded.provider_id,enabled=excluded.enabled,updated_at=excluded.updated_at`
    ).run(id, lane, name, systemPrompt, providerId, enabled ? 1 : 0, now());
    return this.db.prepare("SELECT * FROM specialist_configs WHERE lane=?").get(lane);
  }
  deleteSpecialistConfig(lane) { this.db.prepare("DELETE FROM specialist_configs WHERE lane=?").run(lane); }

  // ── Workflows / schedules / skills / webhooks ──────────────────
  createWorkflow({ workspaceId, name, definition }) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO workflows VALUES (?,?,?,?,?,?)").run(id, workspaceId, name, JSON.stringify(definition), now(), now());
    return this.getWorkflow(id);
  }
  getWorkflow(id) { return parseJsonColumns(this.db.prepare("SELECT * FROM workflows WHERE id=?").get(id), ["definition"]); }
  listWorkflows(workspaceId) { return this.db.prepare("SELECT * FROM workflows WHERE workspace_id=? ORDER BY created_at").all(workspaceId).map((r) => parseJsonColumns(r,["definition"])); }
  deleteWorkflow(id) { this.db.prepare("DELETE FROM workflows WHERE id=?").run(id); }

  createSchedule({ workspaceId, workflowId, name, intervalMinutes }) {
    const id = randomUUID();
    const next = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
    this.db.prepare("INSERT INTO schedules VALUES (?,?,?,?,?,1,?,?,?)").run(id, workspaceId, workflowId, name, intervalMinutes, next, null, now());
    return this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id);
  }
  listSchedules(workspaceId) { return this.db.prepare("SELECT * FROM schedules WHERE workspace_id=? ORDER BY created_at").all(workspaceId); }
  dueSchedules() { return this.db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at <= ?").all(now()); }
  markScheduleRun(id, intervalMinutes) { this.db.prepare("UPDATE schedules SET last_run_at=?, next_run_at=? WHERE id=?").run(now(), new Date(Date.now()+intervalMinutes*60_000).toISOString(), id); }

  createSkill({ workspaceId = null, name, description = "", instructions, tools = [] }) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO skills VALUES (?,?,?,?,?,?,?,?)").run(id, workspaceId, name, description, instructions, JSON.stringify(tools), now(), now());
    return parseJsonColumns(this.db.prepare("SELECT * FROM skills WHERE id=?").get(id), ["tools"]);
  }
  listSkills(workspaceId) { return this.db.prepare("SELECT * FROM skills WHERE workspace_id IS NULL OR workspace_id=? ORDER BY name").all(workspaceId).map((r)=>parseJsonColumns(r,["tools"])); }
  deleteSkill(id) { this.db.prepare("DELETE FROM skills WHERE id=?").run(id); }

  createWebhook({ workspaceId, workflowId, event, secret = null }) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO webhook_configs VALUES (?,?,?,?,?,1,?)").run(id, workspaceId, workflowId, event, secret, now());
    return this.db.prepare("SELECT * FROM webhook_configs WHERE id=?").get(id);
  }
  listWebhooks(workspaceId) { return this.db.prepare("SELECT * FROM webhook_configs WHERE workspace_id=? ORDER BY created_at").all(workspaceId); }
  matchingWebhooks(workspaceId, event) { return this.db.prepare("SELECT * FROM webhook_configs WHERE workspace_id=? AND event=? AND enabled=1").all(workspaceId,event); }
  logWebhook({ configId, event, deliveryId, status, payload, error = null }) {
    const id=randomUUID(); this.db.prepare("INSERT INTO webhook_logs VALUES (?,?,?,?,?,?,?,?)").run(id,configId,event,deliveryId,status,JSON.stringify(payload),error,now()); return id;
  }

  // ── Multi-agent team coordination ──────────────────────────────
  createAgent({ workspaceId, name, role, providerId = null, parentId = null, metadata = {} }) {
    const id=randomUUID(); this.db.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,'IDLE',?,?,?)").run(id,workspaceId,name,role,providerId,parentId,JSON.stringify(metadata),now(),now()); return this.getAgent(id);
  }
  getAgent(id) { return parseJsonColumns(this.db.prepare("SELECT * FROM agents WHERE id=?").get(id),["metadata"]); }
  listAgents(workspaceId) { return this.db.prepare("SELECT * FROM agents WHERE workspace_id=? ORDER BY created_at").all(workspaceId).map((r)=>parseJsonColumns(r,["metadata"])); }
  updateAgentStatus(id,status) { this.db.prepare("UPDATE agents SET status=?,updated_at=? WHERE id=?").run(status,now(),id); return this.getAgent(id); }
  deleteAgent(id) { this.db.prepare("DELETE FROM agents WHERE id=?").run(id); }
  createTeamRun({workspaceId,boardId,goal,maxConcurrency=2}) { const id=randomUUID();this.db.prepare("INSERT INTO team_runs VALUES (?,?,?,?,'PENDING',?,?,?)").run(id,workspaceId,boardId,goal,maxConcurrency,now(),now());return this.getTeamRun(id); }
  updateTeamRunStatus(id,status) { this.db.prepare("UPDATE team_runs SET status=?,updated_at=? WHERE id=?").run(status,now(),id); return this.getTeamRun(id); }
  getTeamRun(id) { const run=this.db.prepare("SELECT * FROM team_runs WHERE id=?").get(id);if(!run)return null;return {...run,messages:this.db.prepare("SELECT * FROM team_messages WHERE team_run_id=? ORDER BY created_at").all(id),approvals:this.db.prepare("SELECT * FROM approvals WHERE team_run_id=? ORDER BY created_at").all(id)}; }
  listTeamRuns(workspaceId) { return this.db.prepare("SELECT * FROM team_runs WHERE workspace_id=? ORDER BY created_at DESC").all(workspaceId); }
  addTeamMessage({teamRunId,agentId=null,role,content}) { const id=randomUUID();this.db.prepare("INSERT INTO team_messages VALUES (?,?,?,?,?,?)").run(id,teamRunId,agentId,role,content,now());return this.db.prepare("SELECT * FROM team_messages WHERE id=?").get(id); }
  createApproval({teamRunId,prompt}) { const id=randomUUID();this.db.prepare("INSERT INTO approvals VALUES (?,?,?,'PENDING',NULL,?,?)").run(id,teamRunId,prompt,now(),now());return this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id); }
  resolveApproval(id,status,response="") { this.db.prepare("UPDATE approvals SET status=?,response=?,updated_at=? WHERE id=?").run(status,response,now(),id);return this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id); }

  // ── Providers ──────────────────────────────────────────────────
  createProvider({ name, baseUrl, apiKey, model, setActive = false }) {
    const id = randomUUID();
    if (setActive) this.db.prepare("UPDATE providers SET is_active = 0").run();
    this.db
      .prepare(
        "INSERT INTO providers (id, name, base_url, api_key, model, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, name, baseUrl, apiKey, model, setActive ? 1 : 0, now());
    return this.getProvider(id);
  }

  getProvider(id) {
    return this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id);
  }

  getActiveProvider() {
    return this.db.prepare("SELECT * FROM providers WHERE is_active = 1 LIMIT 1").get();
  }

  listProviders() {
    return this.db.prepare("SELECT * FROM providers ORDER BY created_at ASC").all();
  }

  updateProvider(id, patch) {
    const row = this.getProvider(id);
    if (!row) return null;
    this.db
      .prepare("UPDATE providers SET name=?, base_url=?, api_key=?, model=? WHERE id=?")
      .run(
        patch.name ?? row.name,
        patch.baseUrl ?? row.base_url,
        patch.apiKey ?? row.api_key,
        patch.model ?? row.model,
        id
      );
    return this.getProvider(id);
  }

  setActiveProvider(id) {
    this.db.prepare("UPDATE providers SET is_active = 0").run();
    if (id) this.db.prepare("UPDATE providers SET is_active = 1 WHERE id = ?").run(id);
  }

  deleteProvider(id) {
    this.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  }

  // ── Sessions / Traces ────────────────────────────────────────────
  createSession({ cardId, boardId, lane, specialistId, specialistName, provider }) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, card_id, board_id, lane, specialist_id, specialist_name, provider, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`
      )
      .run(id, cardId, boardId, lane, specialistId, specialistName, provider, now());
    return id;
  }

  finishSession(id, { status, verdict, summary }) {
    this.db
      .prepare("UPDATE sessions SET status=?, verdict=?, summary=?, finished_at=? WHERE id=?")
      .run(status, verdict ?? null, summary ?? null, now(), id);
  }

  requestSessionCancel(id) { this.db.prepare("UPDATE sessions SET cancel_requested=1 WHERE id=? AND status='ACTIVE'").run(id); return this.getSession(id); }
  isSessionCancelRequested(id) { return this.db.prepare("SELECT cancel_requested FROM sessions WHERE id=?").get(id)?.cancel_requested===1; }

  trace(sessionId, seq, kind, message, data) {
    this.db
      .prepare("INSERT INTO traces (session_id, seq, kind, message, data, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sessionId, seq, kind, message, data ? JSON.stringify(data) : null, now());
  }

  listSessionsForCard(cardId) {
    return this.db
      .prepare("SELECT * FROM sessions WHERE card_id = ? ORDER BY started_at DESC")
      .all(cardId);
  }

  listSessionsForBoard(boardId, limit = 50) {
    return this.db
      .prepare("SELECT * FROM sessions WHERE board_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(boardId, limit);
  }

  getSession(id) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  }

  listTraces(sessionId) {
    return this.db
      .prepare("SELECT * FROM traces WHERE session_id = ? ORDER BY seq ASC")
      .all(sessionId)
      .map((t) => ({ ...t, data: t.data ? JSON.parse(t.data) : null }));
  }
}
