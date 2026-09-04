/**
 * Backend client.
 *
 * Every Salesforce call happens server-side; this file only ever talks to our
 * own origin, and no credential or instance URL is ever present in the bundle.
 */

const listeners = new Set();

/** Fired on 401 so the shell can drop back to the login screen. */
export function onUnauthorized(fn) { listeners.add(fn); }

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request(method, path, body) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    throw new ApiError("Cannot reach the QView server", 0, err.message);
  }

  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    for (const fn of listeners) fn();
    throw new ApiError("Session expired", 401);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }

  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.detail);
  return data;
}

const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    sp.set(k, v === true ? "1" : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
};

export const api = {
  /* auth */
  me:      ()      => request("GET",  "/api/auth/me"),
  login:   (email) => request("POST", "/api/auth/login", { email }),
  logout:  ()      => request("POST", "/api/auth/logout"),

  /* cases */
  cases:      (filters) => request("GET", "/api/cases" + qs(filters)),
  quickFind:  (q)       => request("GET", "/api/cases/search" + qs({ q })),
  facets:     (scope)   => request("GET", "/api/facets" + qs({ scope })),
  counts:     ()        => request("GET", "/api/counts"),
  caseDetail: (n)       => request("GET", `/api/cases/${encodeURIComponent(n)}`),
  timeline:   (n)       => request("GET", `/api/cases/${encodeURIComponent(n)}/timeline`),
  artifacts:  (n)       => request("GET", `/api/cases/${encodeURIComponent(n)}/artifacts`),
  related:    (n)       => request("GET", `/api/cases/${encodeURIComponent(n)}/related`),

  /* quality — the local IQS score. `iqs` is its own call rather than part of
     caseDetail because the breakdown is a dimension tree and the queue only
     ever wants the three summary fields it already gets on each row. */
  iqs:      (n)    => request("GET", `/api/cases/${encodeURIComponent(n)}/iqs`),
  iqsStats: (open) => request("GET", "/api/iqs/stats" + qs({ open })),

  /* commitments */
  commitments:   (state)      => request("GET",   "/api/commitments" + qs({ state })),
  addCommitment: (payload)    => request("POST",  "/api/commitments", payload),
  patchCommitment: (id, p)    => request("PATCH", `/api/commitments/${encodeURIComponent(id)}`, p),

  /* metrics */
  metrics:          (p)       => request("GET",    "/api/metrics" + qs(p)),
  saveManualMetric: (payload) => request("POST",   "/api/metrics/manual", payload),
  deleteManualMetric: (p)     => request("DELETE", "/api/metrics/manual", p),

  /* search + patterns */
  search:   (q) => request("GET", "/api/search" + qs({ q })),
  patterns: ()  => request("GET", "/api/patterns"),

  /* settings + sync */
  settings:     ()      => request("GET",   "/api/settings"),
  saveSettings: (patch) => request("PATCH", "/api/settings", patch),
  rebuildCache: ()      => request("POST",  "/api/settings/rebuild-cache"),
  sync:         (full)  => request("POST",  "/api/sync" + (full ? "?full=1" : "")),
  syncStatus:   ()      => request("GET",   "/api/sync/status"),
  testWebhook:  (url)   => request("POST",  "/api/settings/test-webhook", { url }),

  /* events — the notification feed. sinceMs is a millisecond timestamp; omit it
     to fetch the recent backlog, which a fresh tab uses to seed its seen-set. */
  events: (sinceMs) => request("GET", "/api/events" + qs({ since: sinceMs || undefined })),

  /* AI draft (staging only — the assistant that writes replies lives elsewhere) */
  suggestReply: (caseNumber, regenerate) =>
    request("POST", "/api/intelligence/suggest-reply", { case_number: caseNumber, regenerate: !!regenerate }),
};
