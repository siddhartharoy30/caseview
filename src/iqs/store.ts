/**
 * Persistence for IQS scores.
 *
 * Reads cached rows into the pure scorer's input shape, writes the result to
 * `iqs_scores`, and hands summaries back to the queue and details back to the
 * Quality tab. Everything that touches the database lives here so ./layer1
 * stays a pure function that a test can call with a literal.
 *
 * The table is keyed on (case_id, layer). Phase 3's model scorer writes
 * layer='layer2' rows alongside these without touching this file's queries.
 */

import { db } from "../db";
import { log } from "../log";
import { RUBRIC_VERSION } from "./rubric";
import type { Band, Keyword } from "./rubric";
import { scoreCase, SCORER_VERSION } from "./layer1";
import type { CaseFacts, CommentFacts, CommitmentFacts, Layer1Score } from "./layer1";

export const LAYER = "layer1";

/**
 * What the rubric_version column actually holds.
 *
 * A cached score is only reusable if both the rubric and the code that applied
 * it are unchanged, so the stamp is the pair and a move in either re-grades the
 * cache at the next boot. The column keeps its name because that is what it
 * keys on.
 *
 * The score itself carries the two halves separately (rubricVersion,
 * scorerVersion) — joining them is a cache-key concern, and only this file has
 * it. Anything reading a score back gets both, unjoined.
 */
const STAMP = `${RUBRIC_VERSION}/${SCORER_VERSION}`;

/** What the queue needs per row: three columns, no JSON parsing. */
export interface IqsSummary {
  overall: number | null;
  band: Band | null;
  keyword: Keyword;
  scoredAt: number;
}

/* ------------------------------------------------------------ statements */

const selectCase = db.prepare(`
  SELECT id, case_number, subject, description, status, is_closed
  FROM cases WHERE id = ?
`);

const selectComments = db.prepare(`
  SELECT id, body, created_date, is_mine, is_public, is_inbound, source
  FROM comments WHERE case_id = ? ORDER BY created_date ASC
`);

const selectCommitments = db.prepare(`
  SELECT id, state, due_at, source_comment_id, raw_text
  FROM commitments WHERE case_id = ?
`);

const upsertScore = db.prepare(`
  INSERT INTO iqs_scores
    (case_id, layer, case_number, keyword, overall, band, detail, rubric_version, content_hash, scored_at)
  VALUES
    (@case_id, @layer, @case_number, @keyword, @overall, @band, @detail, @rubric_version, NULL, @scored_at)
  ON CONFLICT(case_id, layer) DO UPDATE SET
    case_number    = excluded.case_number,
    keyword        = excluded.keyword,
    overall        = excluded.overall,
    band           = excluded.band,
    detail         = excluded.detail,
    rubric_version = excluded.rubric_version,
    scored_at      = excluded.scored_at
`);

const selectSummaryById = db.prepare(`
  SELECT overall, band, keyword, scored_at FROM iqs_scores WHERE case_id = ? AND layer = '${LAYER}'
`);

const selectDetailByNumber = db.prepare(`
  SELECT detail, scored_at, rubric_version FROM iqs_scores
  WHERE case_number = ? AND layer = '${LAYER}'
`);

const selectStale = db.prepare(`
  SELECT c.id AS id FROM cases c
  LEFT JOIN iqs_scores s ON s.case_id = c.id AND s.layer = '${LAYER}'
  WHERE s.case_id IS NULL OR s.rubric_version <> ?
`);

/* ------------------------------------------------------------------ facts */

interface CaseRowLite {
  id: string;
  case_number: string;
  subject: string | null;
  description: string | null;
  status: string | null;
  is_closed: number;
}

interface CommentRowLite {
  id: string;
  body: string;
  created_date: string;
  is_mine: number;
  is_public: number;
  is_inbound: number;
  source: string;
}

interface CommitmentRowLite {
  id: string;
  state: string;
  due_at: string | null;
  source_comment_id: string | null;
  raw_text: string;
}

/** Everything the scorer is allowed to see, and nothing else. */
export function loadCaseFacts(caseId: string): CaseFacts | null {
  const c = selectCase.get(caseId) as CaseRowLite | undefined;
  if (!c) return null;

  const comments: CommentFacts[] = (selectComments.all(caseId) as CommentRowLite[]).map((r) => ({
    id: r.id,
    body: r.body,
    createdDate: r.created_date,
    isMine: r.is_mine === 1,
    isPublic: r.is_public === 1,
    isInbound: r.is_inbound === 1,
    source: r.source,
  }));

  const commitments: CommitmentFacts[] = (selectCommitments.all(caseId) as CommitmentRowLite[]).map((r) => ({
    id: r.id,
    state: r.state,
    dueAt: r.due_at,
    sourceCommentId: r.source_comment_id,
    rawText: r.raw_text,
  }));

  return {
    caseId: c.id,
    caseNumber: c.case_number,
    status: c.status,
    isClosed: c.is_closed === 1,
    subject: c.subject,
    description: c.description,
    comments,
    commitments,
  };
}

/* ------------------------------------------------------------------ write */

function persist(score: Layer1Score): void {
  upsertScore.run({
    case_id: score.caseId,
    layer: LAYER,
    case_number: score.caseNumber,
    keyword: score.keyword,
    overall: score.overall,
    band: score.band,
    detail: JSON.stringify(score),
    rubric_version: STAMP,
    scored_at: score.scoredAt,
  });
}

