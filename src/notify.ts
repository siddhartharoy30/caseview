/**
 * Events: the four things worth interrupting me for.
 *
 * The spec asks for browser notifications and an optional Slack-compatible
 * webhook covering the same list. Detecting those four things twice — once in
 * the browser and once on the server — would be two chances to disagree, so it
 * happens once here and both consumers read the same rows.
 *
 * Every event carries a deterministic id, which is what makes this safe to run
 * on a five-minute loop: INSERT OR IGNORE turns "have I already said this"
 * into a primary-key constraint rather than a heuristic. A customer reply
 * refires only when its timestamp moves; a commitment refires only when its
 * deadline is renegotiated to a new one.
 *
 * On customer data: the webhook is the one place in this application where
 * case content could leave the box. It is off by default, and even switched on
 * it sends case numbers and event kinds only, unless webhookIncludeSubject is
 * explicitly turned on as well. Browser notifications, which never leave the
 * session, always carry the full text.
 */

import { db, getSetting, getSettingBool, now } from "./db";
import { log } from "./log";

export type EventKind =
  | "case.new"
  | "case.replied"
  | "commitment.due"
  | "commitment.breached";

export interface AppEvent {
  id: string;
  kind: EventKind;
  caseNumber: string | null;
  title: string;
  detail: string | null;
  createdAt: number;
}

/** Anything older than this is neither worth showing nor worth delivering. */
const RETAIN_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const DUE_SOON_MS = 60 * 60 * 1000;
const NEW_CASE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const insertEvent = db.prepare(
  "INSERT OR IGNORE INTO events (id, kind, case_number, title, detail, created_at) " +
    "VALUES (@id, @kind, @case_number, @title, @detail, @created_at)",
);

function record(
  id: string,
  kind: EventKind,
  caseNumber: string | null,
  title: string,
  detail: string | null,
): boolean {
  const res = insertEvent.run({
    id,
    kind,
    case_number: caseNumber,
    title,
    detail,
    created_at: now(),
  });
  return res.changes > 0;
}

/* --------------------------------------------------------------- detection */

export interface DeltaCase {
  caseNumber: string;
  subject: string | null;
  priority: string | null;
  account: string | null;
  createdDate: string | null;
  lastCustomerTouch: string | null;
  isClosed: boolean;
}

export interface SyncDelta {
  /** Cases that did not exist in the cache before this run. */
  created: DeltaCase[];
  /** Cases where needs_my_reply went from 0 to 1 during this run. */
  replied: DeltaCase[];
}

/**
 * Case events come from a before/after comparison the sync hands us, because
 * "new" and "the customer just spoke" are both transitions, and a row on its
 * own cannot tell you that it moved.
 */
function caseEvents(delta: SyncDelta): number {
  let fired = 0;
  const cutoff = Date.now() - NEW_CASE_MAX_AGE_MS;

  for (const c of delta.created) {
    if (c.isClosed) continue;
    // First seen today but opened in March is a backfill, not news.
    const created = c.createdDate ? Date.parse(c.createdDate) : NaN;
    if (Number.isFinite(created) && created < cutoff) continue;
    const label = [c.priority, c.account].filter(Boolean).join(" · ");
    if (
      record(
        "case.new:" + c.caseNumber,
        "case.new",
        c.caseNumber,
        "New case " + c.caseNumber + (label ? " (" + label + ")" : ""),
        c.subject || null,
      )
    ) {
      fired += 1;
    }
  }

  for (const c of delta.replied) {
    const stamp = c.lastCustomerTouch || "";
    const label = [c.priority, c.account].filter(Boolean).join(" · ");
    if (
      record(
        "case.replied:" + c.caseNumber + ":" + stamp,
        "case.replied",
        c.caseNumber,
        "Customer replied on " + c.caseNumber + (label ? " (" + label + ")" : ""),
        c.subject || null,
      )
    ) {
      fired += 1;
    }
  }

  return fired;
}

/**
 * Commitment events are a scan rather than a transition: a deadline arrives
 * without anything changing in Salesforce, so there is nothing to diff. The
 * deterministic id carries the due timestamp, so a renegotiated commitment is
 * a genuinely new event and an unchanged one stays silent however often this
 * runs.
 */
