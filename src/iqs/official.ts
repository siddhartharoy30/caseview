/**
 * SentryAI official-score import (v3 phase 9, rewritten v9 phase 1).
 *
 * The exact column layout is no longer a guess: this now reads a real
 * export (`report_date,case,Contributors,Case Score (%),Contributor Score
 * (%),rules_version`), confirmed against 62 real audited rows. Two real bugs
 * fixed here: the old cell-splitter had no CSV-quote awareness at all, so
 * every multi-contributor row (whose "Contributors" cell is a quoted,
 * comma-joined name list) fragmented into extra cells and every column
 * after it shifted; and the old column-matcher had no explicit "contributor
 * score" alias, so a generic "score" substring match picked "Case Score (%)"
 * -- the wrong number, per the rule below.
 *
 * Contributor Score is the primary field, always -- score only the
 * engineer's own contribution, compare only against it, never branch on
 * contributor count. On a solo case the two columns already agree; on a
 * shared case, Case Score blends in every other contributor's work and is
 * never what should be compared against QView's own (already
 * contributor-scoped, see layer1.ts/layer2.ts) predicted score. Case Score
 * is stored anyway, as context only -- it never populates the primary field
 * and this importer's own logic never falls back to it.
 */

import { db, now } from "../db";
import { getCaseRow, type CaseRow } from "../queries";
import { bandFor } from "./rubric";
import type { Band } from "./rubric";
import { detectDelimiter, parseDelimited } from "./csv";

export interface ParsedOfficialRow {
  caseNumber: string;
  /** Contributor Score -- the primary field. Always this engineer's own score. */
  overall: number;
  /** Case Score, context only. Never compared against; never a fallback for `overall`. */
  caseScore: number | null;
  contributorCount: number | null;
  contributors: string | null;
  rulesVersion: string | null;
  /** Epoch ms, parsed from the export's Unix-seconds `report_date` column. */
  reportDate: number | null;
  /** 1-based line number in the pasted/uploaded text, for a readable preview. */
  line: number;
}

export interface ParseFailure {
  line: number;
  raw: string;
  reason: string;
}

export interface ParseResult {
  rows: ParsedOfficialRow[];
  /** A data row that could not be parsed -- distinct from `fatal`, which means the whole paste couldn't be read at all. */
  parseFailures: ParseFailure[];
  fatal: boolean;
  fatalReason?: string;
  delimiter: string;
}

const CASE_HEADER_ALIASES = ["case number", "case no.", "case no", "case #", "casenumber", "case"];

/**
 * Matched exactly, never by substring -- "case score (%)" must never win
 * this lookup just because it also contains the word "score". If this
 * column is missing, the whole import fails loudly (see `parseOfficialImport`)
 * rather than silently falling back to Case Score.
 */
const CONTRIBUTOR_SCORE_ALIASES = ["contributor score (%)", "contributor score", "contributor's score"];

/** Kept lenient (exact, then substring) -- this column is context only. */
const CASE_SCORE_ALIASES = ["case score (%)", "case score", "overall score", "score", "overall", "iqs"];

const CONTRIBUTORS_ALIASES = ["contributors", "# contributors", "num contributors", "contributor count"];
const RULES_VERSION_ALIASES = ["rules version", "rules_version", "rubric version", "version"];
const REPORT_DATE_ALIASES = ["report date", "report_date", "reported", "date"];

