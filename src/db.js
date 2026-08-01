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
    CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_card ON sessions(card_id);
    CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
  `);
  // Idempotent column migrations for existing databases.
  for (const ddl of [
    "ALTER TABLE workspaces ADD COLUMN github_token TEXT",
    "ALTER TABLE workspaces ADD COLUMN github_repo TEXT",
    "ALTER TABLE workspaces ADD COLUMN github_api_base TEXT",
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
        "UPDATE workspaces SET name=?, repo_path=?, github_token=?, github_repo=?, github_api_base=? WHERE id=?"
      )
      .run(
        patch.name ?? row.name,
        patch.repoPath !== undefined ? patch.repoPath : row.repo_path,
        // empty string keeps the stored token; there is no "clear" via PATCH
        patch.githubToken ? patch.githubToken : row.github_token,
        patch.githubRepo !== undefined ? patch.githubRepo : row.github_repo,
        patch.githubApiBase !== undefined ? patch.githubApiBase : row.github_api_base,
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
  createCard({ boardId, title, objective }) {
    const id = randomUUID();
    const maxPos = this.db
      .prepare("SELECT COALESCE(MAX(position), -1) AS p FROM cards WHERE board_id = ? AND column_id = 'backlog'")
      .get(boardId).p;
    this.db
      .prepare(
        `INSERT INTO cards (id, board_id, title, objective, column_id, position, artifacts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'backlog', ?, '[]', ?, ?)`
      )
      .run(id, boardId, title, objective ?? "", maxPos + 1, now(), now());
    return this.getCard(id);
  }

  getCard(id) {
    const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id);
    if (row) row.artifacts = JSON.parse(row.artifacts);
    return row;
  }

  listCards(boardId) {
    const rows = this.db
      .prepare("SELECT * FROM cards WHERE board_id = ? ORDER BY column_id, position ASC, created_at ASC")
      .all(boardId);
    return rows.map((r) => ({ ...r, artifacts: JSON.parse(r.artifacts) }));
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
    };
    this.db
      .prepare(
        `UPDATE cards SET title=?, objective=?, column_id=?, artifacts=?, verdict=?, blocked_from=?,
         review_rejections=?, updated_at=? WHERE id=?`
      )
      .run(
        next.title,
        next.objective,
        next.column_id,
        JSON.stringify(next.artifacts),
        next.verdict,
        next.blocked_from,
        next.review_rejections,
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
    this.db.prepare("DELETE FROM cards WHERE id = ?").run(id);
  }

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
