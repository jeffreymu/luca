/**
 * LucaPi persistence layer — node:sqlite (zero dependencies).
 * Workspaces own boards, cards, auditable sessions, durable jobs and platform configuration.
 */
import { DatabaseSync } from "node:sqlite";
import { nextCronDate } from "./scheduler.js";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";

class SecretCodec {
  constructor(secret) { this.key=secret?scryptSync(secret,"lucapi-local-secrets",32):null;this.enabled=Boolean(this.key); }
  encode(value) { if(!value||!this.key||String(value).startsWith("enc:v1:"))return value;const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.key,iv),encrypted=Buffer.concat([cipher.update(String(value),"utf8"),cipher.final()]);return`enc:v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`; }
  decode(value) { if(!value||!String(value).startsWith("enc:v1:"))return value;if(!this.key)throw new Error("Encrypted secret requires LUCAPI_SECRET_KEY");const[, ,iv,tag,data]=String(value).split(":"),decipher=createDecipheriv("aes-256-gcm",this.key,Buffer.from(iv,"base64"));decipher.setAuthTag(Buffer.from(tag,"base64"));return Buffer.concat([decipher.update(Buffer.from(data,"base64")),decipher.final()]).toString("utf8"); }
}

export function openDb(dbPath = "lucapi.db") {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
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
    CREATE TABLE IF NOT EXISTS execution_leases (
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      lease_until TEXT NOT NULL,
      PRIMARY KEY(resource_type, resource_id)
    );
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      job_id TEXT,
      status TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS skill_versions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest TEXT NOT NULL,
      content TEXT NOT NULL,
      checksum TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_uri TEXT,
      source_ref TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      created_at TEXT NOT NULL,
      published_at TEXT,
      UNIQUE(skill_id, version)
    );
    CREATE TABLE IF NOT EXISTS scan_profiles (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      hook TEXT NOT NULL DEFAULT 'review',
      scanners TEXT NOT NULL,
      policy TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      card_id TEXT,
      profile_id TEXT,
      status TEXT NOT NULL,
      base_commit TEXT,
      head_commit TEXT,
      summary TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS scan_suppressions (
      workspace_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(workspace_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS scan_findings (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      scanner TEXT NOT NULL,
      rule_id TEXT,
      severity TEXT NOT NULL,
      category TEXT,
      file TEXT,
      start_line INTEGER,
      end_line INTEGER,
      message TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      is_new INTEGER NOT NULL DEFAULT 1,
      suppressed INTEGER NOT NULL DEFAULT 0,
      raw TEXT,
      created_at TEXT NOT NULL
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
    CREATE TABLE IF NOT EXISTS operation_approvals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      resource_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'PENDING',
      response TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consumed_at TEXT
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
    CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_scan_profiles_workspace_hook ON scan_profiles(workspace_id, hook, enabled);
    CREATE INDEX IF NOT EXISTS idx_scan_runs_workspace ON scan_runs(workspace_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_scan_findings_run ON scan_findings(run_id, severity);
    CREATE INDEX IF NOT EXISTS idx_scan_findings_fingerprint ON scan_findings(fingerprint);
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
    "ALTER TABLE sessions ADD COLUMN agent_id TEXT",
    "ALTER TABLE team_runs ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN worker_id TEXT",
    "ALTER TABLE webhook_configs ADD COLUMN filters TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE schedules ADD COLUMN concurrency_policy TEXT NOT NULL DEFAULT 'FORBID'",
    "ALTER TABLE schedules ADD COLUMN cron_expression TEXT",
    "ALTER TABLE schedules ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'",
    "ALTER TABLE schedules ADD COLUMN lease_until TEXT",
    "ALTER TABLE schedules ADD COLUMN worker_id TEXT",
    "ALTER TABLE skills ADD COLUMN current_version TEXT NOT NULL DEFAULT '1.0.0'",
    "ALTER TABLE skills ADD COLUMN status TEXT NOT NULL DEFAULT 'PUBLISHED'",
    "ALTER TABLE skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE skills ADD COLUMN manifest TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE skills ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE skills ADD COLUMN source_uri TEXT",
    "ALTER TABLE skills ADD COLUMN checksum TEXT",
    "ALTER TABLE skill_versions ADD COLUMN validation_result TEXT",
  ]) {
    try {
      db.exec(ddl);
    } catch (err) {
      if(!String(err.message).includes("duplicate column name"))throw err;
    }
  }
  db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)").run(1,"initial-schema",new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)").run(2,"autonomous-platform-hardening",new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)").run(3,"production-hardening",new Date().toISOString());
  db.prepare("INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)").run(4,"versioned-skills-and-scanning",new Date().toISOString());
  db.exec("PRAGMA user_version = 4");
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
  constructor(db, {secretKey=process.env.LUCAPI_SECRET_KEY} = {}) {
    this.db = db;
    this.secrets = new SecretCodec(secretKey);
    if(this.secrets.enabled){
      for(const row of db.prepare("SELECT id,api_key FROM providers").all())if(row.api_key&&!row.api_key.startsWith("enc:v1:"))db.prepare("UPDATE providers SET api_key=? WHERE id=?").run(this.secrets.encode(row.api_key),row.id);
      for(const row of db.prepare("SELECT id,github_token FROM workspaces").all())if(row.github_token&&!row.github_token.startsWith("enc:v1:"))db.prepare("UPDATE workspaces SET github_token=? WHERE id=?").run(this.secrets.encode(row.github_token),row.id);
      for(const row of db.prepare("SELECT id,secret FROM webhook_configs").all())if(row.secret&&!row.secret.startsWith("enc:v1:"))db.prepare("UPDATE webhook_configs SET secret=? WHERE id=?").run(this.secrets.encode(row.secret),row.id);
      for(const row of db.prepare("SELECT id,config FROM scan_profiles").all()){const config=JSON.parse(row.config||"{}"),token=config.sonarqube?.token;if(token&&!token.startsWith("enc:v1:")){config.sonarqube.token=this.secrets.encode(token);db.prepare("UPDATE scan_profiles SET config=? WHERE id=?").run(JSON.stringify(config),row.id);}}
    }
  }

  schemaInfo(){return{userVersion:this.db.prepare("PRAGMA user_version").get().user_version,migrations:this.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()};}
  backup(filePath){if(!filePath||!String(filePath).endsWith(".db"))throw new Error("backup path must end with .db");const escaped=String(filePath).replaceAll("'","''");this.db.exec(`VACUUM INTO '${escaped}'`);return{path:filePath,createdAt:now()};}

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
    return this.db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC").all().map((w)=>({...w,github_token:this.secrets.decode(w.github_token)}));
  }

  getWorkspace(id) {
    const w=this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);return w?{...w,github_token:this.secrets.decode(w.github_token)}:w;
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
        this.secrets.encode(patch.githubToken ? patch.githubToken : row.github_token),
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
    const w=this.db.prepare("SELECT w.* FROM workspaces w JOIN boards b ON b.workspace_id=w.id WHERE b.id=?").get(boardId);return w?{...w,github_token:this.secrets.decode(w.github_token)}:w;
  }

  deleteWorkspace(id) {
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const boards=this.db.prepare("SELECT id FROM boards WHERE workspace_id=?").all(id);
      for(const b of boards){for(const c of this.db.prepare("SELECT id FROM cards WHERE board_id=?").all(b.id))this.deleteCard(c.id);this.db.prepare("DELETE FROM boards WHERE id=?").run(b.id);}
      for(const hook of this.db.prepare("SELECT id FROM webhook_configs WHERE workspace_id=?").all(id))this.db.prepare("DELETE FROM webhook_logs WHERE config_id=?").run(hook.id);
      for(const run of this.db.prepare("SELECT id FROM team_runs WHERE workspace_id=?").all(id)){this.db.prepare("DELETE FROM team_messages WHERE team_run_id=?").run(run.id);this.db.prepare("DELETE FROM approvals WHERE team_run_id=?").run(run.id);}
      for(const schedule of this.db.prepare("SELECT id FROM schedules WHERE workspace_id=?").all(id))this.db.prepare("DELETE FROM schedule_runs WHERE schedule_id=?").run(schedule.id);
      for(const run of this.db.prepare("SELECT id FROM scan_runs WHERE workspace_id=?").all(id))this.db.prepare("DELETE FROM scan_findings WHERE run_id=?").run(run.id);
      for(const skill of this.db.prepare("SELECT id FROM skills WHERE workspace_id=?").all(id))this.db.prepare("DELETE FROM skill_versions WHERE skill_id=?").run(skill.id);
      for(const table of ["jobs","workflows","schedules","skills","scan_profiles","scan_runs","scan_suppressions","webhook_configs","agents","team_runs","operation_approvals"])this.db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(id);
      this.db.prepare("DELETE FROM workspaces WHERE id=?").run(id);this.db.exec("COMMIT");
    }catch(err){this.db.exec("ROLLBACK");throw err;}
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
    const card=this.getCard(id);
    if(card)for(const dependent of this.listCards(card.board_id).filter((c)=>c.id!==id&&c.dependencies.includes(id)))this.updateCard(dependent.id,{dependencies:dependent.dependencies.filter((dependency)=>dependency!==id)});
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

  claimJob(leaseMs = 120_000, workerId = null) {
    this.recoverExpiredJobs();
    const timestamp=now(), leaseUntil = new Date(Date.now() + leaseMs).toISOString();
    const row=this.db.prepare(
      `UPDATE jobs SET status='RUNNING',attempts=attempts+1,lease_until=?,updated_at=?,worker_id=?
       WHERE id=(SELECT id FROM jobs WHERE status='PENDING' AND run_after<=? ORDER BY priority DESC,created_at ASC LIMIT 1)
       AND status='PENDING' RETURNING *`
    ).get(leaseUntil,timestamp,workerId,timestamp);
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

  retryJob(id) { const job=this.getJob(id);if(!job||!["FAILED","CANCELLED"].includes(job.status))return null;this.db.prepare("UPDATE jobs SET status='PENDING',error=NULL,attempts=0,run_after=?,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=?").run(now(),now(),id);return this.getJob(id); }
  releaseJobLease(id,{delayMs=0,refundAttempt=false}={}) { this.db.prepare(`UPDATE jobs SET status='PENDING',lease_until=NULL,worker_id=NULL,run_after=?,attempts=MAX(0,attempts-?),updated_at=? WHERE id=? AND status='RUNNING'`).run(new Date(Date.now()+delayMs).toISOString(),refundAttempt?1:0,now(),id);return this.getJob(id); }
  cancelJob(id) {
    const job=this.getJob(id);
    this.db.prepare("UPDATE jobs SET status='CANCELLED', lease_until=NULL, updated_at=? WHERE id=? AND status IN ('PENDING','RUNNING')")
      .run(now(), id);
    if(job?.card_id) this.db.prepare("UPDATE sessions SET cancel_requested=1 WHERE card_id=? AND status='ACTIVE'").run(job.card_id);
    return this.getJob(id);
  }

  acquireExecutionLease(resourceType,resourceId,workerId,leaseMs=120_000){const until=new Date(Date.now()+leaseMs).toISOString(),timestamp=now();return this.db.prepare(`INSERT INTO execution_leases VALUES (?,?,?,?) ON CONFLICT(resource_type,resource_id) DO UPDATE SET worker_id=excluded.worker_id,lease_until=excluded.lease_until WHERE execution_leases.lease_until<? RETURNING *`).get(resourceType,resourceId,workerId,until,timestamp);}
  renewExecutionLease(resourceType,resourceId,workerId,leaseMs=120_000){return this.db.prepare("UPDATE execution_leases SET lease_until=? WHERE resource_type=? AND resource_id=? AND worker_id=?").run(new Date(Date.now()+leaseMs).toISOString(),resourceType,resourceId,workerId).changes===1;}
  releaseExecutionLease(resourceType,resourceId,workerId){this.db.prepare("DELETE FROM execution_leases WHERE resource_type=? AND resource_id=? AND worker_id=?").run(resourceType,resourceId,workerId);}

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
  updateWorkflow(id,patch){const w=this.getWorkflow(id);if(!w)return null;this.db.prepare("UPDATE workflows SET name=?,definition=?,updated_at=? WHERE id=?").run(patch.name??w.name,JSON.stringify(patch.definition??w.definition),now(),id);return this.getWorkflow(id);}
  deleteWorkflow(id) { this.db.prepare("DELETE FROM workflows WHERE id=?").run(id); }

  createSchedule({ workspaceId, workflowId, name, intervalMinutes = 0, cronExpression = null, timezone = "UTC", concurrencyPolicy = "FORBID" }) {
    const id=randomUUID(),next=(cronExpression?nextCronDate(cronExpression,timezone):new Date(Date.now()+intervalMinutes*60_000)).toISOString();
    this.db.prepare("INSERT INTO schedules (id,workspace_id,workflow_id,name,interval_minutes,enabled,next_run_at,last_run_at,created_at,concurrency_policy,cron_expression,timezone) VALUES (?,?,?,?,?,1,?,?,?, ?,?,?)").run(id,workspaceId,workflowId,name,intervalMinutes,next,null,now(),concurrencyPolicy,cronExpression,timezone);
    return this.getSchedule(id);
  }
  getSchedule(id){return this.db.prepare("SELECT * FROM schedules WHERE id=?").get(id);}
  listSchedules(workspaceId) { return this.db.prepare("SELECT * FROM schedules WHERE workspace_id=? ORDER BY created_at").all(workspaceId); }
  dueSchedules() { return this.db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at <= ? AND (lease_until IS NULL OR lease_until < ?)").all(now(),now()); }
  claimDueSchedule(workerId,leaseMs=120_000){const timestamp=now(),leaseUntil=new Date(Date.now()+leaseMs).toISOString();return this.db.prepare(`UPDATE schedules SET lease_until=?,worker_id=? WHERE id=(SELECT id FROM schedules WHERE enabled=1 AND next_run_at<=? AND (lease_until IS NULL OR lease_until<?) ORDER BY next_run_at LIMIT 1) AND (lease_until IS NULL OR lease_until<?) RETURNING *`).get(leaseUntil,workerId,timestamp,timestamp,timestamp);}
  updateSchedule(id,patch){const s=this.getSchedule(id);if(!s)return null;const enabled=patch.enabled===undefined?s.enabled:patch.enabled?1:0,cron=patch.cronExpression===undefined?s.cron_expression:patch.cronExpression,timezone=patch.timezone??s.timezone,interval=patch.intervalMinutes??s.interval_minutes,next=enabled?(cron?nextCronDate(cron,timezone).toISOString():new Date(Date.now()+interval*60_000).toISOString()):s.next_run_at;this.db.prepare("UPDATE schedules SET name=?,interval_minutes=?,enabled=?,next_run_at=?,concurrency_policy=?,cron_expression=?,timezone=? WHERE id=?").run(patch.name??s.name,interval,enabled,next,patch.concurrencyPolicy??s.concurrency_policy,cron,timezone,id);return this.getSchedule(id);}
  deleteSchedule(id){this.db.prepare("DELETE FROM schedules WHERE id=?").run(id);}
  markScheduleRun(id) { const s=this.getSchedule(id),next=s.cron_expression?nextCronDate(s.cron_expression,s.timezone).toISOString():new Date(Date.now()+s.interval_minutes*60_000).toISOString();this.db.prepare("UPDATE schedules SET last_run_at=?,next_run_at=?,lease_until=NULL,worker_id=NULL WHERE id=?").run(now(),next,id); }
  activeScheduleJobs(id){return this.db.prepare("SELECT * FROM jobs WHERE status IN ('PENDING','RUNNING') AND json_extract(payload,'$.scheduleId')=?").all(id).map((r)=>parseJsonColumns(r,["payload"]));}
  logScheduleRun(scheduleId,jobId,status){const id=randomUUID();this.db.prepare("INSERT INTO schedule_runs VALUES (?,?,?,?,?)").run(id,scheduleId,jobId,status,now());return id;}
  updateScheduleRunByJob(jobId,status){this.db.prepare("UPDATE schedule_runs SET status=? WHERE job_id=?").run(status,jobId);}
  listScheduleRuns(scheduleId){return this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY created_at DESC LIMIT 100").all(scheduleId);}

  createSkill({ workspaceId = null, name, description = "", instructions, tools = [], version="1.0.0", status="PUBLISHED", manifest={}, sourceType="manual", sourceUri=null, sourceRef=null, checksum=null, content=null }) {
    const id=randomUUID(),timestamp=now();
    this.db.prepare(`INSERT INTO skills (id,workspace_id,name,description,instructions,tools,created_at,updated_at,current_version,status,enabled,manifest,source_type,source_uri,checksum) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(id,workspaceId,name,description,instructions,JSON.stringify(tools),timestamp,timestamp,version,status,JSON.stringify(manifest),sourceType,sourceUri,checksum);
    if(content!==null)this.addSkillVersion({skillId:id,version,manifest,content,checksum:checksum??"",sourceType,sourceUri,sourceRef,status});
    return this.getSkill(id);
  }
  findSkillByName(workspaceId,name){return parseJsonColumns(this.db.prepare("SELECT * FROM skills WHERE workspace_id=? AND name=? ORDER BY created_at LIMIT 1").get(workspaceId,name),["tools","manifest"]);}
  getSkill(id){return parseJsonColumns(this.db.prepare("SELECT * FROM skills WHERE id=?").get(id),["tools","manifest"]);}
  listSkills(workspaceId,{publishedOnly=true}={}) { let sql="SELECT * FROM skills WHERE (workspace_id IS NULL OR workspace_id=?)";if(publishedOnly)sql+=" AND status='PUBLISHED' AND enabled=1";sql+=" ORDER BY name";return this.db.prepare(sql).all(workspaceId).map((r)=>parseJsonColumns(r,["tools","manifest"])); }
  updateSkill(id,patch){const s=this.getSkill(id);if(!s)return null;const enabled=patch.enabled===undefined?s.enabled:patch.enabled?1:0;this.db.prepare("UPDATE skills SET name=?,description=?,instructions=?,tools=?,enabled=?,manifest=?,updated_at=? WHERE id=?").run(patch.name??s.name,patch.description??s.description,patch.instructions??s.instructions,JSON.stringify(patch.tools??s.tools),enabled,JSON.stringify(patch.manifest??s.manifest),now(),id);for(const profile of this.listScanProfiles(s.workspace_id).filter((p)=>p.config?.skillId===id))this.updateScanProfile(profile.id,{enabled:Boolean(enabled)});return this.getSkill(id);}
  addSkillVersion({skillId,version,manifest,content,checksum,sourceType,sourceUri=null,sourceRef=null,status="DRAFT"}){const id=randomUUID();this.db.prepare("INSERT INTO skill_versions (id,skill_id,version,manifest,content,checksum,source_type,source_uri,source_ref,status,created_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)").run(id,skillId,version,JSON.stringify(manifest),content,checksum,sourceType,sourceUri,sourceRef,status,now());return this.getSkillVersion(id);}
  getSkillVersion(id){return parseJsonColumns(this.db.prepare("SELECT * FROM skill_versions WHERE id=?").get(id),["manifest","validation_result"]);}
  setSkillVersionValidation(id,result){this.db.prepare("UPDATE skill_versions SET validation_result=? WHERE id=?").run(JSON.stringify(result),id);return this.getSkillVersion(id);}
  getPublishedSkillPackage(skillId){const skill=this.getSkill(skillId);if(!skill?.current_version)return null;const version=this.db.prepare("SELECT * FROM skill_versions WHERE skill_id=? AND version=? AND status='PUBLISHED' ORDER BY published_at DESC LIMIT 1").get(skillId,skill.current_version);if(!version)return null;try{return JSON.parse(version.content);}catch{return null;}}
  listSkillVersions(skillId){return this.db.prepare("SELECT * FROM skill_versions WHERE skill_id=? ORDER BY created_at DESC, rowid DESC").all(skillId).map((r)=>parseJsonColumns(r,["manifest"]));}
  publishSkillVersion(versionId){const version=this.getSkillVersion(versionId);if(!version)return null;const timestamp=now();this.db.prepare("UPDATE skill_versions SET status='PUBLISHED',published_at=? WHERE id=?").run(timestamp,versionId);this.db.prepare("UPDATE skill_versions SET status='ARCHIVED' WHERE skill_id=? AND id<>? AND status='PUBLISHED'").run(version.skill_id,versionId);this.db.prepare("UPDATE skills SET current_version=?,status='PUBLISHED',manifest=?,checksum=?,source_type=?,source_uri=?,updated_at=? WHERE id=?").run(version.version,JSON.stringify(version.manifest),version.checksum,version.source_type,version.source_uri,timestamp,version.skill_id);return this.getSkill(version.skill_id);}
  deleteSkill(id) { const skill=this.getSkill(id);if(skill)for(const profile of this.listScanProfiles(skill.workspace_id).filter((p)=>p.config?.skillId===id))this.deleteScanProfile(profile.id);this.db.prepare("DELETE FROM skill_versions WHERE skill_id=?").run(id);this.db.prepare("DELETE FROM skills WHERE id=?").run(id); }

  encodeScanConfig(config={}){const copy=structuredClone(config);if(copy.sonarqube?.token)copy.sonarqube.token=this.secrets.encode(copy.sonarqube.token);return copy;}
  decodeScanProfile(row){const p=parseJsonColumns(row,["scanners","policy","config"]);if(p?.config?.sonarqube?.token)p.config.sonarqube.token=this.secrets.decode(p.config.sonarqube.token);return p;}
  createScanProfile({workspaceId,name,hook="review",scanners=[],policy={},config={},enabled=true}){const id=randomUUID(),timestamp=now();this.db.prepare("INSERT INTO scan_profiles VALUES (?,?,?,?,?,?,?,?,?,?)").run(id,workspaceId,name,hook,JSON.stringify(scanners),JSON.stringify(policy),JSON.stringify(this.encodeScanConfig(config)),enabled?1:0,timestamp,timestamp);return this.getScanProfile(id);}
  getScanProfile(id){return this.decodeScanProfile(this.db.prepare("SELECT * FROM scan_profiles WHERE id=?").get(id));}
  listScanProfiles(workspaceId,{hook,enabledOnly=false}={}){let sql="SELECT * FROM scan_profiles WHERE workspace_id=?",args=[workspaceId];if(hook){sql+=" AND hook=?";args.push(hook);}if(enabledOnly)sql+=" AND enabled=1";sql+=" ORDER BY created_at";return this.db.prepare(sql).all(...args).map((r)=>this.decodeScanProfile(r));}
  updateScanProfile(id,patch){const p=this.getScanProfile(id);if(!p)return null;const config=patch.config??p.config;this.db.prepare("UPDATE scan_profiles SET name=?,hook=?,scanners=?,policy=?,config=?,enabled=?,updated_at=? WHERE id=?").run(patch.name??p.name,patch.hook??p.hook,JSON.stringify(patch.scanners??p.scanners),JSON.stringify(patch.policy??p.policy),JSON.stringify(this.encodeScanConfig(config)),patch.enabled===undefined?p.enabled:patch.enabled?1:0,now(),id);return this.getScanProfile(id);}
  deleteScanProfile(id){this.db.prepare("DELETE FROM scan_profiles WHERE id=?").run(id);}
  createScanRun({workspaceId,cardId=null,profileId=null,baseCommit=null,headCommit=null}){const id=randomUUID();this.db.prepare("INSERT INTO scan_runs (id,workspace_id,card_id,profile_id,status,base_commit,head_commit,started_at) VALUES (?,?,?,?,'RUNNING',?,?,?)").run(id,workspaceId,cardId,profileId,baseCommit,headCommit,now());return this.getScanRun(id);}
  finishScanRun(id,status,summary={}){this.db.prepare("UPDATE scan_runs SET status=?,summary=?,finished_at=? WHERE id=?").run(status,JSON.stringify(summary),now(),id);return this.getScanRun(id);}
  addScanFinding(runId,finding){const id=randomUUID();this.db.prepare("INSERT INTO scan_findings VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,runId,finding.scanner,finding.ruleId??null,finding.severity,finding.category??null,finding.file??null,finding.startLine??null,finding.endLine??null,finding.message,finding.fingerprint,finding.isNew===false?0:1,finding.suppressed?1:0,JSON.stringify(finding.raw??null),now());return id;}
  getScanRun(id){const run=parseJsonColumns(this.db.prepare("SELECT * FROM scan_runs WHERE id=?").get(id),["summary"]);return run?{...run,findings:this.listScanFindings(id)}:null;}
  listScanRuns(workspaceId,{cardId,limit=100}={}){let sql="SELECT * FROM scan_runs WHERE workspace_id=?",args=[workspaceId];if(cardId){sql+=" AND card_id=?";args.push(cardId);}sql+=" ORDER BY started_at DESC LIMIT ?";args.push(limit);return this.db.prepare(sql).all(...args).map((r)=>parseJsonColumns(r,["summary"]));}
  knownScanFingerprints(profileId,excludeRunId){return new Set(this.db.prepare("SELECT DISTINCT f.fingerprint FROM scan_findings f JOIN scan_runs r ON r.id=f.run_id WHERE r.profile_id=? AND r.id<>? AND r.status='PASSED'").all(profileId,excludeRunId).map((r)=>r.fingerprint));}
  listScanFindings(runId){return this.db.prepare("SELECT * FROM scan_findings WHERE run_id=? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,file,start_line").all(runId).map((f)=>({...f,raw:JSON.parse(f.raw||"null")}));}
  suppressedScanFingerprints(workspaceId){return new Set(this.db.prepare("SELECT fingerprint FROM scan_suppressions WHERE workspace_id=?").all(workspaceId).map((r)=>r.fingerprint));}
  suppressScanFinding(id,suppressed=true,reason=""){const f=this.db.prepare("SELECT f.*,r.workspace_id FROM scan_findings f JOIN scan_runs r ON r.id=f.run_id WHERE f.id=?").get(id);if(!f)return null;this.db.prepare("UPDATE scan_findings SET suppressed=? WHERE id=?").run(suppressed?1:0,id);if(suppressed)this.db.prepare("INSERT INTO scan_suppressions VALUES (?,?,?,?) ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET reason=excluded.reason").run(f.workspace_id,f.fingerprint,reason,now());else this.db.prepare("DELETE FROM scan_suppressions WHERE workspace_id=? AND fingerprint=?").run(f.workspace_id,f.fingerprint);return this.db.prepare("SELECT * FROM scan_findings WHERE id=?").get(id);}

  createWebhook({ workspaceId, workflowId, event, secret = null, filters = {} }) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO webhook_configs (id,workspace_id,workflow_id,event,secret,enabled,created_at,filters) VALUES (?,?,?,?,?,1,?,?)").run(id, workspaceId, workflowId, event, this.secrets.encode(secret), now(),JSON.stringify(filters));
    return {...this.db.prepare("SELECT * FROM webhook_configs WHERE id=?").get(id),secret,filters};
  }
  getWebhook(id){const c=this.db.prepare("SELECT * FROM webhook_configs WHERE id=?").get(id);return c?{...c,secret:this.secrets.decode(c.secret),filters:JSON.parse(c.filters||"{}")} : null;}
  listWebhooks(workspaceId) { return this.db.prepare("SELECT * FROM webhook_configs WHERE workspace_id=? ORDER BY created_at").all(workspaceId).map((c)=>({...c,secret:this.secrets.decode(c.secret),filters:JSON.parse(c.filters||"{}")})); }
  updateWebhook(id,patch){const c=this.getWebhook(id);if(!c)return null;this.db.prepare("UPDATE webhook_configs SET workflow_id=?,event=?,secret=?,enabled=?,filters=? WHERE id=?").run(patch.workflowId??c.workflow_id,patch.event??c.event,this.secrets.encode(patch.secret||c.secret),patch.enabled===undefined?c.enabled:patch.enabled?1:0,JSON.stringify(patch.filters??c.filters),id);return this.getWebhook(id);}
  matchingWebhooks(workspaceId, event) { return this.db.prepare("SELECT * FROM webhook_configs WHERE workspace_id=? AND event=? AND enabled=1").all(workspaceId,event).map((c)=>({...c,secret:this.secrets.decode(c.secret),filters:JSON.parse(c.filters||"{}")})); }
  logWebhook({ configId, event, deliveryId, status, payload, error = null }) {
    const id=randomUUID(); this.db.prepare("INSERT INTO webhook_logs VALUES (?,?,?,?,?,?,?,?)").run(id,configId,event,deliveryId,status,JSON.stringify(payload),error,now()); return id;
  }
  hasAcceptedWebhook(configId,deliveryId){return Boolean(deliveryId&&this.db.prepare("SELECT 1 FROM webhook_logs WHERE config_id=? AND delivery_id=? AND status='ACCEPTED'").get(configId,deliveryId));}
  listWebhookLogs(workspaceId,limit=100){return this.db.prepare("SELECT l.* FROM webhook_logs l JOIN webhook_configs c ON c.id=l.config_id WHERE c.workspace_id=? ORDER BY l.created_at DESC LIMIT ?").all(workspaceId,limit).map((l)=>({...l,payload:JSON.parse(l.payload||"{}")}));}

  // ── Multi-agent team coordination ──────────────────────────────
  createAgent({ workspaceId, name, role, providerId = null, parentId = null, metadata = {} }) {
    const id=randomUUID(); this.db.prepare("INSERT INTO agents VALUES (?,?,?,?,?,?,'IDLE',?,?,?)").run(id,workspaceId,name,role,providerId,parentId,JSON.stringify(metadata),now(),now()); return this.getAgent(id);
  }
  getAgent(id) { return parseJsonColumns(this.db.prepare("SELECT * FROM agents WHERE id=?").get(id),["metadata"]); }
  listAgents(workspaceId) { return this.db.prepare("SELECT * FROM agents WHERE workspace_id=? ORDER BY created_at").all(workspaceId).map((r)=>parseJsonColumns(r,["metadata"])); }
  updateAgentStatus(id,status) { this.db.prepare("UPDATE agents SET status=?,updated_at=? WHERE id=?").run(status,now(),id); return this.getAgent(id); }
  updateAgent(id,patch) { const a=this.getAgent(id);if(!a)return null;this.db.prepare("UPDATE agents SET name=?,role=?,provider_id=?,parent_id=?,metadata=?,updated_at=? WHERE id=?").run(patch.name??a.name,patch.role??a.role,patch.providerId!==undefined?patch.providerId:a.provider_id,patch.parentId!==undefined?patch.parentId:a.parent_id,JSON.stringify(patch.metadata??a.metadata),now(),id);return this.getAgent(id); }
  deleteAgent(id) { this.db.prepare("DELETE FROM agents WHERE id=?").run(id); }
  createTeamRun({workspaceId,boardId,goal,maxConcurrency=2,approvalRequired=false}) { const id=randomUUID();this.db.prepare("INSERT INTO team_runs (id,workspace_id,board_id,goal,status,max_concurrency,created_at,updated_at,approval_required) VALUES (?,?,?,?,'PENDING',?,?,?,?)").run(id,workspaceId,boardId,goal,maxConcurrency,now(),now(),approvalRequired?1:0);return this.getTeamRun(id); }
  updateTeamRunStatus(id,status) { this.db.prepare("UPDATE team_runs SET status=?,updated_at=? WHERE id=?").run(status,now(),id); return this.getTeamRun(id); }
  getTeamRun(id) { const run=this.db.prepare("SELECT * FROM team_runs WHERE id=?").get(id);if(!run)return null;return {...run,messages:this.db.prepare("SELECT * FROM team_messages WHERE team_run_id=? ORDER BY created_at").all(id),approvals:this.db.prepare("SELECT * FROM approvals WHERE team_run_id=? ORDER BY created_at").all(id)}; }
  listTeamRuns(workspaceId) { return this.db.prepare("SELECT * FROM team_runs WHERE workspace_id=? ORDER BY created_at DESC").all(workspaceId); }
  addTeamMessage({teamRunId,agentId=null,role,content}) { const id=randomUUID();this.db.prepare("INSERT INTO team_messages VALUES (?,?,?,?,?,?)").run(id,teamRunId,agentId,role,content,now());return this.db.prepare("SELECT * FROM team_messages WHERE id=?").get(id); }
  createApproval({teamRunId,prompt}) { const id=randomUUID();this.db.prepare("INSERT INTO approvals VALUES (?,?,?,'PENDING',NULL,?,?)").run(id,teamRunId,prompt,now(),now());return this.getApproval(id); }
  getApproval(id) { return this.db.prepare("SELECT * FROM approvals WHERE id=?").get(id); }
  resolveApproval(id,status,response="") { this.db.prepare("UPDATE approvals SET status=?,response=?,updated_at=? WHERE id=? AND status='PENDING'").run(status,response,now(),id);return this.getApproval(id); }

  createOperationApproval({workspaceId,operation,resourceId=null,payload={}}){const id=randomUUID();this.db.prepare("INSERT INTO operation_approvals (id,workspace_id,operation,resource_id,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,'PENDING',?,?)").run(id,workspaceId,operation,resourceId,JSON.stringify(payload),now(),now());return this.getOperationApproval(id);}
  getOperationApproval(id){return parseJsonColumns(this.db.prepare("SELECT * FROM operation_approvals WHERE id=?").get(id),["payload"]);}
  listOperationApprovals(workspaceId){return this.db.prepare("SELECT * FROM operation_approvals WHERE workspace_id=? ORDER BY created_at DESC").all(workspaceId).map((r)=>parseJsonColumns(r,["payload"]));}
  resolveOperationApproval(id,status,response=""){this.db.prepare("UPDATE operation_approvals SET status=?,response=?,updated_at=? WHERE id=? AND status='PENDING'").run(status,response,now(),id);return this.getOperationApproval(id);}
  consumeOperationApproval(id,operation,resourceId){if(!id)return false;return this.db.prepare("UPDATE operation_approvals SET consumed_at=?,updated_at=? WHERE id=? AND operation=? AND (resource_id=? OR resource_id IS NULL) AND status='APPROVED' AND consumed_at IS NULL").run(now(),now(),id,operation,resourceId).changes===1;}
  consumeNextOperationApproval(workspaceId,operation,resourceId){const row=this.db.prepare("SELECT id FROM operation_approvals WHERE workspace_id=? AND operation=? AND (resource_id=? OR resource_id IS NULL) AND status='APPROVED' AND consumed_at IS NULL ORDER BY created_at LIMIT 1").get(workspaceId,operation,resourceId);return row?this.consumeOperationApproval(row.id,operation,resourceId):false;}

  // ── Providers ──────────────────────────────────────────────────
  createProvider({ name, baseUrl, apiKey, model, setActive = false }) {
    const id = randomUUID();
    if (setActive) this.db.prepare("UPDATE providers SET is_active = 0").run();
    this.db
      .prepare(
        "INSERT INTO providers (id, name, base_url, api_key, model, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, name, baseUrl, this.secrets.encode(apiKey), model, setActive ? 1 : 0, now());
    return this.getProvider(id);
  }

  getProvider(id) {
    const p=this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id);return p?{...p,api_key:this.secrets.decode(p.api_key)}:p;
  }

  getActiveProvider() {
    const p=this.db.prepare("SELECT * FROM providers WHERE is_active = 1 LIMIT 1").get();return p?{...p,api_key:this.secrets.decode(p.api_key)}:p;
  }

  listProviders() {
    return this.db.prepare("SELECT * FROM providers ORDER BY created_at ASC").all().map((p)=>({...p,api_key:this.secrets.decode(p.api_key)}));
  }

  updateProvider(id, patch) {
    const row = this.getProvider(id);
    if (!row) return null;
    this.db
      .prepare("UPDATE providers SET name=?, base_url=?, api_key=?, model=? WHERE id=?")
      .run(
        patch.name ?? row.name,
        patch.baseUrl ?? row.base_url,
        this.secrets.encode(patch.apiKey ?? row.api_key),
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
  createSession({ cardId, boardId, lane, specialistId, specialistName, provider, agentId = null }) {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, card_id, board_id, lane, specialist_id, specialist_name, provider, status, started_at, agent_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`
      )
      .run(id, cardId, boardId, lane, specialistId, specialistName, provider, now(), agentId);
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