/** Score one case and store the result. Returns null if the case is gone. */
export function scoreAndStoreCase(caseId: string): Layer1Score | null {
  const facts = loadCaseFacts(caseId);
  if (!facts) return null;
  const score = scoreCase(facts);
  persist(score);
  return score;
}

const writeMany = db.transaction((scores: Layer1Score[]) => {
  for (const s of scores) persist(s);
});

/**
 * Score a batch of cases.
 *
 * Scoring runs outside the transaction and writing runs inside it: the regex
 * work is the slow part and holding a write lock through it would stall the
 * next sync for no reason. One bad case is logged and skipped rather than
 * losing the whole batch.
 */
export function scoreCases(caseIds: string[]): { scored: number; failed: number } {
  const scores: Layer1Score[] = [];
  let failed = 0;

  for (const id of caseIds) {
    try {
      const facts = loadCaseFacts(id);
      if (!facts) continue;
      scores.push(scoreCase(facts));
    } catch (err) {
      failed++;
      log.warn("iqs.score_failed", { caseId: id, error: String(err) });
    }
  }

  if (scores.length) writeMany(scores);
  return { scored: scores.length, failed };
}

/**
 * Score every case that has never been scored or was scored against an older
 * rubric. Runs at boot so a rubric edit re-grades the whole cache without a
 * Salesforce round trip; pure regex over a few hundred cases costs well under a
 * second and no API calls.
 */
export function rescoreStale(): { scored: number; failed: number } {
  const rows = selectStale.all(STAMP) as Array<{ id: string }>;
  if (!rows.length) return { scored: 0, failed: 0 };

  const started = Date.now();
  const result = scoreCases(rows.map((r) => r.id));
  log.info("iqs.backfill", {
    stale: rows.length,
    scored: result.scored,
    failed: result.failed,
    stamp: STAMP,
    ms: Date.now() - started,
  });
  return result;
}

/* ------------------------------------------------------------------- read */

export function getSummary(caseId: string): IqsSummary | null {
  const r = selectSummaryById.get(caseId) as
    | { overall: number | null; band: Band | null; keyword: Keyword; scored_at: number }
    | undefined;
  if (!r) return null;
  return { overall: r.overall, band: r.band, keyword: r.keyword, scoredAt: r.scored_at };
}

/** Full breakdown for the Quality tab, straight from the stored JSON. */
export function getDetail(caseNumber: string): Layer1Score | null {
  const r = selectDetailByNumber.get(caseNumber) as
    | { detail: string; scored_at: number; rubric_version: string }
    | undefined;
  if (!r) return null;
  try {
    const detail = JSON.parse(r.detail) as Layer1Score;
    /*
     * Rows written before the scorer recorded its own version have no
     * scorerVersion field. Recover it from the row's stamp rather than
     * showing a blank: the stamp is `<rubric>/<scorer>`, and the row's own
     * stamp is the truthful one — not the current STAMP, which would claim a
     * stale score was produced by today's scorer and hide the very mismatch
     * the stamp exists to expose. Such rows are re-graded at the next boot
     * anyway; this only covers the window before that happens.
     */
    if (!detail.scorerVersion && r.rubric_version) {
      const cut = r.rubric_version.lastIndexOf("/");
      if (cut > 0) detail.scorerVersion = r.rubric_version.slice(cut + 1);
    }
    return detail;
  } catch (err) {
    log.warn("iqs.detail_unreadable", { caseNumber, error: String(err) });
    return null;
  }
}

export interface IqsStats {
  scored: number;
  withScore: number;
  average: number | null;
  meeting: number;
  partial: number;
  notMeeting: number;
  violations: number;
  rubricVersion: string;
  scorerVersion: string;
  lastScoredAt: number | null;
}

/** Roll-up for the Quality tab header and, later, the /iqs page. */
export function getStats(openOnly = false): IqsStats {
  const where = openOnly ? "AND c.is_closed = 0" : "";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS scored,
              SUM(CASE WHEN s.overall IS NOT NULL THEN 1 ELSE 0 END) AS with_score,
              AVG(s.overall) AS average,
              SUM(CASE WHEN s.band = 'meeting' THEN 1 ELSE 0 END) AS meeting,
              SUM(CASE WHEN s.band = 'partial' THEN 1 ELSE 0 END) AS partial,
              SUM(CASE WHEN s.band = 'not_meeting' THEN 1 ELSE 0 END) AS not_meeting,
              SUM(json_array_length(s.detail, '$.violations')) AS violations,
              MAX(s.scored_at) AS last_scored_at
       FROM iqs_scores s JOIN cases c ON c.id = s.case_id
       WHERE s.layer = '${LAYER}' ${where}`,
    )
    .get() as Record<string, number | null>;

  return {
    scored: Number(row.scored || 0),
    withScore: Number(row.with_score || 0),
    average: row.average === null ? null : Math.round(Number(row.average) * 10) / 10,
    meeting: Number(row.meeting || 0),
    partial: Number(row.partial || 0),
    notMeeting: Number(row.not_meeting || 0),
    violations: Number(row.violations || 0),
    // What the current cache is keyed on. rescoreStale() has already run at
    // boot, so every row counted above was written under this pair.
    rubricVersion: RUBRIC_VERSION,
    scorerVersion: SCORER_VERSION,
    lastScoredAt: row.last_scored_at === null ? null : Number(row.last_scored_at),
  };
}
