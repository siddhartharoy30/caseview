import Database from "better-sqlite3";
import { randomUUID } from "crypto";

const DB_PATH = process.env.QVIEW_DB_PATH || "/data/qview.db";

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(
  "CREATE TABLE IF NOT EXISTS suggested_replies (\n" +
  "  id TEXT PRIMARY KEY,\n" +
  "  case_number TEXT NOT NULL,\n" +
  "  draft TEXT NOT NULL,\n" +
  "  created_at INTEGER NOT NULL\n" +
  ");\n" +
  "\n" +
  "CREATE INDEX IF NOT EXISTS idx_suggested_replies_case ON suggested_replies(case_number);"
);

function ensureColumn(table: string, column: string, decl: string) {
  const cols = db.prepare("PRAGMA table_info(" + table + ")").all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + decl);
  }
}

ensureColumn("suggested_replies", "keyword", "TEXT");
ensureColumn("suggested_replies", "internal_note", "TEXT");
ensureColumn("suggested_replies", "self_check", "TEXT");

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function newId(): string {
  return randomUUID();
}

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
    .prepare("SELECT * FROM suggested_replies WHERE case_number = ? ORDER BY created_at DESC LIMIT 1")
    .get(caseNumber) as SuggestedReply | undefined;
}

export function saveSuggestedReply(
  caseNumber: string,
  draft: string,
  keyword: string | null,
  internalNote: string | null,
  selfCheck: string | null
): SuggestedReply {
  const r: SuggestedReply = {
    id: newId(),
    case_number: caseNumber,
    draft,
    keyword,
    internal_note: internalNote,
    self_check: selfCheck,
    created_at: now(),
  };
  db.prepare(
    "INSERT INTO suggested_replies (id, case_number, draft, keyword, internal_note, self_check, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(r.id, r.case_number, r.draft, r.keyword, r.internal_note, r.self_check, r.created_at);
  return r;
}
