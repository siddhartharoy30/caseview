import Database from "better-sqlite3";
import { randomUUID } from "crypto";

/**
 * Local cache and application state.
 *
 * The UI reads exclusively from here; a background sync writes it. That is what
 * makes the queue instant, search possible over full history, and a Salesforce
 * outage a staleness banner instead of an empty page.
 *
 * Migrations are additive and idempotent — every statement below is safe to run
 * against an existing database on every boot.
 */

const DB_PATH = process.env.QVIEW_DB_PATH || "/data/qview.db";

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function now(): number {
  return Date.now();
}

export function newId(): string {
  return randomUUID();
}

/* ------------------------------------------------------------------ schema */

db.exec(`
CREATE TABLE IF NOT EXISTS suggested_replies (
  id TEXT PRIMARY KEY,
  case_number TEXT NOT NULL,
  draft TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggested_replies_case ON suggested_replies(case_number);

CREATE TABLE IF NOT EXISTS cases (
  id                    TEXT PRIMARY KEY,          -- Salesforce 18-char Id
  case_number           TEXT NOT NULL UNIQUE,
  subject               TEXT,
  description           TEXT,
  status                TEXT,
  priority              TEXT,
  type                  TEXT,
  origin                TEXT,
  component             TEXT,                      -- Problem_Type__c
  sub_component         TEXT,
  account               TEXT,
  contact_name          TEXT,
  owner                 TEXT,
  owner_title           TEXT,
  labels                TEXT,
  is_escalated          INTEGER NOT NULL DEFAULT 0,
  is_closed             INTEGER NOT NULL DEFAULT 0,
  created_date          TEXT,
  last_modified_date    TEXT,
  closed_date           TEXT,
  ncc_date              TEXT,
  last_customer_update  TEXT,
  active_ttr_days       REAL,

  -- Derived during sync.
  product_area          TEXT,
  error_signature       TEXT,
  first_response_at     TEXT,
  last_my_touch         TEXT,
  last_customer_touch   TEXT,
  needs_my_reply        INTEGER NOT NULL DEFAULT 0,
  comment_count         INTEGER NOT NULL DEFAULT 0,
  comments_synced_at    INTEGER,
  synced_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_open      ON cases(is_closed, priority);
CREATE INDEX IF NOT EXISTS idx_cases_account   ON cases(account);
CREATE INDEX IF NOT EXISTS idx_cases_area      ON cases(product_area);
CREATE INDEX IF NOT EXISTS idx_cases_signature ON cases(error_signature);
CREATE INDEX IF NOT EXISTS idx_cases_modified  ON cases(last_modified_date);

CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,                   -- Salesforce Id
  case_id      TEXT NOT NULL,
  case_number  TEXT NOT NULL,
  source       TEXT NOT NULL,                      -- 'comment' | 'email'
  body         TEXT NOT NULL,
  author       TEXT,
  author_email TEXT,
  is_public    INTEGER NOT NULL DEFAULT 1,
  is_mine      INTEGER NOT NULL DEFAULT 0,
  is_inbound   INTEGER NOT NULL DEFAULT 0,         -- from the customer
  subject      TEXT,                               -- emails only
  created_date TEXT NOT NULL,
  synced_at    INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_case    ON comments(case_id, created_date);
CREATE INDEX IF NOT EXISTS idx_comments_number  ON comments(case_number, created_date);

CREATE TABLE IF NOT EXISTS commitments (
  id                TEXT PRIMARY KEY,
  case_id           TEXT NOT NULL,
  case_number       TEXT NOT NULL,
  due_at            TEXT,                          -- null => unparsed
  raw_text          TEXT NOT NULL,
  source            TEXT NOT NULL,                 -- 'parsed' | 'manual'
  source_comment_id TEXT,
  state             TEXT NOT NULL,                 -- active|met|breached|superseded|dismissed|unparsed
  superseded_by     TEXT,
  met_at            TEXT,
  note              TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_commitments_case  ON commitments(case_id);
CREATE INDEX IF NOT EXISTS idx_commitments_state ON commitments(state, due_at);
-- One parsed commitment per source sentence: re-syncing a comment must not
-- duplicate a deadline that is already recorded.
CREATE UNIQUE INDEX IF NOT EXISTS idx_commitments_dedupe
  ON commitments(case_id, source_comment_id, raw_text)
  WHERE source_comment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  case_id     TEXT NOT NULL,
  case_number TEXT NOT NULL,
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_unique ON artifacts(case_id, kind, value);
CREATE INDEX IF NOT EXISTS idx_artifacts_value ON artifacts(kind, value);

CREATE TABLE IF NOT EXISTS sync_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  watermark          TEXT,                         -- max LastModifiedDate seen
  last_success       INTEGER,
  last_attempt       INTEGER,
  last_error         TEXT,
  error_count        INTEGER NOT NULL DEFAULT 0,
  api_calls          INTEGER NOT NULL DEFAULT 0,
  running            INTEGER NOT NULL DEFAULT 0,
  last_duration_ms   INTEGER
);
INSERT OR IGNORE INTO sync_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_metrics (
  id         TEXT PRIMARY KEY,
  period     TEXT NOT NULL,                        -- e.g. '2026-Q3', '2026-08'
  metric     TEXT NOT NULL,                        -- 'csat' | 'nps' | 'iqs'
  value      REAL NOT NULL,
  note       TEXT,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_metrics ON manual_metrics(period, metric);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,                    -- deterministic, so a repeat sync cannot re-fire
  kind        TEXT NOT NULL,                       -- case.new | case.replied | commitment.due | commitment.breached
  case_number TEXT,
  title       TEXT NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL,
  delivered   INTEGER NOT NULL DEFAULT 0,          -- webhook delivery, 0 = pending
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_pending ON events(delivered, attempts);

CREATE TABLE IF NOT EXISTS iqs_scores (
  case_id        TEXT NOT NULL,
  layer          TEXT NOT NULL,                    -- 'layer1' (deterministic) | 'layer2' (model)
  case_number    TEXT NOT NULL,
  keyword        TEXT NOT NULL,                    -- response type the score was read against
  overall        REAL,                             -- 0..100, null when nothing applies yet
  band           TEXT,                             -- meeting | partial | not_meeting
  detail         TEXT NOT NULL,                    -- JSON: dimensions, per-comment WWW, violations
  rubric_version TEXT NOT NULL,                    -- a bump here invalidates every row
  content_hash   TEXT,                             -- layer 2 cache key; null for layer 1
  scored_at      INTEGER NOT NULL,
  PRIMARY KEY (case_id, layer),
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_iqs_scores_overall ON iqs_scores(layer, overall);
CREATE INDEX IF NOT EXISTS idx_iqs_scores_number ON iqs_scores(case_number);
`);

