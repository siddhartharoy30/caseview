/**
 * Cache reads.
 *
 * Every route in the app reads from here, never from Salesforce directly. The
 * shapes returned are the shapes the client renders, so the browser does no
 * joining and no second round trip.
 */

import { db, newId, now } from "./db";
import { ARTIFACT_LABELS, ArtifactKind } from "./artifacts";

/* --------------------------------------------------------------- case rows */

export interface CaseRow {
  id: string;
  case_number: string;
  subject: string | null;
  description: string | null;
  status: string;
  priority: string | null;
  type: string | null;
  origin: string | null;
  component: string | null;
  sub_component: string | null;
  account: string | null;
  contact_name: string | null;
  owner: string | null;
  owner_title: string | null;
  labels: string | null;
  is_escalated: number;
  is_closed: number;
  created_date: string;
  last_modified_date: string;
  closed_date: string | null;
  ncc_date: string | null;
  last_customer_update: string | null;
  active_ttr_days: number | null;
  product_area: string | null;
  error_signature: string | null;
  first_response_at: string | null;
  last_my_touch: string | null;
  last_customer_touch: string | null;
  needs_my_reply: number;
  comment_count: number;
  synced_at: number;
}

const CASE_COLUMNS = `
  id, case_number, subject, description, status, priority, type, origin,
  component, sub_component, account, contact_name, owner, owner_title, labels,
  is_escalated, is_closed, created_date, last_modified_date, closed_date,
  ncc_date, last_customer_update, active_ttr_days, product_area,
  error_signature, first_response_at, last_my_touch, last_customer_touch,
  needs_my_reply, comment_count, synced_at
`;

/** Shape a cache row for the client. Field names match the old API. */
export function toApiCase(r: CaseRow) {
  const next = nextCommitmentFor(r.id);
  return {
    id: r.id,
    caseNumber: r.case_number,
    subject: r.subject,
    description: r.description,
    status: r.status,
    priority: r.priority,
    type: r.type,
    origin: r.origin,
    component: r.component,
    subComponent: r.sub_component,
    account: r.account,
    contactName: r.contact_name,
    owner: r.owner,
    ownerTitle: r.owner_title,
    labels: r.labels,
    isEscalated: !!r.is_escalated,
    isClosed: !!r.is_closed,
    createdDate: r.created_date,
    lastModifiedDate: r.last_modified_date,
    closedDate: r.closed_date,
    ncc: r.ncc_date,
    lastCustomerUpdate: r.last_customer_update,
    activeTtrDays: r.active_ttr_days,
    productArea: r.product_area || "Unclassified",
    errorSignature: r.error_signature,
    firstResponseAt: r.first_response_at,
    lastMyTouch: r.last_my_touch,
    lastCustomerTouch: r.last_customer_touch,
    needsMyReply: !!r.needs_my_reply,
    commentCount: r.comment_count || 0,
    syncedAt: r.synced_at,
    nextCommitment: next,
  };
}

const nextCommitmentStmt = db.prepare(`
SELECT id, due_at, raw_text, state
FROM commitments
WHERE case_id = ? AND state = 'active' AND due_at IS NOT NULL
ORDER BY due_at ASC LIMIT 1
`);

const breachedCommitmentStmt = db.prepare(`
SELECT id, due_at, raw_text, state
FROM commitments
WHERE case_id = ? AND state = 'breached'
ORDER BY due_at DESC LIMIT 1
`);

interface CommitmentPeek {
  id: string;
  due_at: string | null;
  raw_text: string;
  state: string;
}

/** The deadline that matters right now: the soonest active one, else the last breach. */
function nextCommitmentFor(caseId: string) {
  const active = nextCommitmentStmt.get(caseId) as CommitmentPeek | undefined;
  const row = active || (breachedCommitmentStmt.get(caseId) as CommitmentPeek | undefined);
  if (!row) return null;
  return { id: row.id, dueAt: row.due_at, rawText: row.raw_text, state: row.state };
}

export interface CaseFilters {
  status?: string;   // "open" | "closed" | "all" | a literal Salesforce status
  priority?: string; // comma separated
  account?: string;
  productArea?: string;
  needsReply?: boolean;
  escalated?: boolean;
  q?: string;
}