function findColumn(headers: string[], aliases: string[], exactOnly = false): number {
  const lower = headers.map((h) => h.toLowerCase());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) return idx;
  }
  if (exactOnly) return -1;
  // Fall back to a substring match -- a real export's header is more likely
  // to be "Case Overall Score" than exactly "score".
  for (const alias of aliases) {
    const idx = lower.findIndex((h) => h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * "Siddhartha Roy, Akshay Kumar, ..." -> the raw string plus a derived
 * count; a bare integer cell ("3") is also accepted directly.
 */
function parseContributorsCell(raw: string): { contributors: string | null; contributorCount: number | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { contributors: null, contributorCount: null };
  if (/^\d+$/.test(trimmed)) return { contributors: trimmed, contributorCount: Number(trimmed) };
  const names = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  return { contributors: trimmed, contributorCount: names.length || null };
}

/** The export's `report_date` is Unix seconds (e.g. 1789673134), not ms. */
function parseReportDate(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000);
}

/**
 * The widest case number in the local cache today (every real one observed
 * so far is exactly 8 digits, zero-led). Computed once per import/preview
 * call, not per row.
 */
function caseNumberWidth(): number {
  const r = db.prepare("SELECT MAX(LENGTH(case_number)) AS w FROM cases").get() as { w: number | null };
  return r.w || 0;
}

/**
 * A CSV cell like "01316652" becomes the number 1316652 the moment it
 * round-trips through Excel/Sheets -- a near-certainty for a report a human
 * opens before uploading. `caseNumber.replace(/\D/g, "")` cannot recover a
 * leading zero that is already gone, so the row would otherwise land in
 * `unmatched` with no hint that the real cause is spreadsheet coercion, not
 * "case not in your cache." Tries the digits as given first (so a number
 * that already carries the correct zero-padding is unaffected), then a
 * left-padded form -- both are indexed exact lookups, so this costs at most
 * one extra lookup per already-unmatched row.
 */
function resolveCaseRow(digits: string, width: number): CaseRow | undefined {
  return getCaseRow(digits) ?? (width && digits.length < width ? getCaseRow(digits.padStart(width, "0")) : undefined);
}

function fatalResult(reason: string, delimiter: string): ParseResult {
  return { rows: [], parseFailures: [], fatal: true, fatalReason: reason, delimiter };
}

/**
 * Pure parse: delimiter detection, RFC 4180 splitting, column resolution,
 * per-row cell extraction. No DB access, no case matching -- `previewOfficialImport`
 * and `importOfficialScores` both layer on top of this.
 */
export function parseOfficialImport(raw: string): ParseResult {
  // A BOM survives an Excel "CSV UTF-8" export and would otherwise land
  // inside the first header cell, breaking every alias match against it.
  // Checked by code point (0xFEFF), not a regex literal, so the byte is
  // unambiguous on re-read regardless of editor/terminal encoding.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const firstLineEnd = text.indexOf("\n");
  const headerLine = (firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)).replace(/\r$/, "");
  if (!headerLine.trim()) {
    return fatalResult("Paste needs a header row and at least one data row.", ",");
  }

  const delimiter = detectDelimiter(headerLine);
  const table = parseDelimited(text, delimiter);
  if (table.length < 2) {
    return fatalResult("Paste needs a header row and at least one data row.", delimiter);
  }

  const headers = table[0];
  const caseCol = findColumn(headers, CASE_HEADER_ALIASES);
  const contributorScoreCol = findColumn(headers, CONTRIBUTOR_SCORE_ALIASES, true);
  const caseScoreCol = findColumn(headers, CASE_SCORE_ALIASES);
  const contributorsCol = findColumn(headers, CONTRIBUTORS_ALIASES);
  const rulesVersionCol = findColumn(headers, RULES_VERSION_ALIASES);
  const reportDateCol = findColumn(headers, REPORT_DATE_ALIASES);

  if (caseCol === -1) {
    return fatalResult(`Could not find a case number column in the header: ${headers.join(", ")}`, delimiter);
  }
  if (contributorScoreCol === -1) {
    return fatalResult(
      `Could not find a "Contributor Score" column in the header -- Case Score alone is not enough ` +
        `(it blends in every other contributor's work on a shared case). Header seen: ${headers.join(", ")}`,
      delimiter,
    );
  }

  const rows: ParsedOfficialRow[] = [];
  const parseFailures: ParseFailure[] = [];

  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    if (cells.length === 1 && cells[0] === "") continue; // a real blank line, not a bad row
    const line = i + 1; // 1-based; the header is line 1
    const rawLine = cells.join(delimiter);

    const caseNumber = (cells[caseCol] || "").replace(/\D/g, "");
    const rawScore = (cells[contributorScoreCol] || "").replace("%", "").trim();
    const overall = Number(rawScore);

    if (!caseNumber) {
      parseFailures.push({ line, raw: rawLine, reason: "no case number found" });
      continue;
    }
    if (!Number.isFinite(overall)) {
      parseFailures.push({ line, raw: rawLine, reason: `"${cells[contributorScoreCol] ?? ""}" is not a number` });
      continue;
    }

    const rawCaseScore = caseScoreCol !== -1 ? (cells[caseScoreCol] || "").replace("%", "").trim() : "";
    const caseScoreNum = rawCaseScore ? Number(rawCaseScore) : NaN;
    const { contributors, contributorCount } = parseContributorsCell(
      contributorsCol !== -1 ? cells[contributorsCol] || "" : "",
    );

    rows.push({
      caseNumber,
      overall: Math.max(0, Math.min(100, overall)),
      caseScore: Number.isFinite(caseScoreNum) ? Math.max(0, Math.min(100, caseScoreNum)) : null,
      contributorCount,
      contributors,
      rulesVersion: rulesVersionCol !== -1 ? (cells[rulesVersionCol] || "").trim() || null : null,
      reportDate: reportDateCol !== -1 ? parseReportDate(cells[reportDateCol] || "") : null,
      line,
    });
  }

  return { rows, parseFailures, fatal: false, delimiter };
}

export interface PreviewRow {
  caseNumber: string;
  subject: string | null;
  overall: number;
  caseScore: number | null;
  contributorCount: number | null;
  rulesVersion: string | null;
}

export interface UnmatchedRow {
  caseNumber: string;
  line: number;
}

