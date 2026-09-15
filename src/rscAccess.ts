/**
 * Support-access ("RSC") token generation -- shells `gcloud`, calls pacman,
 * self-throttles per account. Lives in the RSC helper process only (see
 * src/rscHelperServer.ts, docs/PLAN_V8.md); the main QView app never imports
 * this module and never touches gcloud or pacman.
 *
 * The token, and the gcloud identity token, must never be logged. Every log
 * call in this file was written with that as the first constraint, not an
 * afterthought -- check any new one against it before adding it.
 */

import { execFile } from "child_process";
import { rscConfig } from "./rscHelperConfig";
import { log, errText } from "./log";

export type RscErrorCode =
  | "no_grant"
  | "vpn"
  | "cooldown"
  | "deployment_not_found"
  | "gcloud_missing"
  | "gcloud_unauth"
  | "permission"
  | "timeout"
  | "unknown";

export interface RscGrant {
  url: string;
  userEmail: string;
  domain: string;
  enableAt: string;
  expiredAt: string;
  token: string;
  /** Epoch ms, decoded from this grant's own JWT `exp` claim. */
  expiresAt: number;
}

export type RscResult =
  | { ok: true; grants: RscGrant[] }
  | { ok: false; code: RscErrorCode; message: string; remainingSeconds?: number };

type IdentityResult =
  | { ok: true; token: string }
  | { ok: false; code: "gcloud_missing" | "gcloud_unauth"; message: string };

let cachedIdentity: { value: string; fetchedAt: number } | null = null;

function getIdentityToken(): Promise<IdentityResult> {
  if (cachedIdentity && Date.now() - cachedIdentity.fetchedAt < rscConfig.identityTokenTtlMs) {
    return Promise.resolve({ ok: true, token: cachedIdentity.value });
  }
  return new Promise((resolve) => {
    execFile(rscConfig.gcloudPath, ["auth", "print-identity-token"], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          resolve({
            ok: false,
            code: "gcloud_missing",
            message: `gcloud SDK not found at "${rscConfig.gcloudPath}". Set GCLOUD_BIN_PATH in the RSC helper's environment.`,
          });
          return;
        }
        // The error message from a failed gcloud invocation is safe to log --
        // it's gcloud's own stderr summary (auth state), never the token.
        log.warn("rsc.gcloud_failed", { error: errText(err) });
        resolve({ ok: false, code: "gcloud_unauth", message: "Run `gcloud auth login`." });
        return;
      }
      const token = stdout.trim();
      if (!token) {
        resolve({ ok: false, code: "gcloud_unauth", message: "Run `gcloud auth login`." });
        return;
      }
      cachedIdentity = { value: token, fetchedAt: Date.now() };
      resolve({ ok: true, token });
    });
  });
}

/** `prosperitylife.my.rubrik.com` (or a bare URL of it) -> `prosperitylife`. */
function firstLabel(hostnameOrUrl: string): string {
  const host = hostnameOrUrl.replace(/^https?:\/\//, "").split("/")[0];
  return host.split(".")[0];
}

interface PacmanGrantRaw {
  url: string;
  user_email: string;
  domain: string;
  enable_at: string;
  expired_at: string;
  token: string;
}

type PacmanCallResult =
  | { ok: true; grants: PacmanGrantRaw[] }
  | { ok: false; code: RscErrorCode; message: string };

async function callPacman(account: string, identityToken: string): Promise<PacmanCallResult> {
  let res: Response;
  try {
    res = await fetch(`${rscConfig.pacmanBaseUrl}/query_open_support_access`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "Grpc-metadata-user": identityToken,
      },
      body: JSON.stringify({ account }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    log.warn("rsc.pacman_unreachable", { error: errText(err) });
    return { ok: false, code: "timeout", message: "Pacman did not respond. Check the VPN and try again." };
  }

  const text = await res.text();

  if (res.status === 403) {
    return { ok: false, code: "vpn", message: "Pacman is only reachable over vpn-colo-sso or vpn-bldc. Check your VPN." };
  }
  if (res.status === 401) {
    return {
      ok: false,
      code: "permission",
      message: "Your account may not be in the support-impersonation Okta group. Prod access goes through an ART request.",
    };
  }
  if (!res.ok) {
    if (/unable to find deployment/i.test(text)) {
      return { ok: false, code: "deployment_not_found", message: `Pacman could not resolve ${account}. Check the RSC Instance field on this case.` };
    }
    if (/already active/i.test(text)) {
      return { ok: false, code: "cooldown", message: "A token you generated is still live." };
    }
    // Deliberately not logging `text` (pacman's raw response body) or `account`
    // (a customer-identifying tenant name) -- the status code is enough to act on.
    log.warn("rsc.pacman_error_status", { status: res.status });
    return { ok: false, code: "unknown", message: `Pacman returned an unexpected error (HTTP ${res.status}).` };
  }

  let parsed: { support_access?: PacmanGrantRaw[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: "unknown", message: "Pacman returned a response QView could not parse." };
  }
  return { ok: true, grants: parsed.support_access || [] };
}

function decodeJwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** account -> epoch ms of the last successful generation. In-memory only, per spec -- not persisted. */
const lastGeneratedAt = new Map<string, number>();

export function cooldownRemainingSeconds(account: string): number {
  const last = lastGeneratedAt.get(account);
  if (!last) return 0;
  const remainingMs = rscConfig.cooldownMs - (Date.now() - last);
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

export async function generateSupportAccess(account: string): Promise<RscResult> {
  const remaining = cooldownRemainingSeconds(account);
  if (remaining > 0) {
    return {
      ok: false,
      code: "cooldown",
      message: `A token you generated is still live. ${remaining} seconds remaining.`,
      remainingSeconds: remaining,
    };
  }

  const identity = await getIdentityToken();
  if (!identity.ok) return identity;

  let result = await callPacman(account, identity.token);
  // Exactly one retry, on this one failure mode, per spec -- never a loop.
  if (!result.ok && result.code === "deployment_not_found") {
    const retryAccount = firstLabel(account);
    if (retryAccount && retryAccount !== account) {
      result = await callPacman(retryAccount, identity.token);
    }
  }
  if (!result.ok) return result;

  if (result.grants.length === 0) {
    return {
      ok: false,
      code: "no_grant",
      message:
        "The customer has not granted support access. Ask them to enable it: Settings → Customer Support → Support Access → Grant Support Access.",
    };
  }

  const grants: RscGrant[] = result.grants.map((g) => ({
    url: g.url,
    userEmail: g.user_email,
    domain: g.domain,
    enableAt: g.enable_at,
    expiredAt: g.expired_at,
    token: g.token,
    // Falls back to the documented 120s window only if a grant's JWT can't be
    // decoded -- the whole point of reading `exp` is to not hardcode this.
    expiresAt: decodeJwtExpiryMs(g.token) ?? Date.now() + 120_000,
  }));

  lastGeneratedAt.set(account, Date.now());
  log.info("rsc.generated", { grantCount: grants.length });
  return { ok: true, grants };
}

export function copyToMacClipboard(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = execFile("pbcopy", (err) => {
      if (err) {
        log.warn("rsc.pbcopy_failed", { error: errText(err) });
        resolve({ ok: false, error: errText(err) });
      } else {
        resolve({ ok: true });
      }
    });
    child.stdin?.write(text);
    child.stdin?.end();
  });
}
