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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const email = verifySessionToken(req.cookies?.[COOKIE_NAME]);
  if (!email) {
    return res.status(401).json({ error: "not authenticated" });
  }
  (req as any).email = email;
  next();
}
