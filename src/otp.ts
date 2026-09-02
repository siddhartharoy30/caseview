import crypto from "crypto";
import { config } from "./config";
import { lookupUserIdByEmail, sendDirectMessage } from "./slack";

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_ATTEMPTS = 5;

interface OtpEntry {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

const otps = new Map<string, OtpEntry>();

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isAllowedEmail(email: string): boolean {
  return normalizeEmail(email) === normalizeEmail(config.auth.allowedEmail);
}

function generateCode(): string {
  return String(crypto.randomInt(1_000_000)).padStart(6, "0");
}

export async function requestOtp(email: string): Promise<void> {
  const key = normalizeEmail(email);
  if (!isAllowedEmail(key)) {
    return;
  }

  const existing = otps.get(key);
  const now = Date.now();
  if (existing && now - existing.lastSentAt < RESEND_COOLDOWN_MS) {
    throw new Error("Please wait before requesting another code");
  }

  const code = generateCode();
  otps.set(key, { code, expiresAt: now + CODE_TTL_MS, attempts: 0, lastSentAt: now });

  const userId = await lookupUserIdByEmail(key);
  await sendDirectMessage(userId, "Your QView login code is " + code + " (expires in 5 minutes).");
}

export function verifyOtp(email: string, code: string): boolean {
  const key = normalizeEmail(email);
  const entry = otps.get(key);
  if (!entry) return false;

  if (Date.now() > entry.expiresAt) {
    otps.delete(key);
    return false;
  }

  entry.attempts += 1;
  if (entry.attempts > MAX_ATTEMPTS) {
    otps.delete(key);
    return false;
  }

  const ok =
    entry.code.length === code.length &&
    crypto.timingSafeEqual(Buffer.from(entry.code), Buffer.from(code));

  if (ok) {
    otps.delete(key);
  }
  return ok;
}