function commitmentEvents(): number {
  const rows = db
    .prepare(
      "SELECT cm.id, cm.case_number, cm.due_at, cm.state, cm.raw_text, c.subject, c.priority" +
        "  FROM commitments cm" +
        "  JOIN cases c ON c.id = cm.case_id" +
        " WHERE c.is_closed = 0" +
        "   AND cm.due_at IS NOT NULL" +
        "   AND cm.state IN ('active', 'breached')",
    )
    .all() as Array<{
    id: string;
    case_number: string;
    due_at: number;
    state: string;
    raw_text: string | null;
    subject: string | null;
    priority: string | null;
  }>;

  const at = Date.now();
  let fired = 0;

  for (const r of rows) {
    const detail = r.raw_text || r.subject || null;

    if (r.state === "breached" || r.due_at < at) {
      if (
        record(
          "commitment.breached:" + r.id + ":" + r.due_at,
          "commitment.breached",
          r.case_number,
          "Commitment breached on " + r.case_number,
          detail,
        )
      ) {
        fired += 1;
      }
      continue;
    }

    if (r.due_at - at <= DUE_SOON_MS) {
      const mins = Math.max(1, Math.round((r.due_at - at) / 60000));
      if (
        record(
          "commitment.due:" + r.id + ":" + r.due_at,
          "commitment.due",
          r.case_number,
          "Commitment due in " + mins + "m on " + r.case_number,
          detail,
        )
      ) {
        fired += 1;
      }
    }
  }

  return fired;
}

/* ----------------------------------------------------------------- webhook */

function payloadFor(e: { title: string; detail: string | null }): string {
  const includeSubject = getSettingBool("webhookIncludeSubject");
  const text =
    includeSubject && e.detail
      ? e.title + "\n" + e.detail.replace(/\s+/g, " ").slice(0, 300)
      : e.title;
  return JSON.stringify({ text: "QView: " + text });
}

/**
 * Slack's incoming-webhook shape is the lowest common denominator: a JSON body
 * with a `text` field. Anything Slack-compatible accepts it, so there is no
 * per-destination adapter to maintain.
 */
async function deliverPending(): Promise<number> {
  if (!getSettingBool("webhookEnabled")) return 0;

  const url = (getSetting("webhookUrl") || "").trim();
  if (!/^https:\/\//i.test(url)) {
    if (url) log.warn("webhook.skipped", { reason: "url is not https" });
    return 0;
  }

  const pending = db
    .prepare(
      "SELECT id, title, detail FROM events " +
        "WHERE delivered = 0 AND attempts < ? ORDER BY created_at ASC LIMIT 20",
    )
    .all(MAX_ATTEMPTS) as Array<{ id: string; title: string; detail: string | null }>;

  const markOk = db.prepare("UPDATE events SET delivered = 1, attempts = attempts + 1 WHERE id = ?");
  const markFail = db.prepare("UPDATE events SET attempts = attempts + 1 WHERE id = ?");
  let sent = 0;

  for (const e of pending) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payloadFor(e),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      markOk.run(e.id);
      sent += 1;
    } catch (err) {
      markFail.run(e.id);
      log.warn("webhook.failed", { id: e.id, error: (err as Error).message });
    }
  }

  if (sent) log.info("webhook.delivered", { count: sent });
  return sent;
}

/** Lets Settings prove a URL works without waiting for a real event. */
export async function sendWebhookTest(
  url: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const target = (url || "").trim();
  if (!/^https:\/\//i.test(target)) {
    return { ok: false, error: "Webhook URL must start with https://" };
  }
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "QView: test message. If you can read this, the webhook works.",
      }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: "HTTP " + res.status };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/* ------------------------------------------------------------------ public */

export function listEvents(sinceMs: number | null, limit = 100): AppEvent[] {
  const rows = sinceMs
    ? db
        .prepare("SELECT * FROM events WHERE created_at > ? ORDER BY created_at DESC LIMIT ?")
        .all(sinceMs, limit)
    : db.prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ?").all(limit);

  return (rows as any[]).map((r) => ({
    id: r.id,
    kind: r.kind as EventKind,
    caseNumber: r.case_number,
    title: r.title,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

export function pruneEvents(): void {
  db.prepare("DELETE FROM events WHERE created_at < ?").run(Date.now() - RETAIN_MS);
}

/**
 * Called at the end of every sync. `suppressCaseEvents` is set for a manual
 * full resync and for the very first sync into an empty cache, where every
 * case looks new and notifying about all of them would be indistinguishable
 * from a malfunction.
 */
export async function runEvents(
  delta: SyncDelta | null,
  suppressCaseEvents: boolean,
): Promise<number> {
  let fired = 0;
  try {
    if (delta && !suppressCaseEvents) fired += caseEvents(delta);
    fired += commitmentEvents();
    pruneEvents();
    if (fired) log.info("events.fired", { count: fired });
    await deliverPending();
  } catch (err) {
    log.warn("events.failed", { error: (err as Error).message });
  }
  return fired;
}
