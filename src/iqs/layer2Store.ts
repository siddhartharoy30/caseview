/**
 * Persistence, policy and measurement for Layer 2.
 *
 * ./layer2 decides what a score IS. This file decides whether the call should
 * happen at all, remembers the answer, and records what it cost. The split is
 * deliberate: the scorer stays a function of its input and can be exercised
 * with a literal, while every rule that depends on the state of the world --
 * the cache, the budget, the throttle, the sweep -- is in one place where it
 * can be read end to end.
 *
 * Three things this file is responsible for:
 *
 *   1. THE CACHE IS BY CONTENT, NOT BY CLOCK. A stored row is reusable exactly
 *      when contentHash() over today's facts equals the hash on the row. Text
 *      that has not changed is never re-scored, and a rubric, prompt or model
 *      move invalidates every row at once without a sweep to expire them.
 *
 *   2. THE LEDGER IS THE MEASUREMENT. Phase 3's gate is "cost and hit rate
 *      visible", and neither number survives in iqs_scores: a hit writes no
 *      score row and a miss overwrites the row it replaces. So every decision
 *      writes to iqs_layer2_usage, hits included. It is append-only.
 *
 *   3. LAYER 1 IS NEVER BLOCKED. Nothing here is called from the sync path.
 *      With no token every entry point returns a reason instead of a score,
 *      and the /iqs page renders that reason. A Layer 2 outage costs the
 *      delta column, never a page.
 *
 * Money: the daily cap is enforced against the ledger's own local estimate,
 * not a bill -- the gateway reports no spend. The estimate is deliberately
 * list-price and slightly pessimistic; its job is to stop a runaway loop, not
 * to reconcile an invoice.
 */

import { config } from "../config";
import { db } from "../db";
import { log } from "../log";
import { RUBRIC_VERSION } from "./rubric";
import type { Band, Keyword } from "./rubric";
import { loadCaseFacts } from "./store";
import { detectKeywordFromComments } from "./layer1";
import {
  LAYER as LAYER2,
  PROMPT_VERSION,
  availability,
  contentHash,
  scorableComments,
  scoreWithModel,
} from "./layer2";
import type { Layer2Score, Layer2Unavailable } from "./layer2";

export { LAYER2 };

/** Read at call time, never captured: the config is a live object. */
const CFG = () => config.iqs.layer2;

/* ------------------------------------------------------------ statements */

const selectRowById = db.prepare(
  "SELECT detail, content_hash, scored_at FROM iqs_scores WHERE case_id = ? AND layer = '" + LAYER2 + "'",
);

const selectRowByNumber = db.prepare(
  "SELECT case_id, detail, content_hash, scored_at FROM iqs_scores WHERE case_number = ? AND layer = '" + LAYER2 + "'",
);

const upsertScore = db.prepare(`
  INSERT INTO iqs_scores
    (case_id, layer, case_number, keyword, overall, band, detail, rubric_version, content_hash, scored_at)
  VALUES
    (@case_id, @layer, @case_number, @keyword, @overall, @band, @detail, @rubric_version, @content_hash, @scored_at)
  ON CONFLICT(case_id, layer) DO UPDATE SET
    case_number    = excluded.case_number,
    keyword        = excluded.keyword,
    overall        = excluded.overall,
    band           = excluded.band,
    detail         = excluded.detail,
    rubric_version = excluded.rubric_version,
    content_hash   = excluded.content_hash,
    scored_at      = excluded.scored_at
`);

const insertUsage = db.prepare(`
  INSERT INTO iqs_layer2_usage
    (case_id, case_number, content_hash, model, outcome, reason,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
     cost_usd, ms, source, created_at)
  VALUES
    (@case_id, @case_number, @content_hash, @model, @outcome, @reason,
     @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens,
     @cost_usd, @ms, @source, @created_at)
`);

const sumSpendSince = db.prepare(
  "SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM iqs_layer2_usage WHERE created_at >= ?",
);

