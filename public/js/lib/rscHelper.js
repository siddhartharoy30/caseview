/**
 * Client for the RSC support-access helper -- a separate local process that
 * runs only on the user's Mac (docs/RSC_HELPER.md), reached cross-origin from
 * wherever QView itself is served (the VM, in production). Deliberately not
 * routed through api.js: there is no session cookie here, and "the helper
 * isn't running" is a normal, expected state the case-detail button surfaces
 * on its own -- not a connection failure to report the way ApiError does for
 * the main app.
 */

const HELPER_ORIGIN = "http://localhost:8756";
const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_CACHE_MS = 30000;

let healthCache = null; // { ok, checkedAt }

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

export class RscHelperError extends Error {
  constructor(message, code, remainingSeconds) {
    super(message);
    this.code = code;
    this.remainingSeconds = remainingSeconds;
  }
}

/** Returns the `grants` array on success; throws RscHelperError otherwise. */
export async function generate(caseNumber, account) {
  let res;
  try {
    res = await fetch(`${HELPER_ORIGIN}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseNumber, account }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new RscHelperError("RSC helper is not running on your Mac. See docs/RSC_HELPER.md.", "helper_unreachable");
  }
  const responseBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RscHelperError(
      responseBody.message || "The RSC helper returned an error.",
      responseBody.error || "unknown",
      responseBody.remainingSeconds,
    );
  }
  return responseBody.grants;
}

/** Tier 2 of the clipboard fallback -- shells `pbcopy` on the Mac. */
export async function pbcopy(text) {
  try {
    const res = await fetch(`${HELPER_ORIGIN}/pbcopy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => ({}));
    return !!body.ok;
  } catch {
    return false;
  }
}
