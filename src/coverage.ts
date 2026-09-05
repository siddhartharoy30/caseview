/**
 * Coverage delivery (Phase 7): channels, compose, dry run, sweep, backtest.
 *
 * Delivery is a Slack Incoming Webhook, not a bot token -- see PLAN_V3.md's
 * phase 7 section for why (the owner declined to stand up a bot). That
 * means one channel per webhook URL, so `coverage_channels` is a short list
 * of named targets with one marked active, and a case's own
 * `Slack_channel__c` can no longer be preferred per post the way phase 0
 * originally planned -- every post goes to whichever channel is active.
 *
 * The trigger is a status transition into a configured list, checked only
 * while time off is active (phase 0 decision 5); `coverage_posts` dedupes on
 * (case_number, trigger_status, trigger_at) via INSERT OR IGNORE (decision 6);
 * dry run starts true and nothing reaches Slack while it is (decision 7).
 */

import { randomUUID } from "crypto";
import { db, now, getSetting, getSettingBool, setSetting } from "./db";
import { log } from "./log";
import { zoned } from "./businessHours";
import { config } from "./config";
import { nextActionForKeyword } from "./nextAction";
import type { Keyword } from "./iqs/rubric";
import { getSummary } from "./iqs/store";
import { listCommitmentsForCase, getCaseRow } from "./queries";
import type { CaseRow } from "./queries";
import { getRecentStatusHistory } from "./salesforce";

/* --------------------------------------------------------------- channels */

export interface CoverageChannel {
  id: string;
  label: string;
  webhookUrl: string;
  createdAt: number;
}

interface ChannelRow {
  id: string;
  label: string;
  webhook_url: string;
  created_at: number;
}

function toApiChannel(r: ChannelRow): CoverageChannel {
  return { id: r.id, label: r.label, webhookUrl: r.webhook_url, createdAt: r.created_at };
}

export function listChannels(): CoverageChannel[] {
  return (db.prepare("SELECT * FROM coverage_channels ORDER BY created_at ASC").all() as ChannelRow[]).map(toApiChannel);
}