const pruneUsage = db.prepare("DELETE FROM iqs_layer2_usage WHERE created_at < ?");

/* ----------------------------------------------------------------- types */

/** Where a score came from, which is the only thing a caller cannot infer. */
export type Layer2Origin = "cache" | "fresh";

export type Layer2StoreResult =
  | { ok: true; origin: Layer2Origin; score: Layer2Score }
  | (Layer2Unavailable & { origin?: undefined });

export interface Layer2Options {
  /** Score even if the stored hash still matches. Costs money; the UI asks. */
  force?: boolean;
  /** Override the detected keyword, for the case where the detector is wrong. */
  keyword?: Keyword;
  /** Tags the ledger row so demand and sweep spend can be told apart. */
  source?: "demand" | "sweep";
}

interface StoredRow {
  detail: string;
  content_hash: string | null;
  scored_at: number;
}

/* --------------------------------------------------------------- helpers */

/**
 * Start of today, UTC.
 *
 * The cap is a spend-per-day guard, not an accounting period, so the boundary
 * only has to be stable and explainable. UTC is both, and the container runs
 * on it; a local-time boundary would move under a timezone change and silently
 * grant or steal a day of budget.
 */
export function startOfUtcDay(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function spentSince(sinceMs: number): number {
  const r = sumSpendSince.get(sinceMs) as { spend: number } | undefined;
  return Math.round(Number(r?.spend || 0) * 1e6) / 1e6;
}

export function spentToday(now = Date.now()): number {
  return spentSince(startOfUtcDay(now));
}

/** Record one decision. Never throws: measurement must not break the thing. */
function ledger(row: {
  caseId?: string | null;
  caseNumber?: string | null;
  contentHash?: string | null;
  model: string;
  outcome: "hit" | "miss" | "error" | "skipped";
  reason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  ms?: number;
  source?: "demand" | "sweep";
}): void {
  try {
    insertUsage.run({
      case_id: row.caseId ?? null,
      case_number: row.caseNumber ?? null,
      content_hash: row.contentHash ?? null,
      model: row.model,
      outcome: row.outcome,
      reason: row.reason ?? null,
      input_tokens: row.inputTokens ?? 0,
      output_tokens: row.outputTokens ?? 0,
      cache_read_tokens: row.cacheReadTokens ?? 0,
      cache_write_tokens: row.cacheWriteTokens ?? 0,
      cost_usd: row.costUsd ?? 0,
      ms: row.ms ?? 0,
      source: row.source ?? "demand",
      created_at: Date.now(),
    });
  } catch (err) {
    log.warn("iqs.layer2.ledger_failed", { error: String(err) });
  }
}

/**
 * Space calls out by minIntervalMs.
 *
 * One shared gate for demand and sweep alike, because the gateway does not
 * care which of the two is talking to it. A sweep that fires while someone is
 * clicking Score should queue behind them, not race them.
 */
let lastCallAt = 0;
let chain: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const run = chain.then(async () => {
    const wait = lastCallAt + CFG().minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  // Keep the chain alive even if a link rejects; a failed call must not wedge
  // every later one behind a permanently rejected promise.
  chain = run.catch(() => undefined);
  return run;
}

/* ------------------------------------------------------------------ read */

function readStored(caseId: string): { score: Layer2Score; hash: string | null } | null {
  const r = selectRowById.get(caseId) as StoredRow | undefined;
  if (!r) return null;
  try {
    return { score: JSON.parse(r.detail) as Layer2Score, hash: r.content_hash };
  } catch (err) {
    log.warn("iqs.layer2.detail_unreadable", { caseId, error: String(err) });
    return null;
  }
}

/**
 * What the /iqs page and the Quality tab read: the stored score plus whether
 * it still describes the case as it is now.
 *
 * Staleness is answered by rehashing, not by comparing timestamps, so a case
 * that has been synced ten times without a new comment of mine reads fresh.
 * Returned rather than hidden: a stale score is still worth showing next to a
 * Score again button, and pretending it does not exist would be worse.
 */
export interface Layer2Stored {
  score: Layer2Score | null;
  stale: boolean;
  keyword: Keyword | null;
  scorable: number;
}

export function getStoredByNumber(caseNumber: string): Layer2Stored {
  const r = selectRowByNumber.get(caseNumber) as (StoredRow & { case_id: string }) | undefined;
  if (!r) return { score: null, stale: false, keyword: null, scorable: 0 };

  const facts = loadCaseFacts(r.case_id);
  let score: Layer2Score | null = null;
  try {
    score = JSON.parse(r.detail) as Layer2Score;
  } catch (err) {
    log.warn("iqs.layer2.detail_unreadable", { caseNumber, error: String(err) });
    return { score: null, stale: false, keyword: null, scorable: 0 };
  }

  if (!facts) return { score, stale: false, keyword: score.keyword, scorable: 0 };

  const keyword = score.keyword;
  const want = contentHash(facts, keyword, CFG().model);
  return {
    score,
    stale: r.content_hash !== want,
    keyword,
    scorable: scorableComments(facts).length,
  };
}

/* ----------------------------------------------------------------- write */

function persist(score: Layer2Score): void {
  upsertScore.run({
    case_id: score.caseId,
    layer: LAYER2,
    case_number: score.caseNumber,
    keyword: score.keyword,
    overall: score.overall,
    band: score.band,
    detail: JSON.stringify(score),
    // Layer 1's column holds rubric/scorer. The same slot here holds
    // rubric/prompt/model: the three things that change what this layer
    // answers. The content hash already covers all of them, so this is for a
    // human reading the table, not for the cache.
    rubric_version: score.rubricVersion + "/" + score.promptVersion + "/" + score.model,
    content_hash: score.contentHash,
    scored_at: score.scoredAt,
  });
}

/* ---------------------------------------------------------------- budget */

export interface BudgetState {
  dailyUsd: number;
  spentToday: number;
  remainingUsd: number;
  exhausted: boolean;
}

export function budgetState(now = Date.now()): BudgetState {
  const dailyUsd = CFG().dailyBudgetUsd;
  const spent = spentToday(now);
  const remaining = Math.max(0, Math.round((dailyUsd - spent) * 1e6) / 1e6);
  // A cap of zero means "no cap", not "never spend". Turning the layer off is
  // what IQS_LAYER2=off is for, and conflating the two would make a
  // misconfigured number look like a deliberate shutdown.
  return { dailyUsd, spentToday: spent, remainingUsd: remaining, exhausted: dailyUsd > 0 && spent >= dailyUsd };
}

/* ------------------------------------------------------------- the entry */

/**
 * Score one case, or explain why not.
 *
 * The order of the gates is the order of what they cost. Availability is free.
 * The cache read is one indexed row. The budget check is one aggregate. Only
 * then does anything leave the process. Every branch writes a ledger row, so
 * the hit rate on the /iqs page counts the same decisions this function makes.
 */
export async function scoreLayer2(
  caseId: string,
  opts: Layer2Options = {},
): Promise<Layer2StoreResult> {
  const source = opts.source ?? "demand";
  const model = CFG().model;

  const avail = availability();
  if (!avail.enabled) {
    const reason = CFG().enabled ? ("no-token" as const) : ("disabled" as const);
    ledger({ caseId, model, outcome: "skipped", reason: avail.reason, source });
    return { ok: false, reason, detail: avail.reason };
  }

  const facts = loadCaseFacts(caseId);
  if (!facts) {
    return { ok: false, reason: "error", detail: "That case is not in the cache." };
  }

  const comments = scorableComments(facts);
  if (!comments.length) {
    const detail = "This case has no comments of mine to score.";
    ledger({ caseId, caseNumber: facts.caseNumber, model, outcome: "skipped", reason: "no-content", source });
    return { ok: false, reason: "no-content", detail };
  }

  const keyword = opts.keyword || detectKeywordFromComments(facts.status, facts.comments);
  const hash = contentHash(facts, keyword, model);

  /* --- cache ---------------------------------------------------------- */

  if (!opts.force) {
    const stored = readStored(caseId);
    if (stored && stored.hash === hash) {
      ledger({
        caseId,
        caseNumber: facts.caseNumber,
        contentHash: hash,
        model,
        outcome: "hit",
        source,
      });
      return { ok: true, origin: "cache", score: stored.score };
    }
  }

  /* --- budget --------------------------------------------------------- */

  const budget = budgetState();
  if (budget.exhausted) {
    const detail =
      "The daily Layer 2 budget of $" +
      budget.dailyUsd.toFixed(2) +
      " is spent ($" +
      budget.spentToday.toFixed(4) +
      " today). It resets at 00:00 UTC.";
    ledger({ caseId, caseNumber: facts.caseNumber, contentHash: hash, model, outcome: "skipped", reason: "budget", source });
    return { ok: false, reason: "budget", detail };
  }

  /* --- call ----------------------------------------------------------- */

  await throttle();
  const result = await scoreWithModel(facts, keyword);

  if (!result.ok) {
    ledger({
      caseId,
      caseNumber: facts.caseNumber,
      contentHash: hash,
      model,
      outcome: result.reason === "error" ? "error" : "skipped",
      reason: result.reason + ": " + result.detail,
      source,
    });
    return result;
  }

  const score = result.score;
  persist(score);
  ledger({
    caseId,
    caseNumber: score.caseNumber,
    contentHash: score.contentHash,
    model: score.model,
    outcome: "miss",
    inputTokens: score.usage.inputTokens,
    outputTokens: score.usage.outputTokens,
    cacheReadTokens: score.usage.cacheReadTokens,
    cacheWriteTokens: score.usage.cacheWriteTokens,
    costUsd: score.usage.costUsd,
    ms: score.usage.ms,
    source,
  });

  return { ok: true, origin: "fresh", score };
}

/** Same entry, addressed the way the HTTP layer addresses cases. */
export async function scoreLayer2ByNumber(
  caseNumber: string,
  opts: Layer2Options = {},
): Promise<Layer2StoreResult> {
  const r = db
    .prepare("SELECT id FROM cases WHERE case_number = ?")
    .get(caseNumber) as { id: string } | undefined;
  if (!r) return { ok: false, reason: "error", detail: "That case is not in the cache." };
  return scoreLayer2(r.id, opts);
}

/* ------------------------------------------------------------- the sweep */

/**
 * What a stored row was produced by, for a human reading the table.
 *
 * Also the sweep's cheap staleness proxy: a row stamped with a different
 * triple cannot be current whatever its content hash says.
 */
function stamp(): string {
  return RUBRIC_VERSION + "/" + PROMPT_VERSION + "/" + CFG().model;
}

/*
 * SQL narrows, the hash decides.
 *
 * Rehashing every case to find the few that changed would mean loading facts
 * for the whole cache on a timer. This query finds cases that CANNOT be
 * current -- never scored, scored under a different rubric/prompt/model, or
 * scored before my newest comment -- and scoreLayer2 makes the exact call from
 * the hash. A false positive costs one cache hit and a ledger row, which is
 * the right direction to be wrong in: the COALESCE below deliberately treats
 * an unparseable date as "might be stale" rather than skipping the case
 * forever.
 */
const selectCandidates = db.prepare(`
  SELECT * FROM (
    SELECT c.id AS id,
           c.case_number AS case_number,
           (SELECT MAX(created_date) FROM comments WHERE case_id = c.id AND is_mine = 1) AS last_mine,
           s.case_id AS scored_id,
           s.rubric_version AS stamp,
           s.scored_at AS scored_at
    FROM cases c
    LEFT JOIN iqs_scores s ON s.case_id = c.id AND s.layer = '${LAYER2}'
    WHERE c.is_closed = 0
  )
  WHERE last_mine IS NOT NULL
    AND (
      scored_id IS NULL
      OR stamp <> @stamp
      OR scored_at < COALESCE(CAST(strftime('%s', last_mine) AS INTEGER) * 1000, scored_at + 1)
    )
  ORDER BY last_mine DESC
  LIMIT @limit
`);

interface CandidateRow {
  id: string;
  case_number: string;
  last_mine: string | null;
}

/** Open cases that cannot currently hold a valid Layer 2 score. */
export function layer2Candidates(limit = 500): CandidateRow[] {
  return selectCandidates.all({ stamp: stamp(), limit }) as CandidateRow[];
}

export interface SweepRun {
  at: number;
  considered: number;
  fresh: number;
  hits: number;
  skipped: number;
  errors: number;
  costUsd: number;
  ms: number;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInFlight = false;
let lastSweep: SweepRun | null = null;

export function lastSweepRun(): SweepRun | null {
  return lastSweep;
}

/**
 * Score a handful of the stalest open cases.
 *
 * Small and slow on purpose. The point of the sweep is that the /iqs page is
 * already populated when it is opened, not that the whole cache is scored;
 * a batch of three every twenty minutes reaches roughly two hundred cases a
 * day for a few cents, and the budget stops it long before that matters.
 */
export async function runSweep(): Promise<SweepRun | null> {
  if (sweepInFlight) return null;
  const avail = availability();
  if (!avail.enabled) return null;
  if (budgetState().exhausted) {
    log.info("iqs.layer2.sweep_skipped", { reason: "budget" });
    return null;
  }

  sweepInFlight = true;
  const t0 = Date.now();
  const run: SweepRun = { at: t0, considered: 0, fresh: 0, hits: 0, skipped: 0, errors: 0, costUsd: 0, ms: 0 };

  try {
    const batch = layer2Candidates(CFG().sweepBatch);
    run.considered = batch.length;

    for (const c of batch) {
      const r = await scoreLayer2(c.id, { source: "sweep" });
      if (r.ok) {
        if (r.origin === "fresh") {
          run.fresh++;
          run.costUsd += r.score.usage.costUsd;
        } else {
          run.hits++;
        }
      } else if (r.reason === "error") {
        run.errors++;
      } else {
        run.skipped++;
        // A budget stop applies to the rest of the batch too.
        if (r.reason === "budget") break;
      }
    }
  } catch (err) {
    log.warn("iqs.layer2.sweep_failed", { error: String(err) });
  } finally {
    sweepInFlight = false;
  }

  run.ms = Date.now() - t0;
  run.costUsd = Math.round(run.costUsd * 1e6) / 1e6;
  lastSweep = run;
  if (run.fresh || run.errors) log.info("iqs.layer2.sweep", run as unknown as Record<string, unknown>);
  return run;
}

/** Delete ledger rows past the retention window. Returns how many went. */
export function pruneLedger(now = Date.now()): number {
  const days = CFG().usageRetentionDays;
  if (days <= 0) return 0;
  const info = pruneUsage.run(now - days * 86400000);
  return Number(info.changes || 0);
}

/**
 * Start the background sweep.
 *
 * Called from the server bootstrap, never from a module top level: importing
 * this file must not start work, or a script that only wanted getLayer2Stats
 * would begin spending money.
 */
export function startLayer2Sweep(): void {
  if (sweepTimer) return;
  const minutes = CFG().sweepMinutes;
  if (minutes <= 0) {
    log.info("iqs.layer2.sweep_disabled", { reason: "IQS_LAYER2_SWEEP_MINUTES is 0" });
    return;
  }
  const avail = availability();
  if (!avail.enabled) {
    log.info("iqs.layer2.sweep_disabled", { reason: avail.reason });
    return;
  }

  pruneLedger();

  // One run shortly after boot, so a restart does not blank the page for a
  // full interval. Delayed, not immediate: the first sync is more urgent
  // and the two would otherwise contend for the same rows.
  const first = setTimeout(() => { void runSweep(); }, 45000);
  if (typeof first.unref === "function") first.unref();

  sweepTimer = setInterval(() => {
    pruneLedger();
    void runSweep();
  }, minutes * 60000);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  log.info("iqs.layer2.sweep_started", { everyMinutes: minutes, batch: CFG().sweepBatch, model: CFG().model });
}

export function stopLayer2Sweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/* ------------------------------------------------------------------ meta */

export interface Layer2Meta {
  enabled: boolean;
  reason: string;
  model: string;
  promptVersion: string;
  rubricVersion: string;
  budget: BudgetState;
  sweep: {
    everyMinutes: number;
    batch: number;
    /** A sweep is in flight right now. */
    running: boolean;
    /** The timer is armed. False means no sweep will happen unprompted. */
    scheduled: boolean;
    last: SweepRun | null;
  };
}

export function layer2Meta(): Layer2Meta {
  const a = availability();
  return {
    enabled: a.enabled,
    reason: a.reason,
    model: a.model,
    promptVersion: PROMPT_VERSION,
    rubricVersion: RUBRIC_VERSION,
    budget: budgetState(),
    sweep: {
      everyMinutes: CFG().sweepMinutes,
      batch: CFG().sweepBatch,
      running: sweepInFlight,
      scheduled: sweepTimer !== null,
      last: lastSweep,
    },
  };
}

/* ----------------------------------------------------------------- stats */

export interface Layer2Stats {
  scored: number;
  average: number | null;
  meeting: number;
  partial: number;
  notMeeting: number;
  lastScoredAt: number | null;

  /** Ledger roll-up over the window. This is the gate: cost and hit rate. */
  windowDays: number;
  hits: number;
  misses: number;
  errors: number;
  skipped: number;
  hitRate: number | null;
  avgMs: number | null;

  spendToday: number;
  spend7d: number;
  spend30d: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;

  /** Open cases that cannot currently hold a valid score. */
  queueDepth: number;
}

const DAY = 86400000;

export function getLayer2Stats(windowDays = 30, now = Date.now()): Layer2Stats {
  const since = now - windowDays * DAY;

  const s = db
    .prepare(
      "SELECT COUNT(*) AS scored, AVG(overall) AS average," +
        " SUM(CASE WHEN band = 'meeting' THEN 1 ELSE 0 END) AS meeting," +
        " SUM(CASE WHEN band = 'partial' THEN 1 ELSE 0 END) AS partial," +
        " SUM(CASE WHEN band = 'not_meeting' THEN 1 ELSE 0 END) AS not_meeting," +
        " MAX(scored_at) AS last_scored_at" +
        " FROM iqs_scores WHERE layer = '" + LAYER2 + "'",
    )
    .get() as Record<string, number | null>;

  const u = db
    .prepare(
      "SELECT" +
        " SUM(CASE WHEN outcome = 'hit' THEN 1 ELSE 0 END) AS hits," +
        " SUM(CASE WHEN outcome = 'miss' THEN 1 ELSE 0 END) AS misses," +
        " SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors," +
        " SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) AS skipped," +
        " SUM(input_tokens) AS input_tokens," +
        " SUM(output_tokens) AS output_tokens," +
        " SUM(cache_read_tokens) AS cache_read_tokens," +
        " SUM(cache_write_tokens) AS cache_write_tokens," +
        " AVG(CASE WHEN outcome = 'miss' THEN ms END) AS avg_ms" +
        " FROM iqs_layer2_usage WHERE created_at >= ?",
    )
    .get(since) as Record<string, number | null>;

  const hits = Number(u.hits || 0);
  const misses = Number(u.misses || 0);
  const decided = hits + misses;

  return {
    scored: Number(s.scored || 0),
    average: s.average === null ? null : Math.round(Number(s.average) * 10) / 10,
    meeting: Number(s.meeting || 0),
    partial: Number(s.partial || 0),
    notMeeting: Number(s.not_meeting || 0),
    lastScoredAt: s.last_scored_at === null ? null : Number(s.last_scored_at),

    windowDays,
    hits,
    misses,
    errors: Number(u.errors || 0),
    skipped: Number(u.skipped || 0),
    // Only decisions that could have gone either way count. Folding skips in
    // would let an unreachable gateway inflate the hit rate to look thrifty.
    hitRate: decided ? Math.round((hits / decided) * 1000) / 10 : null,
    avgMs: u.avg_ms === null ? null : Math.round(Number(u.avg_ms)),

    spendToday: spentToday(now),
    spend7d: spentSince(now - 7 * DAY),
    spend30d: spentSince(now - 30 * DAY),
    inputTokens: Number(u.input_tokens || 0),
    outputTokens: Number(u.output_tokens || 0),
    cacheReadTokens: Number(u.cache_read_tokens || 0),
    cacheWriteTokens: Number(u.cache_write_tokens || 0),

    queueDepth: layer2Candidates(5000).length,
  };
}

/* ------------------------------------------------------------ the delta */

/**
 * Cases both layers have scored, with the gap between them.
 *
 * This is the product. A positive delta means the regex was harsher than the
 * reader; a negative one means a template phrase satisfied the pattern and not
 * a person. Sorted by the size of the disagreement, because agreement is not
 * news.
 */
export interface Layer2Comparison {
  caseId: string;
  caseNumber: string;
  subject: string | null;
  isClosed: boolean;
  keyword: Keyword;
  layer1: number | null;
  layer1Band: Band | null;
  layer2: number | null;
  layer2Band: Band | null;
  delta: number | null;
  scoredAt: number;
}

export function getComparisons(limit = 100, openOnly = false): Layer2Comparison[] {
  const rows = db
    .prepare(
      "SELECT c.id AS case_id, c.case_number, c.subject, c.is_closed," +
        " a.keyword AS keyword, a.overall AS l1, a.band AS l1_band," +
        " b.overall AS l2, b.band AS l2_band, b.scored_at AS scored_at" +
        " FROM iqs_scores b" +
        " JOIN cases c ON c.id = b.case_id" +
        " LEFT JOIN iqs_scores a ON a.case_id = b.case_id AND a.layer = 'layer1'" +
        " WHERE b.layer = '" + LAYER2 + "'" +
        (openOnly ? " AND c.is_closed = 0" : "") +
        " ORDER BY ABS(COALESCE(a.overall, 0) - COALESCE(b.overall, 0)) DESC, b.scored_at DESC" +
        " LIMIT ?",
    )
    .all(limit) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const l1 = r.l1 === null || r.l1 === undefined ? null : Number(r.l1);
    const l2 = r.l2 === null || r.l2 === undefined ? null : Number(r.l2);
    return {
      caseId: String(r.case_id),
      caseNumber: String(r.case_number),
      subject: (r.subject as string | null) ?? null,
      isClosed: Number(r.is_closed) === 1,
      keyword: r.keyword as Keyword,
      layer1: l1,
      layer1Band: (r.l1_band as Band | null) ?? null,
      layer2: l2,
      layer2Band: (r.l2_band as Band | null) ?? null,
      delta: l1 === null || l2 === null ? null : Math.round((l2 - l1) * 10) / 10,
      scoredAt: Number(r.scored_at || 0),
    };
  });
}

/** The most recent ledger rows, for the /iqs activity list. */
export interface Layer2Activity {
  caseNumber: string | null;
  outcome: string;
  reason: string | null;
  costUsd: number;
  ms: number;
  source: string;
  createdAt: number;
}

export function getRecentActivity(limit = 25): Layer2Activity[] {
  const rows = db
    .prepare(
      "SELECT case_number, outcome, reason, cost_usd, ms, source, created_at" +
        " FROM iqs_layer2_usage ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    caseNumber: (r.case_number as string | null) ?? null,
    outcome: String(r.outcome),
    reason: (r.reason as string | null) ?? null,
    costUsd: Number(r.cost_usd || 0),
    ms: Number(r.ms || 0),
    source: String(r.source || "demand"),
    createdAt: Number(r.created_at || 0),
  }));
}