/* --------------------------------------------------------------- full text */

/**
 * FTS5 in external-content mode: the index stores only the tokens, the rows
 * stay in `comments`/`cases`. Triggers keep them in step, so a delete or an
 * edited comment body cannot leave a phantom hit behind.
 */
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS comments_fts USING fts5(
  body,
  content='comments',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS comments_ai AFTER INSERT ON comments BEGIN
  INSERT INTO comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_ad AFTER DELETE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS comments_au AFTER UPDATE ON comments BEGIN
  INSERT INTO comments_fts(comments_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  INSERT INTO comments_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS cases_fts USING fts5(
  subject,
  description,
  content='cases',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS cases_ai AFTER INSERT ON cases BEGIN
  INSERT INTO cases_fts(rowid, subject, description) VALUES (new.rowid, new.subject, new.description);
END;
CREATE TRIGGER IF NOT EXISTS cases_ad AFTER DELETE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, subject, description) VALUES('delete', old.rowid, old.subject, old.description);
END;
CREATE TRIGGER IF NOT EXISTS cases_au AFTER UPDATE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, subject, description) VALUES('delete', old.rowid, old.subject, old.description);
  INSERT INTO cases_fts(rowid, subject, description) VALUES (new.rowid, new.subject, new.description);
END;
`);

/* ------------------------------------------------------- additive columns */

/** Add a column only if it is missing. Used for schema changes after v1. */
function ensureColumn(table: string, column: string, decl: string): void {
  const cols = db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + decl);
  }
}

ensureColumn("suggested_replies", "keyword", "TEXT");
ensureColumn("suggested_replies", "internal_note", "TEXT");
ensureColumn("suggested_replies", "self_check", "TEXT");

/* ------------------------------------------------------- suggested replies */

export interface SuggestedReply {
  id: string;
  case_number: string;
  draft: string;
  keyword: string | null;
  internal_note: string | null;
  self_check: string | null;
  created_at: number;
}

export function getLatestSuggestedReply(caseNumber: string): SuggestedReply | undefined {
  return db
    .prepare(
      "SELECT * FROM suggested_replies WHERE case_number = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(caseNumber) as SuggestedReply | undefined;
}

export function saveSuggestedReply(
  caseNumber: string,
  draft: string,
  keyword: string | null,
  internalNote: string | null,
  selfCheck: string | null,
): SuggestedReply {
  const row: SuggestedReply = {
    id: newId(),
    case_number: caseNumber,
    draft,
    keyword,
    internal_note: internalNote,
    self_check: selfCheck,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO suggested_replies (id, case_number, draft, keyword, internal_note, self_check, created_at)
     VALUES (@id, @case_number, @draft, @keyword, @internal_note, @self_check, @created_at)`,
  ).run(row);
  return row;
}

