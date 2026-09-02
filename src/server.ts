import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { config } from "./config";
import { COOKIE_NAME, makeSessionToken, requireAuth, verifySessionToken } from "./auth";
import { getCaseByNumber, isEmailAccessDenied } from "./salesforce";
import { computeSla, deriveQueue, deriveNextAction } from "./sla";
import {
  getLatestSuggestedReply,
  saveSuggestedReply,
  allSettings,
  setSetting,
  SETTING_DEFAULTS,
  getSettingNumber,
  getSyncState,
  cacheCounts,
  rebuildCache,
} from "./db";
import { draftSuggestedReply } from "./claude";
import {
  listCases,
  getCase,
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
  search,
  patterns,
  badgeCounts,
  facets,
} from "./queries";
import { resolveRange, scorecard, saveManualMetric, deleteManualMetric } from "./metrics";
import { syncOnce, startSync, reconcileCommitments } from "./sync";
import { log, errText } from "./log";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

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

app.post("/api/auth/login", (req, res) => {
  const email = String(req.body?.email || "").trim();
  if (!email || email.toLowerCase() !== config.auth.allowedEmail.toLowerCase()) {
    return res.status(401).json({ error: "Not an authorised email address" });
  }
  res.cookie(COOKIE_NAME, makeSessionToken(email), SESSION_COOKIE_OPTS);
  res.json({ ok: true, email });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const email = verifySessionToken(req.cookies?.[COOKIE_NAME]);
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
        Origin: c.origin,
        Type: c.type,
        Last_Customer_Update__c: c.lastCustomerUpdate,
        NCC_date__c: c.ncc,
      } as any;
      return {
        ...c,
        queue: deriveQueue(legacy),
        sla: computeSla(legacy),
        nextAction: deriveNextAction(legacy),
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
    cache: cacheCounts(),
    emailsUnavailable: isEmailAccessDenied(),
  });
});

/* --------------------------------------------------------- AI draft (kept) */

app.post("/api/intelligence/suggest-reply", requireAuth, async (req, res) => {
  const caseNumber = String(req.body?.case_number || "").trim();
  const regenerate = !!req.body?.regenerate;
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

    const result = await draftSuggestedReply(c);
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
  "/metrics",
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
  startSync();
});