export function listCases(f: CaseFilters = {}) {
  const where: string[] = [];
  const params: any[] = [];

  const status = f.status || "open";
  if (status === "open") where.push("is_closed = 0");
  else if (status === "closed") where.push("is_closed = 1");
  else if (status !== "all") {
    where.push("status = ?");
    params.push(status);
  }

  if (f.priority) {
    const list = f.priority.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length) {
      where.push(`priority IN (${list.map(() => "?").join(",")})`);
      params.push(...list);
    }
  }
  if (f.account) {
    where.push("account = ?");
    params.push(f.account);
  }
  if (f.productArea) {
    where.push("product_area = ?");
    params.push(f.productArea);
  }
  if (f.needsReply) where.push("needs_my_reply = 1");
  if (f.escalated) where.push("is_escalated = 1");
  if (f.q) {
    where.push("(case_number LIKE ? OR subject LIKE ? OR account LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }

  const sql = `SELECT ${CASE_COLUMNS} FROM cases ${
    where.length ? "WHERE " + where.join(" AND ") : ""
  } ORDER BY created_date DESC`;

  return (db.prepare(sql).all(...params) as CaseRow[]).map(toApiCase);
}

export function getCase(caseNumber: string) {
  const row = db
    .prepare(`SELECT ${CASE_COLUMNS} FROM cases WHERE case_number = ?`)
    .get(caseNumber) as CaseRow | undefined;
  return row ? toApiCase(row) : null;
}

export function getCaseRow(caseNumber: string): CaseRow | undefined {
  return db
    .prepare(`SELECT ${CASE_COLUMNS} FROM cases WHERE case_number = ?`)
    .get(caseNumber) as CaseRow | undefined;
}

/* ---------------------------------------------------------------- timeline */

export function getTimeline(caseNumber: string) {
  const rows = db
    .prepare(
      `SELECT id, source, body, author, author_email, is_public, is_mine, is_inbound,
              subject, created_date
       FROM comments WHERE case_number = ? ORDER BY created_date ASC`,
    )
    .all(caseNumber) as Array<{
    id: string;
    source: string;
    body: string;
    author: string | null;
    author_email: string | null;
    is_public: number;
    is_mine: number;
    is_inbound: number;
    subject: string | null;
    created_date: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    body: r.body,
    author: r.author,
    authorEmail: r.author_email,
    isPublic: !!r.is_public,
    isMine: !!r.is_mine,
    isInbound: !!r.is_inbound,
    subject: r.subject,
    createdDate: r.created_date,
  }));
}

/* --------------------------------------------------------------- artifacts */

export function getArtifacts(caseNumber: string) {
  const rows = db
    .prepare("SELECT kind, value FROM artifacts WHERE case_number = ? ORDER BY kind, value")
    .all(caseNumber) as Array<{ kind: ArtifactKind; value: string }>;

  const grouped = new Map<string, string[]>();
  for (const r of rows) {
    const label = ARTIFACT_LABELS[r.kind] || r.kind;
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(r.value);
  }
  return Array.from(grouped, ([label, values]) => ({ label, values }));
}

/* ----------------------------------------------------------------- related */

/**
 * Other cases worth glancing at: same account, or the same error signature, or
 * the same product area. Ranked so the strongest link comes first.
 */
export function getRelated(caseNumber: string, limit = 12) {
  const c = getCaseRow(caseNumber);
  if (!c) return [];

  const rows = db
    .prepare(
      `SELECT ${CASE_COLUMNS},
        CASE
          WHEN error_signature IS NOT NULL AND error_signature = @sig THEN 3
          WHEN account IS NOT NULL AND account = @account THEN 2
          ELSE 1
        END AS rank
       FROM cases
       WHERE case_number != @num
         AND (
           (error_signature IS NOT NULL AND error_signature = @sig)
           OR (account IS NOT NULL AND account = @account)
           OR (product_area IS NOT NULL AND product_area = @area)
         )
       ORDER BY rank DESC, created_date DESC
       LIMIT @limit`,
    )
    .all({
      num: caseNumber,
      sig: c.error_signature,
      account: c.account,
      area: c.product_area,
      limit,
    }) as Array<CaseRow & { rank: number }>;

  return rows.map((r) => ({
    ...toApiCase(r),
    relation:
      r.rank === 3 ? "Same error signature" : r.rank === 2 ? "Same account" : "Same product area",
  }));
}

/** Jira keys mentioned anywhere on the case. Never rendered as customer-facing text. */
export function getJiraLinks(caseNumber: string): string[] {
  return (
    db
      .prepare("SELECT value FROM artifacts WHERE case_number = ? AND kind = 'jira' ORDER BY value")
      .all(caseNumber) as Array<{ value: string }>
  ).map((r) => r.value);
}

