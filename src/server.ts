import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { config } from "./config";
import { COOKIE_NAME, makeSessionToken, requireAuth, sessionEmail, sessionDiagnostic } from "./auth";
import { getCaseByNumber, isEmailAccessDenied } from "./salesforce";
import { computeSla, deriveQueue, deriveNextAction } from "./sla";
import {
  getLatestSuggestedReply,
  saveSuggestedReply,
  allSettings,
  setSetting,
  SETTING_DEFAULTS,
  getSetting,
  getSettingNumber,
  getSyncState,
  cacheCounts,
  rebuildCache,
} from "./db";
import { draftSuggestedReply, repairDraft } from "./claude";
import {
  listCases,
  getCase,
  getCaseRow,
  getTimeline,
  getArtifacts,
  getRelated,
  getJiraLinks,
  listCommitments,
  listCommitmentsForCase,
  duplicateCommitmentCases,
  addManualCommitment,
  updateCommitment,
  renegotiateCommitment,
  commitmentsInRange,
  search,
  patterns,
  badgeCounts,
  facets,
} from "./queries";
import { listTimeOff, addTimeOff, deleteTimeOff, rangeBoundsMs } from "./timeOff";
import {
  listChannels,
  addChannel,
  deleteChannel,
  setActiveChannel,
  sendTestMessage,
  listRecentPosts,
  backtest30Days,
  approvePost,
  discardPost,
} from "./coverage";
import { rubricMeta } from "./iqs/rubric";
import type { Keyword } from "./iqs/rubric";
import {
  getDetail as getIqsDetail,
  getStats as getIqsStats,
  previewDraftScore,
  rescoreStale,
  scoreAndStoreCase,
} from "./iqs/store";
import { mechanicalRepair, repairNotesFor } from "./iqs/layer1";
import {
  getComparisons,
  getLayer2Stats,
  getRecentActivity,
  getStoredByNumber,
  layer2Meta,
  runSweep,
  scoreLayer2ByNumber,
  startLayer2Sweep,
} from "./iqs/layer2Store";
import { resolveRange, scorecard, saveManualMetric, deleteManualMetric } from "./metrics";
import { syncOnce, startSync, reconcileCommitments } from "./sync";
import { listEvents, sendWebhookTest } from "./notify";
import { log, errText } from "./log";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

/** Static assets are noise in the log unless they actually failed. */
const STATIC_PATH = /^\/(css|js|img|fonts|favicon)/;

/**
 * One line per request.
 *
 * The server used to say nothing at all about traffic, which made a
 * user-reported "signing in bounces me straight back" impossible to
 * investigate: the logs looked identical whether the browser never reached the
 * box, sent no cookie, or sent one the server rejected. `session` separates
 * those three.
 *
 * Only the path is recorded, never the query string -- case numbers, account
 * names and search terms travel there, and this log is customer data.
 */
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (STATIC_PATH.test(req.path) && res.statusCode < 400) return;
    log.info("http.request", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
      session: sessionDiagnostic(req),
    });
  });
  next();
});

const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 12 * 60 * 60 * 1000,
};

/** Cache reads must never be served stale by a proxy or the browser. */
function noStore(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.set("Cache-Control", "no-store");
  next();
}

/* -------------------------------------------------------------------- auth */

/**
 * Paths a session cookie may have been scoped to by an earlier build.
 *
 * A cookie at a narrower path is offered ahead of the one at "/" and cannot be
 * overwritten by re-issuing at "/", so signing in again would never displace
 * it. Expiring these explicitly is what stops a bad cookie from wedging the
 * app permanently. The cookie at "/" needs no entry here: the Set-Cookie
 * issued just below replaces it.
 */
const LEGACY_COOKIE_PATHS = ["/api", "/api/auth"];