export function addChannel(label: string, webhookUrl: string): CoverageChannel {
  const trimmedLabel = label.trim();
  const trimmedUrl = webhookUrl.trim();
  if (!trimmedLabel) throw new Error("Label is required");
  if (!/^https:\/\//i.test(trimmedUrl)) throw new Error("Webhook URL must start with https://");
  const row: ChannelRow = { id: randomUUID(), label: trimmedLabel, webhook_url: trimmedUrl, created_at: now() };
  db.prepare(
    "INSERT INTO coverage_channels (id, label, webhook_url, created_at) VALUES (@id, @label, @webhook_url, @created_at)",
  ).run(row);
  return toApiChannel(row);
}

export function deleteChannel(id: string): void {
  db.prepare("DELETE FROM coverage_channels WHERE id = ?").run(id);
  if (getSetting("coverageActiveChannelId") === id) setSetting("coverageActiveChannelId", "");
}

export function setActiveChannel(id: string): void {
  const exists = db.prepare("SELECT 1 FROM coverage_channels WHERE id = ?").get(id);
  if (!exists) throw new Error("Channel not found");
  setSetting("coverageActiveChannelId", id);
}

export function getActiveChannel(): CoverageChannel | null {
  const id = getSetting("coverageActiveChannelId");
  if (!id) return null;
  const row = db.prepare("SELECT * FROM coverage_channels WHERE id = ?").get(id) as ChannelRow | undefined;
  return row ? toApiChannel(row) : null;
}

async function postToWebhook(url: string, text: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
}

/** Proves a channel is wired correctly without waiting for a real trigger. */
export async function sendTestMessage(channelId: string): Promise<{ ok: boolean; error?: string }> {
  const row = db.prepare("SELECT * FROM coverage_channels WHERE id = ?").get(channelId) as ChannelRow | undefined;
  if (!row) return { ok: false, error: "Channel not found" };
  try {
    await postToWebhook(
      row.webhook_url,
      `QView coverage test, sent to "${row.label}". If you can read this, the channel is wired correctly — no real coverage post has gone out.`,
    );
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

/* -------------------------------------------------------------- time off */

function etDateKey(at: number | Date): string {
  const p = zoned(at);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Whole-day, ET-calendar check -- shared by the live sweep and the backtest, so both agree on what counts. */
export function isTimeOffActiveOn(at: number | Date): boolean {
  const key = etDateKey(at);
  const row = db.prepare("SELECT 1 FROM time_off WHERE start_date <= ? AND end_date >= ? LIMIT 1").get(key, key);
  return !!row;
}

export function isTimeOffActiveToday(): boolean {
  return isTimeOffActiveOn(Date.now());
}

/* -------------------------------------------------------------- compose */

/** Comma-separated in settings; trimmed and case-sensitive-matched against Salesforce's own status strings. */
export function triggerStatuses(): string[] {
  return getSetting("coverageTriggerStatuses")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "Sep 04, 6:00 PM ET" -- plain enough for a Slack line, no client-side formatter available server-side. */
function shortEt(iso: string): string {
  const p = zoned(new Date(iso));
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "AM" : "PM";
  return `${months[p.month - 1]} ${String(p.day).padStart(2, "0")}, ${h12}:${String(p.minute).padStart(2, "0")} ${ampm} ET`;
}

function caseLink(caseId: string): string {
  const base = config.salesforce.instanceUrl.replace(/\/+$/, "");
  return `${base}/lightning/r/Case/${caseId}/view`;
}

/**
 * Deterministic, not model-drafted -- a coverage post is structured facts
 * (what changed, what it needs, what's already promised), not prose that
 * benefits from a model's judgement. Reuses nextActionForKeyword() so a
 * colleague reading Slack sees the same "what does this need" read the
 * queue itself would show, and listCommitmentsForCase() so a promised
 * deadline is visible without opening the case.
 */
function composeBody(c: CaseRow, triggerStatus: string): string {
  const summary = getSummary(c.id);
  const keyword: Keyword = (summary?.keyword as Keyword) || "UPDATE";
  const na = nextActionForKeyword({
    keyword,
    status: c.status,
    custQuietDays: c.last_customer_update
      ? (Date.now() - new Date(c.last_customer_update).getTime()) / 86400000
      : null,
    nccOverdue: c.ncc_date ? new Date(c.ncc_date).getTime() < Date.now() : false,
    isEscalated: !!c.is_escalated,
  });

  const commitments = listCommitmentsForCase(c.case_number).filter(
    (cm: any) => cm.state === "active" || cm.state === "breached",
  );

  const lines = [
    `*${c.case_number}* moved to *${triggerStatus}* — ${c.subject || "(no subject)"}`,
    `${c.account || "(no account)"} · ${c.priority || "no priority"}${c.is_escalated ? " · escalated" : ""}`,
    `Next action: ${na.label} — ${na.reason}`,
  ];
  if (commitments.length) {
    lines.push(
      "Commitments: " +
        commitments
          .map((cm: any) => (cm.state === "breached" ? "BREACHED" : "due") + (cm.dueAt ? " " + shortEt(cm.dueAt) : " (no date)"))
          .join("; "),
    );
  }
  lines.push(caseLink(c.id));
  return lines.join("\n");
}

/* --------------------------------------------------------------- record */

const insertPost = db.prepare(
  `INSERT OR IGNORE INTO coverage_posts
     (id, case_id, case_number, trigger_status, trigger_at, body, channel_id, dry_run, delivered, created_at)
   VALUES (@id, @case_id, @case_number, @trigger_status, @trigger_at, @body, @channel_id, @dry_run, 0, @created_at)`,
);
const markDelivered = db.prepare("UPDATE coverage_posts SET delivered = 1, error = NULL WHERE id = ?");
const markError = db.prepare("UPDATE coverage_posts SET error = ? WHERE id = ?");
const markDiscarded = db.prepare("UPDATE coverage_posts SET discarded_at = ? WHERE id = ?");
const updateBody = db.prepare("UPDATE coverage_posts SET body = ? WHERE id = ?");
const selectPost = db.prepare("SELECT * FROM coverage_posts WHERE id = ?");

/**
 * Composes and records one qualifying transition. Never sends anything
 * itself -- phase 8's approval queue is the only path to a real Slack post
 * (see PLAN_V3.md's phase 8 section for why auto-send on dry-run-off was
 * wrong: it contradicted this project's own no-autonomous-sending rule).
 * Returns without inserting when the (case_number, trigger_status,
 * trigger_at) triple was already recorded -- the dedup is a primary-key
 * check, not a re-run of this function's own logic.
 */
async function recordTransition(c: CaseRow, triggerStatus: string, triggerAtIso: string): Promise<void> {
  const dryRun = getSettingBool("coverageDryRun");
  const channel = getActiveChannel();
  const id = randomUUID();
  const body = composeBody(c, triggerStatus);

  const res = insertPost.run({
    id,
    case_id: c.id,
    case_number: c.case_number,
    trigger_status: triggerStatus,
    trigger_at: triggerAtIso,
    body,
    channel_id: channel?.id ?? null,
    dry_run: dryRun || !channel ? 1 : 0,
    created_at: now(),
  });
  if (res.changes === 0) return; // already recorded for this exact transition

  log.info("coverage.trigger", { caseNumber: c.case_number, triggerStatus, dryRun: dryRun || !channel, queued: !dryRun && !!channel });
}

export type PostStatus = "dry_run" | "pending" | "sent" | "failed" | "discarded";

function statusOf(r: { dry_run: number; delivered: number; error: string | null; discarded_at: number | null }): PostStatus {
  if (r.discarded_at) return "discarded";
  if (r.dry_run) return "dry_run";
  if (r.delivered) return "sent";
  if (r.error) return "failed";
  return "pending";
}

/**
 * The one path to a real Slack post. A human calls this -- from the
 * approval queue, optionally after editing the body -- there is no
 * automatic route here from a sync or a sweep.
 */
export async function approvePost(id: string, editedBody?: string): Promise<{ ok: boolean; error?: string }> {
  const post = selectPost.get(id) as PostRow | undefined;
  if (!post) return { ok: false, error: "Post not found" };
  if (post.dry_run) return { ok: false, error: "Dry-run posts cannot be sent -- turn dry run off first" };
  if (post.discarded_at) return { ok: false, error: "This post was discarded" };
  if (post.delivered) return { ok: false, error: "Already sent" };

  const channelId = post.channel_id;
  const channel = channelId ? (db.prepare("SELECT * FROM coverage_channels WHERE id = ?").get(channelId) as ChannelRow | undefined) : undefined;
  if (!channel) return { ok: false, error: "No channel is available for this post -- it may have been removed" };

  const body = editedBody?.trim() || post.body;
  if (editedBody?.trim()) updateBody.run(body, id);

  try {
    await postToWebhook(channel.webhook_url, body);
    markDelivered.run(id);
    log.info("coverage.sent", { caseNumber: post.case_number, id });
    return { ok: true };
  } catch (err: any) {
    markError.run(err.message, id);
    log.warn("coverage.deliver_failed", { caseNumber: post.case_number, error: err.message });
    return { ok: false, error: err.message };
  }
}

export function discardPost(id: string): void {
  markDiscarded.run(now(), id);
}

/**
 * Called from sync.ts with every case whose status just changed. Filtered
 * here, not by the caller, so "what counts" lives in exactly one place.
 */
export async function sweepTransitions(
  transitions: Array<{ caseNumber: string; newStatus: string | null }>,
): Promise<void> {
  if (!transitions.length || !isTimeOffActiveToday()) return;
  const triggers = new Set(triggerStatuses());
  if (!triggers.size) return;

  for (const t of transitions) {
    if (!t.newStatus || !triggers.has(t.newStatus)) continue;
    const c = getCaseRow(t.caseNumber);
    if (!c) continue;
    // The case's own last-modified stamp, not wall-clock-at-detection-time.
    // Caught by testing: using new Date() here meant re-running the sweep on
    // an unchanged case (an overlapping or retried sync) minted a different
    // trigger_at every time, so the UNIQUE(case_number, trigger_status,
    // trigger_at) dedup never actually matched and silently duplicated the
    // post. last_modified_date is stable across such a re-run and only moves
    // when Salesforce itself records a real further change.
    await recordTransition(c, t.newStatus, c.last_modified_date);
  }
}

/* -------------------------------------------------------------- backtest */

export interface BacktestResult {
  days: number;
  transitionsChecked: number;
  wouldHaveFired: number;
  sample: Array<{ caseNumber: string; status: string; at: string }>;
}

/**
 * Reads real Status history (salesforce.ts:getRecentStatusHistory(), backed
 * by CaseHistory -- confirmed live before this was written that this org
 * tracks Status and real transitions exist) rather than simulating from
 * current state. Checks each transition's own timestamp against declared
 * time_off ranges with the same isTimeOffActiveOn() the live sweep uses, so
 * a backtest and the real thing can never disagree about what counts.
 */
export async function backtest30Days(): Promise<BacktestResult> {
  const days = 30;
  const triggers = new Set(triggerStatuses());
  const history = await getRecentStatusHistory(days);

  const hits = history.filter(
    (t) => t.newValue && triggers.has(t.newValue) && isTimeOffActiveOn(new Date(t.createdDate)),
  );

  return {
    days,
    transitionsChecked: history.length,
    wouldHaveFired: hits.length,
    sample: hits.slice(0, 20).map((t) => ({ caseNumber: t.caseNumber, status: t.newValue!, at: t.createdDate })),
  };
}

/* ----------------------------------------------------------------- posts */

interface PostRow {
  id: string;
  case_number: string;
  trigger_status: string;
  trigger_at: string;
  body: string;
  channel_id: string | null;
  dry_run: number;
  delivered: number;
  error: string | null;
  discarded_at: number | null;
  created_at: number;
}

function toApiPost(r: PostRow) {
  return {
    id: r.id,
    caseNumber: r.case_number,
    triggerStatus: r.trigger_status,
    triggerAt: r.trigger_at,
    body: r.body,
    channelId: r.channel_id,
    dryRun: r.dry_run === 1,
    delivered: r.delivered === 1,
    error: r.error,
    discardedAt: r.discarded_at,
    status: statusOf(r),
    createdAt: r.created_at,
  };
}

export function listRecentPosts(limit = 50) {
  const rows = db.prepare("SELECT * FROM coverage_posts ORDER BY created_at DESC LIMIT ?").all(limit) as PostRow[];
  return rows.map(toApiPost);
}

/** Phase 9's Recap: coverage activity in a period, not just "the most recent N." */
export function listPostsSince(sinceMs: number) {
  const rows = db.prepare("SELECT * FROM coverage_posts WHERE created_at >= ? ORDER BY created_at DESC").all(sinceMs) as PostRow[];
  return rows.map(toApiPost);
}