/* ---------------------------------------------------------------- settings */

export const SETTING_DEFAULTS: Record<string, string> = {
  syncIntervalMinutes: "5",
  activeWindowStart: "8",       // hour, NY. Sync only inside the window.
  activeWindowEnd: "20",
  activeWindowWeekdaysOnly: "false",
  staleDays: "5",
  atRiskHours: "4",
  theme: "dark",
  notificationsEnabled: "false",
  webhookEnabled: "false",
  webhookUrl: "",
  webhookIncludeSubject: "false",  // case subjects are customer data; off means IDs only

  escalationUpdateHours: "24",  // how often an escalation owes the customer an update
  closedCaseWindowDays: "120",  // how far back to keep closed cases for metrics
};

export function getSetting(key: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : (SETTING_DEFAULTS[key] ?? "");
}

export function getSettingNumber(key: string): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) ? n : Number(SETTING_DEFAULTS[key] ?? 0);
}

export function getSettingBool(key: string): boolean {
  return getSetting(key) === "true";
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

export function allSettings(): Record<string, string> {
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  const rows = db.prepare("SELECT key, value FROM settings").all() as Array<{
    key: string;
    value: string;
  }>;
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/* -------------------------------------------------------------- sync state */

export interface SyncState {
  watermark: string | null;
  last_success: number | null;
  last_attempt: number | null;
  last_error: string | null;
  error_count: number;
  api_calls: number;
  running: number;
  last_duration_ms: number | null;
}

export function getSyncState(): SyncState {
  return db.prepare("SELECT * FROM sync_state WHERE id = 1").get() as SyncState;
}

export function patchSyncState(patch: Partial<SyncState>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const assignments = keys.map((k) => k + " = @" + k).join(", ");
  db.prepare("UPDATE sync_state SET " + assignments + " WHERE id = 1").run(patch as never);
}

export function countApiCalls(n: number): void {
  db.prepare("UPDATE sync_state SET api_calls = api_calls + ? WHERE id = 1").run(n);
}

/* ------------------------------------------------------------- cache stats */

export function cacheCounts(): Record<string, number> {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    cases: one("SELECT COUNT(*) AS n FROM cases"),
    openCases: one("SELECT COUNT(*) AS n FROM cases WHERE is_closed = 0"),
    comments: one("SELECT COUNT(*) AS n FROM comments"),
    commitments: one("SELECT COUNT(*) AS n FROM commitments"),
    artifacts: one("SELECT COUNT(*) AS n FROM artifacts"),
    events: one("SELECT COUNT(*) AS n FROM events"),
  };
}

/** Drop cached Salesforce data so the next sync rebuilds from scratch. */
export function rebuildCache(): void {
  db.exec(`
    DELETE FROM artifacts;
    DELETE FROM commitments WHERE source = 'parsed';
    DELETE FROM comments;
    DELETE FROM cases;
    UPDATE sync_state SET watermark = NULL, error_count = 0, last_error = NULL WHERE id = 1;
  `);
}