export interface PreviewResult {
  matched: PreviewRow[];
  /** A case number not (yet) in the local cache -- informational, not an error. */
  unmatched: UnmatchedRow[];
  parseFailures: ParseFailure[];
  fatal: boolean;
  fatalReason?: string;
  delimiter: string;
}

/** Parse plus case-matching, with no writes -- what the "Preview" button calls. */
export function previewOfficialImport(raw: string): PreviewResult {
  const parsed = parseOfficialImport(raw);
  if (parsed.fatal) {
    return { matched: [], unmatched: [], parseFailures: parsed.parseFailures, fatal: true, fatalReason: parsed.fatalReason, delimiter: parsed.delimiter };
  }

  const width = caseNumberWidth();
  const matched: PreviewRow[] = [];
  const unmatched: UnmatchedRow[] = [];

  for (const r of parsed.rows) {
    const c = resolveCaseRow(r.caseNumber, width);
    if (!c) {
      unmatched.push({ caseNumber: r.caseNumber, line: r.line });
      continue;
    }
    matched.push({
      caseNumber: c.case_number,
      subject: c.subject,
      overall: r.overall,
      caseScore: r.caseScore,
      contributorCount: r.contributorCount,
      rulesVersion: r.rulesVersion,
    });
  }

  return { matched, unmatched, parseFailures: parsed.parseFailures, fatal: false, delimiter: parsed.delimiter };
}

export interface ImportResult {
  imported: number;
  unmatched: UnmatchedRow[];
  parseFailures: ParseFailure[];
  fatal: boolean;
  fatalReason?: string;
}

const upsertOfficial = db.prepare(
  `INSERT INTO iqs_official_scores
     (case_id, case_number, overall, band, case_score, contributor_count, contributors,
      rules_version, report_date, source_note, imported_at)
   VALUES
     (@case_id, @case_number, @overall, @band, @case_score, @contributor_count, @contributors,
      @rules_version, @report_date, @source_note, @imported_at)
   ON CONFLICT(case_id) DO UPDATE SET
     case_number        = excluded.case_number,
     overall            = excluded.overall,
     band               = excluded.band,
     case_score         = excluded.case_score,
     contributor_count  = excluded.contributor_count,
     contributors       = excluded.contributors,
     rules_version      = excluded.rules_version,
     report_date        = excluded.report_date,
     source_note        = excluded.source_note,
     imported_at        = excluded.imported_at`,
);

/**
 * Parses, matches, and writes. `case_id` is the table's primary key, so
 * re-importing the same export (or a later one covering the same case)
 * updates the existing row in place rather than duplicating it.
 */
export function importOfficialScores(raw: string, sourceNote?: string): ImportResult {
  const parsed = parseOfficialImport(raw);
  if (parsed.fatal) {
    return { imported: 0, unmatched: [], parseFailures: parsed.parseFailures, fatal: true, fatalReason: parsed.fatalReason };
  }

  const width = caseNumberWidth();
  const unmatched: UnmatchedRow[] = [];
  let imported = 0;

  for (const r of parsed.rows) {
    const c = resolveCaseRow(r.caseNumber, width);
    if (!c) {
      unmatched.push({ caseNumber: r.caseNumber, line: r.line });
      continue;
    }
    const band: Band = bandFor(r.overall / 100);
    upsertOfficial.run({
      case_id: c.id,
      case_number: c.case_number,
      overall: r.overall,
      band,
      case_score: r.caseScore,
      contributor_count: r.contributorCount,
      contributors: r.contributors,
      rules_version: r.rulesVersion,
      report_date: r.reportDate,
      source_note: sourceNote || null,
      imported_at: now(),
    });
    imported++;
  }

  return { imported, unmatched, parseFailures: parsed.parseFailures, fatal: false };
}

export interface OfficialComparison {
  caseNumber: string;
  predicted: number | null;
  official: number;
  delta: number | null;
  importedAt: number;
}

/**
 * Predicted (Layer 1) vs official, side by side. Never averaged -- phase 0's
 * rule, because the two are not measuring with the same dimensions or
 * weights and a blended number would imply a precision neither has.
 * `official` here is Contributor Score (see the module doc comment) --
 * `overall` has meant that specifically since v9 phase 1.
 */
export function listOfficialComparisons(): OfficialComparison[] {
  const rows = db
    .prepare(
      `SELECT o.case_number, o.overall AS official, o.imported_at,
              l1.overall AS predicted
       FROM iqs_official_scores o
       LEFT JOIN iqs_scores l1 ON l1.case_id = o.case_id AND l1.layer = 'layer1'
       ORDER BY o.imported_at DESC`,
    )
    .all() as Array<{ case_number: string; official: number; imported_at: number; predicted: number | null }>;

  return rows.map((r) => ({
    caseNumber: r.case_number,
    predicted: r.predicted,
    official: r.official,
    delta: r.predicted === null ? null : Math.round((r.predicted - r.official) * 100) / 100, // v9 phase 3: 2 decimals, matching predicted's own precision now
    importedAt: r.imported_at,
  }));
}
