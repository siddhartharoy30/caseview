/**
 * SentryAI Tier 3 import (Phase 9): a CSV or pasted table from the IQS
 * Report page, the "working floor" phase 0 decided on when no authenticated
 * session ever materialized for Tier 1 or Tier 2.
 *
 * The exact column names are a guess, disclosed as one: nobody on this
 * project has seen a real SentryAI export. This matches header aliases
 * rather than one exact format, and reports what it understood before
 * committing, so the first real paste is a correction, not a rewrite.
 */

import { db, now } from "../db";
import { getCaseRow } from "../queries";
import { bandFor } from "./rubric";
import type { Band } from "./rubric";

export interface ParsedOfficialRow {
  caseNumber: string;
  overall: number;
}

export interface ParseResult {
  rows: ParsedOfficialRow[];
  warnings: string[];
  /**
   * True only when the paste could not be read at all -- no case or score
   * column found. Distinct from a data row that failed to parse: that is a
   * warning on an otherwise-understood paste, not a reason to call the
   * whole thing a failure. The route uses this to decide 400 vs 200.
   */
  fatal: boolean;
}

const CASE_HEADER_ALIASES = ["case number", "case no.", "case no", "case #", "casenumber", "case"];
const SCORE_HEADER_ALIASES = ["overall score", "iqs score", "quality score", "score", "overall", "iqs"];

function splitCells(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((c) => c.trim().replace(/^["']|["']$/g, ""));
}

/** Whichever of comma, tab, or pipe actually separates the header row into more than one cell. */
function detectDelimiter(headerLine: string): string {
  const candidates = ["\t", ",", "|"];
  let best = ",";
  let bestCount = 1;
  for (const d of candidates) {
    const count = headerLine.split(d).length;
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

function findColumn(headers: string[], aliases: string[]): number {
  const lower = headers.map((h) => h.toLowerCase());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) return idx;
  }
  // Fall back to a substring match -- a real export's header is more likely
  // to be "Case Overall Score" than exactly "score".
  for (const alias of aliases) {
    const idx = lower.findIndex((h) => h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Tolerant on purpose: a row that doesn't parse is skipped with a warning,
 * not a reason to fail the whole paste -- the same "record what you can,
 * say what you couldn't" rule commitments.ts follows for unparseable dates.
 */
export function parseOfficialImport(raw: string): ParseResult {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return { rows: [], warnings: ["Paste needs a header row and at least one data row."], fatal: true };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCells(lines[0], delimiter);
  const caseCol = findColumn(headers, CASE_HEADER_ALIASES);
  const scoreCol = findColumn(headers, SCORE_HEADER_ALIASES);

  if (caseCol === -1) {
    return { rows: [], warnings: [`Could not find a case number column in the header: ${headers.join(", ")}`], fatal: true };
  }
  if (scoreCol === -1) {
    return { rows: [], warnings: [`Could not find a score column in the header: ${headers.join(", ")}`], fatal: true };
  }

  const warnings: string[] = [];
  const rows: ParsedOfficialRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCells(lines[i], delimiter);
    const caseNumber = (cells[caseCol] || "").replace(/\D/g, "");
    const rawScore = (cells[scoreCol] || "").replace("%", "").trim();
    const overall = Number(rawScore);

    if (!caseNumber) {
      warnings.push(`Line ${i + 1}: no case number found, skipped.`);
      continue;
    }
    if (!Number.isFinite(overall)) {
      warnings.push(`Line ${i + 1} (${caseNumber}): "${cells[scoreCol]}" is not a number, skipped.`);
      continue;
    }
    rows.push({ caseNumber, overall: Math.max(0, Math.min(100, overall)) });
  }

  return { rows, warnings, fatal: false };
}

export interface ImportResult {
  imported: number;
  unmatched: string[];
  warnings: string[];
  fatal: boolean;
}

const upsertOfficial = db.prepare(
  `INSERT INTO iqs_official_scores (case_id, case_number, overall, band, source_note, imported_at)
   VALUES (@case_id, @case_number, @overall, @band, @source_note, @imported_at)
   ON CONFLICT(case_id) DO UPDATE SET
     case_number = excluded.case_number,
     overall     = excluded.overall,
     band        = excluded.band,
     source_note = excluded.source_note,
     imported_at = excluded.imported_at`,
);

export function importOfficialScores(raw: string, sourceNote?: string): ImportResult {
  const { rows, warnings, fatal } = parseOfficialImport(raw);
  const unmatched: string[] = [];
  let imported = 0;
  if (fatal) return { imported: 0, unmatched, warnings, fatal: true };

  for (const r of rows) {
    const c = getCaseRow(r.caseNumber);
    if (!c) {
      unmatched.push(r.caseNumber);
      continue;
    }
    const band: Band = bandFor(r.overall / 100);
    upsertOfficial.run({
      case_id: c.id,
      case_number: r.caseNumber,
      overall: r.overall,
      band,
      source_note: sourceNote || null,
      imported_at: now(),
    });
    imported++;
  }

  return { imported, unmatched, warnings, fatal: false };
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
    delta: r.predicted === null ? null : Math.round((r.predicted - r.official) * 10) / 10,
    importedAt: r.imported_at,
  }));
}