function clearLegacyCookies(res: express.Response) {
  for (const p of LEGACY_COOKIE_PATHS) res.clearCookie(COOKIE_NAME, { path: p });
}

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim();
  if (!email || email.toLowerCase() !== config.auth.allowedEmail.toLowerCase()) {
    log.warn("auth.rejected", { reason: email ? "address not allowed" : "empty address" });
    return res.status(401).json({ error: "Not an authorised email address" });
  }
  clearLegacyCookies(res);
  res.cookie(COOKIE_NAME, makeSessionToken(email), SESSION_COOKIE_OPTS);
  log.info("auth.login");
  res.json({ ok: true, email });
});

app.post("/api/auth/logout", (_req, res) => {
  clearLegacyCookies(res);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const email = sessionEmail(req);
  res.json({ authenticated: !!email, email: email || null });
});

/* ------------------------------------------------------------------- cases */

/**
 * The queue, served from the local cache.
 *
 * This used to call Salesforce on every request. It now reads SQLite and
 * returns `syncedAt` so the client can show how old the data is; the field
 * names are otherwise unchanged.
 */
app.get("/api/cases", requireAuth, noStore, (req, res) => {
  try {
    const cases = listCases({
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      priority: typeof req.query.priority === "string" ? req.query.priority : undefined,
      account: typeof req.query.account === "string" ? req.query.account : undefined,
      productArea: typeof req.query.productArea === "string" ? req.query.productArea : undefined,
      needsReply: req.query.needsReply === "1",
      escalated: req.query.escalated === "1",
      q: typeof req.query.q === "string" ? req.query.q : undefined,
    });

    // Legacy fields the existing dashboard still reads.
    const enriched = cases.map((c) => {
      const legacy = {
        Priority: c.priority,
        CreatedDate: c.createdDate,
        Status: c.status,
        IsClosed: c.isClosed,
        IsEscalated: c.isEscalated,
        Origin: c.origin,
        Type: c.type,
        Last_Customer_Update__c: c.lastCustomerUpdate,
        NCC_date__c: c.ncc,
      } as any;
      // Falls back to UPDATE (the generic "review it" bucket) on the rare
      // case that has not been through Layer 1 scoring yet -- new since the
      // last sync, scored moments later, never actually unscored on screen.
      return {
        ...c,
        queue: deriveQueue(legacy),
        sla: computeSla(legacy),
        nextAction: deriveNextAction(legacy, c.iqs?.keyword ?? "UPDATE"),
      };
    });

    const state = getSyncState();
    res.json({
      cases: enriched,
      sync: {
        lastSuccess: state.last_success,
        lastAttempt: state.last_attempt,
        lastError: state.last_error,
        errorCount: state.error_count,
        running: !!state.running,
      },
    });
  } catch (err: any) {
    log.error("api.cases_failed", { error: errText(err) });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/cases/search", requireAuth, noStore, (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ cases: [] });
  res.json({ cases: listCases({ status: "all", q }).slice(0, 25) });
});

app.get("/api/facets", requireAuth, noStore, (req, res) => {
  // ?scope=all widens the filter options to closed cases too, for the
  // "Recently Closed" saved view.
  res.json(facets(req.query.scope !== "all"));
});

app.get("/api/counts", requireAuth, noStore, (_req, res) => {
  res.json(badgeCounts(getSettingNumber("atRiskHours")));
});

app.get("/api/cases/:caseNumber", requireAuth, noStore, (req, res) => {
  const c = getCase(req.params.caseNumber);
  if (!c) return res.status(404).json({ error: "Case not in cache" });
  res.json({ case: c, commitments: listCommitmentsForCase(req.params.caseNumber) });
});

app.get("/api/cases/:caseNumber/timeline", requireAuth, noStore, (req, res) => {
  res.json({
    entries: getTimeline(req.params.caseNumber),
    emailsUnavailable: isEmailAccessDenied(),
  });
});

app.get("/api/cases/:caseNumber/artifacts", requireAuth, noStore, (req, res) => {
  res.json({ groups: getArtifacts(req.params.caseNumber) });
});

app.get("/api/cases/:caseNumber/related", requireAuth, noStore, (req, res) => {
  res.json({ cases: getRelated(req.params.caseNumber), jira: getJiraLinks(req.params.caseNumber) });
});

/**
 * The full quality breakdown. Deliberately its own route: the queue carries
 * only the three summary columns, so a 200-row page never pays to deserialize
 * 200 dimension trees.
 */
app.get("/api/cases/:caseNumber/iqs", requireAuth, noStore, (req, res) => {
  const c = getCaseRow(req.params.caseNumber);
  if (!c) return res.status(404).json({ error: "Case not in cache" });

  let score = getIqsDetail(req.params.caseNumber);
  // A case synced before this feature existed has no row yet. Score it now
  // rather than showing an empty tab — it is local work, not an API call.
  if (!score) score = scoreAndStoreCase(c.id);

  if (!score) return res.status(404).json({ error: "No score for this case" });
  res.json({ score, rubric: rubricMeta() });
});

app.get("/api/iqs/stats", requireAuth, noStore, (req, res) => {
  res.json({ stats: getIqsStats(req.query.open === "1") });
});

/* ------------------------------------------------------------- layer 2 */

/**
 * The stored model score, if there is one.
 *
 * Never scores on read. A GET that could spend money would make every page
 * refresh a purchase, so this returns null and lets the UI offer the button.
 * The meta block travels with it because "there is no score" and "there can
 * be no score, here is why" are different answers and the page renders them
 * differently.
 */
app.get("/api/cases/:caseNumber/iqs/layer2", requireAuth, noStore, (req, res) => {
  const c = getCaseRow(req.params.caseNumber);
  if (!c) return res.status(404).json({ error: "Case not in cache" });
  const stored = getStoredByNumber(req.params.caseNumber);
  res.json({ ...stored, meta: layer2Meta() });
});

/**
 * Score on demand. POST because it costs money and is not idempotent when
 * force is set.
 */
app.post("/api/cases/:caseNumber/iqs/layer2", requireAuth, noStore, async (req, res) => {
  const c = getCaseRow(req.params.caseNumber);
  if (!c) return res.status(404).json({ error: "Case not in cache" });

  const force = req.query.force === "1" || req.body?.force === true;
  const keyword = typeof req.body?.keyword === "string" ? req.body.keyword : undefined;

  try {
    const r = await scoreLayer2ByNumber(req.params.caseNumber, { force, keyword: keyword as never });
    if (!r.ok) {
      // Not an HTTP error: "the budget is spent" and "no token is configured"
      // are answers the page shows, not failures it should retry.
      return res.json({ ok: false, reason: r.reason, detail: r.detail, meta: layer2Meta() });
    }
    res.json({ ok: true, origin: r.origin, score: r.score, meta: layer2Meta() });
  } catch (err) {
    log.error("iqs.layer2.route_failed", { caseNumber: req.params.caseNumber, error: errText(err) });
    res.status(500).json({ ok: false, reason: "error", detail: errText(err) });
  }
});

/** Everything the /iqs page needs, in one round trip. */
app.get("/api/iqs/overview", requireAuth, noStore, (req, res) => {
  const openOnly = req.query.open === "1";
  const windowDays = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  res.json({
    layer1: getIqsStats(openOnly),
    layer2: getLayer2Stats(windowDays),
    meta: layer2Meta(),
    rubric: rubricMeta(),
    comparisons: getComparisons(Math.min(500, Number(req.query.limit) || 100), openOnly),
    activity: getRecentActivity(25),
  });
});

/** Run the sweep now rather than waiting for the timer. */
app.post("/api/iqs/sweep", requireAuth, noStore, async (_req, res) => {
  try {
    const run = await runSweep();
    res.json({ run, meta: layer2Meta() });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

/**
 * "Open in Salesforce" goes through the server so the org's instance URL never
 * ships in the client bundle. The browser only ever knows the case number.
 */
app.get("/go/case/:caseNumber", requireAuth, noStore, (req, res) => {
  const c = getCase(req.params.caseNumber);
  if (!c) return res.status(404).send("Case not in cache");
  const base = config.salesforce.instanceUrl.replace(/\/+$/, "");
  res.redirect(`${base}/lightning/r/Case/${c.id}/view`);
});

/* ------------------------------------------------------------- commitments */

app.get("/api/commitments", requireAuth, noStore, (req, res) => {
  const states =
    typeof req.query.state === "string" && req.query.state
      ? req.query.state.split(",").map((s) => s.trim())
      : undefined;
  res.json({
    commitments: listCommitments(states),
    duplicates: duplicateCommitmentCases(),
    atRiskHours: getSettingNumber("atRiskHours"),
  });
});

app.post("/api/commitments", requireAuth, (req, res) => {
  const { caseNumber, dueAt, text, note } = req.body || {};
  if (!caseNumber || !text) return res.status(400).json({ error: "caseNumber and text are required" });
  try {
    const id = addManualCommitment(caseNumber, dueAt || null, String(text), note);
    reconcileCommitments();
    res.json({ ok: true, id });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/commitments/:id", requireAuth, (req, res) => {
  const { dueAt, state, note, rawText, renegotiate } = req.body || {};
  try {
    if (renegotiate) {
      if (!dueAt) return res.status(400).json({ error: "renegotiate needs a new dueAt" });
      const id = renegotiateCommitment(req.params.id, dueAt, rawText, note);
      return res.json({ ok: true, id });
    }
    updateCommitment(req.params.id, { dueAt, state, note, rawText });
    reconcileCommitments();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Phase 6's pre-flight: what falls due in a date range. Used both for an
 * ad-hoc preview while a new time-off range is being picked (before it's
 * saved) and for viewing an already-saved range -- the same query either way.
 */
app.get("/api/commitments/range", requireAuth, noStore, (req, res) => {
  const start = String(req.query.start || "");
  const end = String(req.query.end || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: "start and end must be YYYY-MM-DD" });
  }
  const { startIso, endIso } = rangeBoundsMs(start, end);
  res.json({ commitments: commitmentsInRange(startIso, endIso) });
});

/* ------------------------------------------------------------- time off */

app.get("/api/time-off", requireAuth, noStore, (_req, res) => {
  res.json({ ranges: listTimeOff() });
});

app.post("/api/time-off", requireAuth, (req, res) => {
  const { startDate, endDate, note } = req.body || {};
  try {
    const range = addTimeOff(String(startDate || ""), String(endDate || ""), note ? String(note) : null);
    res.json({ ok: true, range });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/time-off/:id", requireAuth, (req, res) => {
  deleteTimeOff(req.params.id);
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- metrics */

app.get("/api/metrics", requireAuth, noStore, (req, res) => {
  const range = resolveRange(
    String(req.query.period || "week"),
    typeof req.query.from === "string" ? req.query.from : undefined,
    typeof req.query.to === "string" ? req.query.to : undefined,
  );
  res.json(scorecard(range));
});

app.post("/api/metrics/manual", requireAuth, (req, res) => {
  const { period, metric, value, note } = req.body || {};
  if (!period || !metric || typeof value !== "number") {
    return res.status(400).json({ error: "period, metric and numeric value are required" });
  }
  saveManualMetric(String(period), String(metric), value, note);
  res.json({ ok: true });
});

app.delete("/api/metrics/manual", requireAuth, (req, res) => {
  const { period, metric } = req.body || {};
  if (!period || !metric) return res.status(400).json({ error: "period and metric are required" });
  deleteManualMetric(String(period), String(metric));
  res.json({ ok: true });
});

/* ------------------------------------------------------ search and patterns */

app.get("/api/search", requireAuth, noStore, (req, res) => {
  const q = String(req.query.q || "");
  const started = Date.now();
  try {
    const results = search(q);
    res.json({ query: q, results, tookMs: Date.now() - started });
  } catch (err: any) {
    // A malformed FTS expression is a user typo, not a server fault.
    res.status(400).json({ error: "Could not parse that search", detail: err.message });
  }
});

app.get("/api/patterns", requireAuth, noStore, (_req, res) => {
  res.json(patterns());
});

/* ---------------------------------------------------------------- settings */

app.get("/api/settings", requireAuth, noStore, (_req, res) => {
  const state = getSyncState();
  res.json({
    settings: allSettings(),
    defaults: SETTING_DEFAULTS,
    sync: {
      lastSuccess: state.last_success,
      lastAttempt: state.last_attempt,
      lastError: state.last_error,
      errorCount: state.error_count,
      apiCalls: state.api_calls,
      running: !!state.running,
      lastDurationMs: state.last_duration_ms,
      watermark: state.watermark,
    },
    cache: cacheCounts(),
    salesforce: {
      instanceHost: safeHost(config.salesforce.instanceUrl),
      apiVersion: config.salesforce.apiVersion,
      ownerName: config.salesforce.ownerName,
      emailsUnavailable: isEmailAccessDenied(),
    },
  });
});

app.patch("/api/settings", requireAuth, (req, res) => {
  const patch = req.body || {};
  const applied: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in SETTING_DEFAULTS)) continue; // ignore unknown keys rather than storing junk
    setSetting(key, String(value));
    applied.push(key);
  }
  res.json({ ok: true, applied, settings: allSettings() });
});

app.post("/api/settings/rebuild-cache", requireAuth, async (_req, res) => {
  rebuildCache();
  const result = await syncOnce(true);
  res.json({ ok: result.ok, result });
});

/* -------------------------------------------------------------- coverage */

app.get("/api/coverage/channels", requireAuth, noStore, (_req, res) => {
  res.json({ channels: listChannels(), activeChannelId: getSetting("coverageActiveChannelId") || null });
});

app.post("/api/coverage/channels", requireAuth, (req, res) => {
  try {
    const channel = addChannel(String(req.body?.label || ""), String(req.body?.webhookUrl || ""));
    res.json({ ok: true, channel });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/coverage/channels/:id", requireAuth, (req, res) => {
  deleteChannel(req.params.id);
  res.json({ ok: true });
});

app.post("/api/coverage/channels/:id/activate", requireAuth, (req, res) => {
  try {
    setActiveChannel(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** Proves a channel works without waiting for a real coverage trigger — same idea as the general webhook test, aimed at one coverage channel. */
app.post("/api/coverage/channels/:id/test", requireAuth, async (req, res) => {
  const result = await sendTestMessage(req.params.id);
  res.status(result.ok ? 200 : 502).json(result);
});

app.get("/api/coverage/posts", requireAuth, noStore, (_req, res) => {
  res.json({ posts: listRecentPosts() });
});

/**
 * Phase 8's approval queue: the only path a coverage post has to actually
 * reaching Slack. Nothing here runs automatically from a sync or a sweep —
 * a human calls this, optionally editing the text first, for every single
 * post. Consistent with this project's founding no-autonomous-sending rule.
 */
app.post("/api/coverage/posts/:id/send", requireAuth, async (req, res) => {
  const body = typeof req.body?.body === "string" ? req.body.body : undefined;
  const result = await approvePost(req.params.id, body);
  res.status(result.ok ? 200 : 502).json(result);
});

app.post("/api/coverage/posts/:id/discard", requireAuth, (req, res) => {
  discardPost(req.params.id);
  res.json({ ok: true });
});

/**
 * Reads real Status history rather than simulating from current state (see
 * PLAN_V3.md's phase 7 section) — this can take a few seconds, it is a live
 * Salesforce query, not a cached read.
 */
app.get("/api/coverage/backtest", requireAuth, async (_req, res) => {
  try {
    const result = await backtest30Days();
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * The browser polls this to decide what deserves a notification. It reads the
 * same rows the webhook sends, so the two cannot disagree about what happened.
 * The since parameter is a millisecond timestamp; without it the caller gets
 * the recent backlog, which is what a freshly opened tab uses to seed its
 * seen-set rather than replaying a week of history as new.
 */
app.get("/api/events", requireAuth, noStore, (req, res) => {
  const since = Number(req.query.since);
  const events = listEvents(Number.isFinite(since) && since > 0 ? since : null);
  res.json({ events, now: Date.now() });
});

/**
 * Proving a webhook URL works should not mean waiting for a real event to fire
 * at it. The body is a fixed string with no case data in it, so a mistyped URL
 * leaks nothing. This is the only outbound call in the app and it happens only
 * on an explicit button press.
 */
app.post("/api/settings/test-webhook", requireAuth, async (req, res) => {
  const url = String((req.body && req.body.url) || getSetting("webhookUrl") || "");
  const result = await sendWebhookTest(url);
  res.status(result.ok ? 200 : 502).json(result);
});

/* -------------------------------------------------------------------- sync */

app.post("/api/sync", requireAuth, async (req, res) => {
  const full = req.query.full === "1";
  const result = await syncOnce(full);
  res.status(result.ok ? 200 : 502).json(result);
});

app.get("/api/sync/status", requireAuth, noStore, (_req, res) => {
  const state = getSyncState();
  res.json({
    lastSuccess: state.last_success,
    lastAttempt: state.last_attempt,
    lastError: state.last_error,
    errorCount: state.error_count,
    apiCalls: state.api_calls,
    running: !!state.running,
    lastDurationMs: state.last_duration_ms,
    intervalMinutes: getSettingNumber("syncIntervalMinutes"),
    activeWindowStart: getSettingNumber("activeWindowStart"),
    activeWindowEnd: getSettingNumber("activeWindowEnd"),
    activeWindowWeekdaysOnly: getSetting("activeWindowWeekdaysOnly") === "true",
    cache: cacheCounts(),
    emailsUnavailable: isEmailAccessDenied(),
  });
});

/* --------------------------------------------------------------- AI draft */

/** getArtifacts() already groups by label -- flatten to plain lines a prompt can read. */
function artifactLines(caseNumber: string): string[] {
  return getArtifacts(caseNumber).flatMap((g: { label: string; values: string[] }) =>
    g.values.map((v) => `${g.label}: ${v}`),
  );
}

const VALID_KEYWORDS: Keyword[] = ["INTRO", "UPDATE", "FOLLOWUP", "CLOSURE"];

app.post("/api/intelligence/suggest-reply", requireAuth, async (req, res) => {
  const caseNumber = String(req.body?.case_number || "").trim();
  const keywordOverride = VALID_KEYWORDS.includes(req.body?.keyword_override)
    ? (req.body.keyword_override as Keyword)
    : undefined;
  // An explicit override means the cache from a different keyword is stale
  // for the caller's purposes even if nothing else asked to regenerate.
  const regenerate = !!req.body?.regenerate || !!keywordOverride;
  if (!caseNumber) return res.status(400).json({ error: "case_number is required" });

  try {
    if (!regenerate) {
      const cached = getLatestSuggestedReply(caseNumber);
      if (cached) {
        return res.json({
          draft: cached.draft,
          keyword: cached.keyword,
          internalNote: cached.internal_note,
          selfCheck: cached.self_check,
          cached: true,
          created_at: cached.created_at,
        });
      }
    }

    const c = await getCaseByNumber(caseNumber);
    if (!c) return res.status(404).json({ error: "Case not found" });

    const result = await draftSuggestedReply(c, { keywordOverride, knownArtifacts: artifactLines(caseNumber) });
    const saved = saveSuggestedReply(
      caseNumber,
      result.customerText,
      result.keyword,
      result.internalNote,
      result.selfCheck,
    );

    res.json({
      draft: result.customerText,
      keyword: result.keyword,
      internalNote: result.internalNote,
      selfCheck: result.selfCheck,
      cached: false,
      created_at: saved?.created_at,
    });
  } catch (err: any) {
    log.error("api.suggest_reply_failed", { caseNumber, error: errText(err) });
    res.status(502).json({ error: err.message });
  }
});

/**
 * Phase 5's "predicted score before copy" gate. Scores whatever text is
 * currently staged -- AI-drafted, skeleton-inserted, or hand-typed, this
 * route does not care which -- as if it were the case's newest comment.
 * Read-only: nothing is written, so this is safe to call on every keystroke
 * (the client debounces).
 */
app.post("/api/cases/:caseNumber/draft-score", requireAuth, noStore, (req, res) => {
  const c = getCaseRow(req.params.caseNumber);
  if (!c) return res.status(404).json({ error: "Case not in cache" });

  const text = String(req.body?.text || "");
  const keywordOverride = VALID_KEYWORDS.includes(req.body?.keyword_override)
    ? (req.body.keyword_override as Keyword)
    : undefined;

  const score = previewDraftScore(c.id, text, keywordOverride);
  if (!score) return res.status(404).json({ error: "Case not in cache" });
  res.json({ score });
});

/**
 * Auto-repair: tier 1 (mechanical, free) always runs; tier 2 (one model
 * call) only runs if a structural gap remains afterward, so the common case
 * -- a stray banned phrase, nothing else wrong -- never spends a token.
 */
app.post("/api/intelligence/repair-reply", requireAuth, async (req, res) => {
  const caseNumber = String(req.body?.case_number || "").trim();
  const draftText = String(req.body?.draft_text || "");
  const keyword = VALID_KEYWORDS.includes(req.body?.keyword) ? (req.body.keyword as Keyword) : "UPDATE";
  if (!caseNumber) return res.status(400).json({ error: "case_number is required" });
  if (!draftText.trim()) return res.status(400).json({ error: "draft_text is required" });

  try {
    const c = getCaseRow(caseNumber);
    if (!c) return res.status(404).json({ error: "Case not in cache" });

    const mechanical = mechanicalRepair(draftText);
    let score = previewDraftScore(c.id, mechanical.text, keyword);
    let text = mechanical.text;
    let modelCalled = false;

    const notes = score ? repairNotesFor(score) : [];
    if (notes.length > 0) {
      modelCalled = true;
      const repaired = await repairDraft(text, keyword, notes, { knownArtifacts: artifactLines(caseNumber) });
      text = repaired.customerText;
      score = previewDraftScore(c.id, text, keyword);
    }

    res.json({
      text,
      score,
      mechanicalFixes: mechanical.fixedCount,
      modelCalled,
    });
  } catch (err: any) {
    log.error("api.repair_reply_failed", { caseNumber, error: errText(err) });
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ health */

/**
 * Unauthenticated on purpose: this is what the container probe and Prometheus
 * hit. It exposes counts and sync health, never case content.
 */
app.get("/healthz", noStore, (_req, res) => {
  const state = getSyncState();
  const stale =
    !state.last_success ||
    Date.now() - state.last_success > (getSettingNumber("syncIntervalMinutes") + 15) * 60_000;

  res.status(stale && state.error_count > 3 ? 503 : 200).json({
    status: stale ? (state.error_count > 3 ? "degraded" : "stale") : "ok",
    uptimeSeconds: Math.round(process.uptime()),
    sync: {
      running: !!state.running,
      lastSuccess: state.last_success,
      lastAttempt: state.last_attempt,
      lastDurationMs: state.last_duration_ms,
      errorCount: state.error_count,
      lastError: state.last_error,
      apiCalls: state.api_calls,
    },
    cache: cacheCounts(),
  });
});

app.get("/api/app-versions", (_req, res) => {
  res.json({ app: "qview", version: "2.0.0" });
});

/* --------------------------------------------------------------- static/SPA */

const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR, { index: false }));

const SPA_ROUTES = [
  "/",
  "/case/:caseNumber",
  "/commitments",
  "/timeoff",
  "/metrics",
  "/iqs",
  "/triage",
  "/escalations",
  "/search",
  "/patterns",
  "/settings",
];

// Real URLs must survive a hard refresh, so every client route serves the shell.
for (const route of SPA_ROUTES) {
  app.get(route, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
}

app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.status(404).sendFile(path.join(PUBLIC_DIR, "index.html"));
});

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

app.listen(config.port, () => {
  log.info("server.listening", { port: config.port });
  // Cases cached before quality scoring existed, and every case if the rubric
  // version moved, are graded here. Local regex over the cache: no Salesforce
  // call, no API key, so it is safe to do before the first sync lands.
  rescoreStale();
  // Layer 2 is the only thing here that can spend money, so it starts last
  // and starts itself only if a token exists.
  startLayer2Sweep();
  startSync();
});
