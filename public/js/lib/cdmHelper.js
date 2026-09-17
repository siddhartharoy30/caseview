/**
 * Client for the CDM tunnel helper -- a separate local process from the RSC
 * helper (docs/PLAN_V8_CDM.md), reached cross-origin from wherever QView
 * itself is served (the VM, in production). Deliberately not routed through
 * api.js: there is no session cookie here, and "the helper isn't running" is
 * a normal, expected state the case-detail button surfaces on its own.
 */

const HELPER_ORIGIN = "http://localhost:8757";
const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_CACHE_MS = 30000;

let healthCache = null; // { ok, checkedAt }

/** Optimistic default when never checked yet -- see rscHelper.js's identical
 * function for the full rationale. */
export function lastKnownHealthy() {
  return healthCache ? healthCache.ok : true;
}

export async function checkHealth(force = false) {
  if (!force && healthCache && Date.now() - healthCache.checkedAt < HEALTH_CACHE_MS) {
    return healthCache.ok;
  }
  let ok = false;
  try {
    const res = await fetch(`${HELPER_ORIGIN}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  healthCache = { ok, checkedAt: Date.now() };
  return ok;
}

export class CdmHelperError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function call(path, opts = {}) {
  let res;
  try {
    res = await fetch(`${HELPER_ORIGIN}${path}`, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs || 8000),
    });
  } catch {
    throw new CdmHelperError("CDM helper is not running on your Mac. See docs/CDM_HELPER.md.", "helper_unreachable");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new CdmHelperError(body.message || "The CDM helper returned an error.", body.error || "unknown");
  }
  return body;
}

export async function listSessions() {
  const body = await call("/sessions");
  return body.sessions;
}

export async function getSession(id) {
  const body = await call(`/sessions/${encodeURIComponent(id)}`);
  return body.session;
}

/** Kicks off the whole readiness-check → claim → forward sequence. Returns
 * immediately with the session in `starting` state -- the caller polls
 * getSession() for progress, since the full sequence can take 30-70s. */
export async function startSession(caseNumber, clusterUuid, clusterTag, clusterVersion, caseVersionRaw) {
  const body = await call("/sessions", {
    method: "POST",
    body: { caseNumber, clusterUuid, clusterTag, clusterVersion, caseVersionRaw },
    timeoutMs: 10000,
  });
  return body.session;
}

export async function stopSession(id, closeChrome = true) {
  const body = await call(`/sessions/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    body: { closeChrome },
    timeoutMs: 10000,
  });
  return body.session;
}

export async function openUi(id, flavor) {
  const body = await call(`/sessions/${encodeURIComponent(id)}/open-ui`, {
    method: "POST",
    body: flavor ? { flavor } : {},
    timeoutMs: 10000,
  });
  return body.session;
}

/** Tier 3: paste a manually-generated token; the helper pbcopy's it. */
export async function manualToken(id, token) {
  const body = await call(`/sessions/${encodeURIComponent(id)}/manual-token`, {
    method: "POST",
    body: { token },
    timeoutMs: 5000,
  });
  return body.ok;
}

/** Tier 2 of the clipboard fallback -- shells `pbcopy` on the Mac, for
 * anything other than the token itself (e.g. the manual command line). */
export async function pbcopy(text) {
  try {
    const body = await call("/pbcopy", { method: "POST", body: { text }, timeoutMs: 4000 });
    return !!body.ok;
  } catch {
    return false;
  }
}