/* ------------------------------------------------------------- commitments */

export interface CommitmentRow {
  id: string;
  case_id: string;
  case_number: string;
  due_at: string | null;
  raw_text: string;
  source: string;
  source_comment_id: string | null;
  state: string;
  superseded_by: string | null;
  met_at: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
}

function toApiCommitment(r: CommitmentRow, subject: string | null, account: string | null) {
  return {
    id: r.id,
    caseId: r.case_id,
    caseNumber: r.case_number,
    subject,
    account,
    dueAt: r.due_at,
    rawText: r.raw_text,
    source: r.source,
    sourceCommentId: r.source_comment_id,
    state: r.state,
    supersededBy: r.superseded_by,
    metAt: r.met_at,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listCommitments(states?: string[]) {
  const filter = states && states.length
    ? `WHERE cm.state IN (${states.map(() => "?").join(",")})`
    : "";
  const rows = db
    .prepare(
      `SELECT cm.*, c.subject AS c_subject, c.account AS c_account
       FROM commitments cm LEFT JOIN cases c ON c.id = cm.case_id
       ${filter}
       ORDER BY cm.due_at IS NULL, cm.due_at ASC`,
    )
    .all(...(states || [])) as Array<CommitmentRow & { c_subject: string | null; c_account: string | null }>;

  return rows.map((r) => toApiCommitment(r, r.c_subject, r.c_account));
}

export function listCommitmentsForCase(caseNumber: string) {
  const rows = db
    .prepare("SELECT * FROM commitments WHERE case_number = ? ORDER BY due_at IS NULL, due_at ASC")
    .all(caseNumber) as CommitmentRow[];
  return rows.map((r) => toApiCommitment(r, null, null));
}

/**
 * Cases carrying more than one active commitment.
 *
 * Only one deadline may be live per case, so this is an error condition and the
 * UI is expected to shout about it rather than pick a winner.
 */
export function duplicateCommitmentCases(): string[] {
  return (
    db
      .prepare(
        `SELECT case_number FROM commitments
         WHERE state = 'active' AND due_at IS NOT NULL
         GROUP BY case_number HAVING COUNT(*) > 1`,
      )
      .all() as Array<{ case_number: string }>
  ).map((r) => r.case_number);
}

export function addManualCommitment(caseNumber: string, dueAt: string | null, text: string, note?: string) {
  const c = getCaseRow(caseNumber);
  if (!c) throw new Error("unknown case " + caseNumber);
  const ts = now();
  const id = newId();
  db.prepare(
    `INSERT INTO commitments (id, case_id, case_number, due_at, raw_text, source,
       source_comment_id, state, note, created_at, updated_at)
     VALUES (@id, @case_id, @case_number, @due_at, @raw_text, 'manual', NULL, @state, @note, @ts, @ts)`,
  ).run({
    id,
    case_id: c.id,
    case_number: caseNumber,
    due_at: dueAt,
    raw_text: text,
    state: dueAt ? "active" : "unparsed",
    note: note || null,
    ts,
  });
  return id;
}

export function updateCommitment(
  id: string,
  patch: { dueAt?: string | null; state?: string; note?: string | null; rawText?: string },
) {
  const sets: string[] = [];
  const params: Record<string, any> = { id, updated_at: now() };
  if (patch.dueAt !== undefined) {
    sets.push("due_at = @due_at");
    params.due_at = patch.dueAt;
  }
  if (patch.state !== undefined) {
    sets.push("state = @state");
    params.state = patch.state;
  }
  if (patch.note !== undefined) {
    sets.push("note = @note");
    params.note = patch.note;
  }
  if (patch.rawText !== undefined) {
    sets.push("raw_text = @raw_text");
    params.raw_text = patch.rawText;
  }
  if (!sets.length) return;
  db.prepare(`UPDATE commitments SET ${sets.join(", ")}, updated_at = @updated_at WHERE id = @id`).run(
    params,
  );
}

/**
 * Move a deadline: the old one is marked superseded rather than edited, so the
 * history shows the date changed *before* it expired.
 */
export function renegotiateCommitment(id: string, dueAt: string, text?: string, note?: string) {
  const old = db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as CommitmentRow | undefined;
  if (!old) throw new Error("unknown commitment");

  const ts = now();
  const newIdValue = newId();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO commitments (id, case_id, case_number, due_at, raw_text, source,
         source_comment_id, state, note, created_at, updated_at)
       VALUES (@id, @case_id, @case_number, @due_at, @raw_text, 'manual', NULL, 'active', @note, @ts, @ts)`,
    ).run({
      id: newIdValue,
      case_id: old.case_id,
      case_number: old.case_number,
      due_at: dueAt,
      raw_text: text || old.raw_text,
      note: note || null,
      ts,
    });
    db.prepare(
      "UPDATE commitments SET state = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
    ).run(newIdValue, ts, id);
  })();

  return newIdValue;
}

/* ------------------------------------------------------------------ search */

/**
 * Full-text search across every cached comment and case.
 *
 * This is the "have I seen this PKIX error before" query, so it runs against
 * the whole history, not just open cases.
 */
export function search(q: string, limit = 200) {
  if (!q.trim()) return [];

  const match = ftsQuery(q);
  const hits = db
    .prepare(
      `SELECT c.case_number, c.id AS comment_id, c.created_date, c.author, c.is_public, c.source,
              snippet(comments_fts, 0, '<mark>', '</mark>', '…', 18) AS snip
       FROM comments_fts
       JOIN comments c ON c.rowid = comments_fts.rowid
       WHERE comments_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, limit) as Array<{
    case_number: string;
    comment_id: string;
    created_date: string;
    author: string | null;
    is_public: number;
    source: string;
    snip: string;
  }>;

  const subjectHits = db
    .prepare(
      `SELECT c.case_number, snippet(cases_fts, 0, '<mark>', '</mark>', '…', 18) AS snip
       FROM cases_fts JOIN cases c ON c.rowid = cases_fts.rowid
       WHERE cases_fts MATCH ? ORDER BY rank LIMIT 50`,
    )
    .all(match) as Array<{ case_number: string; snip: string }>;

  // Group by case: one row per case with its matching excerpts underneath.
  const byCase = new Map<string, { caseNumber: string; matches: any[] }>();
  const push = (caseNumber: string, m: any) => {
    if (!byCase.has(caseNumber)) byCase.set(caseNumber, { caseNumber, matches: [] });
    byCase.get(caseNumber)!.matches.push(m);
  };

  for (const s of subjectHits) push(s.case_number, { where: "subject", snippet: s.snip });
  for (const h of hits) {
    push(h.case_number, {
      where: h.source === "email" ? "email" : h.is_public ? "comment" : "internal note",
      snippet: h.snip,
      author: h.author,
      createdDate: h.created_date,
      commentId: h.comment_id,
    });
  }

  const out: any[] = [];
  for (const g of byCase.values()) {
    const c = getCaseRow(g.caseNumber);
    if (!c) continue;
    out.push({
      caseNumber: g.caseNumber,
      subject: c.subject,
      account: c.account,
      status: c.status,
      priority: c.priority,
      isClosed: !!c.is_closed,
      productArea: c.product_area,
      matchCount: g.matches.length,
      matches: g.matches.slice(0, 5),
    });
  }
  return out;
}

/**
 * Turn a human query into an FTS5 MATCH expression.
 * Bare words become a prefix AND-search; a quoted string stays a phrase.
 */
function ftsQuery(q: string): string {
  const phrases = q.match(/"[^"]+"/g) || [];
  let rest = q;
  for (const p of phrases) rest = rest.replace(p, " ");
  const terms = rest
    .split(/[^\w./:-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1)
    .map((t) => `"${t.replace(/"/g, "")}"*`);
  return [...phrases, ...terms].join(" AND ") || `"${q.replace(/"/g, "")}"`;
}

/* ---------------------------------------------------------------- patterns */

/** Clusters worth noticing: repeated error signatures, product areas, accounts. */
export function patterns() {
  const bySignature = db
    .prepare(
      `SELECT error_signature AS key, COUNT(*) AS count,
              SUM(CASE WHEN is_closed = 0 THEN 1 ELSE 0 END) AS open_count
       FROM cases WHERE error_signature IS NOT NULL
       GROUP BY error_signature HAVING COUNT(*) > 1
       ORDER BY count DESC, key LIMIT 50`,
    )
    .all() as Array<{ key: string; count: number; open_count: number }>;

  const byArea = db
    .prepare(
      `SELECT COALESCE(product_area, 'Unclassified') AS key, COUNT(*) AS count,
              SUM(CASE WHEN is_closed = 0 THEN 1 ELSE 0 END) AS open_count
       FROM cases GROUP BY key ORDER BY count DESC`,
    )
    .all() as Array<{ key: string; count: number; open_count: number }>;

  const byAccount = db
    .prepare(
      `SELECT account AS key, COUNT(*) AS count,
              SUM(CASE WHEN is_closed = 0 THEN 1 ELSE 0 END) AS open_count
       FROM cases WHERE account IS NOT NULL
       GROUP BY account HAVING COUNT(*) > 1
       ORDER BY count DESC, key LIMIT 50`,
    )
    .all() as Array<{ key: string; count: number; open_count: number }>;

  const cases = db.prepare(
    `SELECT case_number, subject, status, priority, is_closed, created_date
     FROM cases WHERE error_signature = ? ORDER BY created_date DESC LIMIT 20`,
  );

  return {
    signatures: bySignature.map((s) => ({
      ...s,
      cases: (cases.all(s.key) as any[]).map((c) => ({
        caseNumber: c.case_number,
        subject: c.subject,
        status: c.status,
        priority: c.priority,
        isClosed: !!c.is_closed,
        createdDate: c.created_date,
      })),
    })),
    productAreas: byArea,
    accounts: byAccount,
  };
}

/* ------------------------------------------------------------------ counts */

/**
 * The sidebar badges, computed in one pass.
 *
 * Every commitment count is joined to an open case on purpose. A deadline that
 * was missed on a case closed eight months ago is history, not work, and a
 * permanent red "89" on the sidebar would train me to ignore the badge — which
 * defeats the point of having one.
 */
export function badgeCounts(atRiskHours: number) {
  const nowIso = new Date().toISOString();
  const horizon = new Date(Date.now() + atRiskHours * 3600_000).toISOString();

  const one = (sql: string, ...p: any[]) =>
    (db.prepare(sql).get(...p) as { n: number }).n;

  const openCommitments = (extra: string, ...p: any[]) =>
    one(
      `SELECT COUNT(*) AS n FROM commitments cm
         JOIN cases c ON c.case_number = cm.case_number
        WHERE c.is_closed = 0 AND ${extra}`,
      ...p,
    );

  return {
    queue: one("SELECT COUNT(*) AS n FROM cases WHERE is_closed = 0"),
    needsReply: one("SELECT COUNT(*) AS n FROM cases WHERE is_closed = 0 AND needs_my_reply = 1"),
    triage: one(
      "SELECT COUNT(*) AS n FROM cases WHERE is_closed = 0 AND first_response_at IS NULL",
    ),
    // At risk means "still time to act": due inside the horizon but not yet past.
    commitmentsAtRisk: openCommitments(
      "cm.state = 'active' AND cm.due_at IS NOT NULL AND cm.due_at > ? AND cm.due_at <= ?",
      nowIso,
      horizon,
    ),
    commitmentsBreached: openCommitments("cm.state = 'breached'"),
    commitmentsUnparsed: openCommitments("cm.state = 'unparsed'"),
    escalations: one(
      "SELECT COUNT(*) AS n FROM cases WHERE is_closed = 0 AND (is_escalated = 1 OR priority IN ('P1','P0'))",
    ),
    // Past due but not yet reconciled into 'breached' — still my problem today.
    overdue: openCommitments(
      "cm.state = 'active' AND cm.due_at IS NOT NULL AND cm.due_at < ?",
      nowIso,
    ),
    duplicates: duplicateCommitmentCases().length,
  };
}

/* -------------------------------------------------------------- distinct-ish */

/**
 * Filter options for the queue. Defaults to open cases only, because a facet
 * offering "Frontdoor (6)" that yields two rows once the open-case filter
 * applies is worse than no count at all.
 */
export function facets(openOnly = true) {
  const scope = openOnly ? "is_closed = 0 AND" : "";
  const col = (name: string) =>
    (
      db
        .prepare(
          `SELECT ${name} AS v, COUNT(*) AS n FROM cases
            WHERE ${scope} ${name} IS NOT NULL AND ${name} != ''
            GROUP BY ${name} ORDER BY n DESC, v ASC`,
        )
        .all() as Array<{ v: string; n: number }>
    ).map((r) => ({ value: r.v, count: r.n }));

  return {
    accounts: col("account"),
    priorities: col("priority"),
    statuses: col("status"),
    productAreas: col("product_area"),
  };
}
