import { timingSafeEqual, createHmac } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config";

export const COOKIE_NAME = "qview_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours, matches Case Assist

function sign(payload: string): string {
  return createHmac("sha256", config.session.secret).update(payload).digest("hex");
}

// The subject is an email, which contains dots, so it is base64url-encoded to
// keep "." usable as the token delimiter.
export function makeSessionToken(email: string): string {
  const expiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = Buffer.from(email, "utf8").toString("base64url") + "." + expiry;
  return payload + "." + sign(payload);
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedEmail, expiryStr, sig] = parts;
  const payload = encodedEmail + "." + expiryStr;
  const expected = sign(payload);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Math.floor(Date.now() / 1000)) return null;
  const email = Buffer.from(encodedEmail, "base64url").toString("utf8");
  return email || null;
}

/**
 * Every value the browser sent under the session cookie name.
 *
 * cookie-parser collapses duplicates and keeps whichever came first, which is
 * the wrong one when a stale cookie shadows a fresh one. Browsers send
 * same-name cookies most-specific-path first, so a leftover cookie from an
 * earlier build — or one minted before the token format changed — is offered
 * ahead of the good one and silently wins. The failure that produces is
 * peculiarly hard to read from the outside: signing in returns 200 and sets a
 * valid cookie, then the very next request 401s, so the shell drops back to
 * the sign-in form and the user sees an endless loop. curl never reproduces it
 * because a fresh cookie jar has nothing stale in it.
 *
 * Reading the raw header instead lets any one valid cookie authenticate the
 * request, which makes that state self-healing rather than permanent.
 */
function sessionTokens(req: Request): string[] {
  const out: string[] = [];
  const header = req.headers?.cookie;

  if (typeof header === "string") {
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
      const raw = part.slice(eq + 1).trim();
      if (!raw) continue;
      // A malformed percent-escape must not take the request down.
      let value = raw;
      try { value = decodeURIComponent(raw); } catch { /* use it verbatim */ }
      if (!out.includes(value)) out.push(value);
    }
  }

  const parsed = (req as any).cookies?.[COOKIE_NAME];
  if (typeof parsed === "string" && parsed && !out.includes(parsed)) out.push(parsed);

  return out;
}

/** The signed-in address, or null. Accepts any valid cookie the browser sent. */
export function sessionEmail(req: Request): string | null {
  for (const token of sessionTokens(req)) {
    const email = verifySessionToken(token);
    if (email) return email;
  }
  return null;
}

/**
 * A short description of the request's cookie state, for the access log.
 *
 * Deliberately says nothing about who the user is — only how many session
 * cookies arrived and whether any verified. That is the one fact needed to
 * tell "the browser never stored a cookie" apart from "the browser sent a
 * cookie we reject", which are the same 401 to the client and completely
 * different bugs.
 */
export function sessionDiagnostic(req: Request): string {
  const tokens = sessionTokens(req);
  if (tokens.length === 0) return "none";
  const valid = tokens.some((t) => verifySessionToken(t) !== null);
  if (valid) return tokens.length > 1 ? `valid (+${tokens.length - 1} stale)` : "valid";
  return tokens.length > 1 ? `invalid (${tokens.length} sent)` : "invalid";
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const email = sessionEmail(req);
  if (!email) {
    return res.status(401).json({ error: "not authenticated" });
  }
  (req as any).email = email;
  next();
}
