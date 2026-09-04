/**
 * Background sync: Salesforce -> local cache.
 *
 * The UI never waits on Salesforce. This loop pulls deltas on
 * `LastModifiedDate`, derives everything expensive once (product area,
 * artifacts, error signature, touch timestamps, commitments), and writes it to
 * SQLite. A Salesforce outage therefore degrades to a staleness banner over
 * last-good data rather than an empty page.
 */

import { config } from "./config";
import { runEvents, SyncDelta, DeltaCase } from "./notify";
import {
  db,
  newId,
  now,
  getSetting,
  getSettingNumber,
  getSettingBool,
  getSyncState,
  patchSyncState,
} from "./db";
import {
  SalesforceCase,
  SalesforceCaseComment,
  SalesforceEmail,
  listCasesModifiedSince,
  getCommentsForCases,
  getEmailsForCases,
  isEmailAccessDenied,
} from "./salesforce";
import { deriveProductArea } from "./productArea";
import { extractArtifacts, errorSignature } from "./artifacts";
import { parseCommitments } from "./commitments";
import { scoreCases } from "./iqs/store";
import { sweepTransitions } from "./coverage";
import { zoned } from "./businessHours";
import { log, errText } from "./log";

const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<SyncResult> | null = null;

export interface SyncResult {
  ok: boolean;
  cases: number;
  comments: number;
  commitments: number;
  durationMs: number;
  error?: string;
  emailsUnavailable: boolean;
}

/* ------------------------------------------------------------ authorship */

function normalise(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

const ME = normalise(config.salesforce.ownerName);

/** True when a comment or email was written by the case owner. */
function authoredByMe(author: string | null | undefined): boolean {
  if (!ME) return false;
  return normalise(author) === ME;
}

/* ------------------------------------------------------------- upserting */

const upsertCase = db.prepare(`
INSERT INTO cases (
  id, case_number, subject, description, status, priority, type, origin,
  component, sub_component, account, contact_name, owner, owner_title, labels,
  is_escalated, is_closed, created_date, last_modified_date, closed_date,
  ncc_date, last_customer_update, active_ttr_days, product_area, synced_at
) VALUES (
  @id, @case_number, @subject, @description, @status, @priority, @type, @origin,
  @component, @sub_component, @account, @contact_name, @owner, @owner_title, @labels,
  @is_escalated, @is_closed, @created_date, @last_modified_date, @closed_date,
  @ncc_date, @last_customer_update, @active_ttr_days, @product_area, @synced_at
)
ON CONFLICT(id) DO UPDATE SET
  case_number = excluded.case_number,
  subject = excluded.subject,
  description = excluded.description,
  status = excluded.status,
  priority = excluded.priority,
  type = excluded.type,
  origin = excluded.origin,
  component = excluded.component,
  sub_component = excluded.sub_component,
  account = excluded.account,
  contact_name = excluded.contact_name,
  owner = excluded.owner,
  owner_title = excluded.owner_title,
  labels = excluded.labels,
  is_escalated = excluded.is_escalated,
  is_closed = excluded.is_closed,
  created_date = excluded.created_date,
  last_modified_date = excluded.last_modified_date,
  closed_date = excluded.closed_date,
  ncc_date = excluded.ncc_date,
  last_customer_update = excluded.last_customer_update,
  active_ttr_days = excluded.active_ttr_days,
  product_area = excluded.product_area,
  synced_at = excluded.synced_at
`);

const upsertComment = db.prepare(`
INSERT INTO comments (
  id, case_id, case_number, source, body, author, author_email,
  is_public, is_mine, is_inbound, subject, created_date, synced_at
) VALUES (
  @id, @case_id, @case_number, @source, @body, @author, @author_email,
  @is_public, @is_mine, @is_inbound, @subject, @created_date, @synced_at
)
ON CONFLICT(id) DO UPDATE SET
  body = excluded.body,
  author = excluded.author,
  author_email = excluded.author_email,
  is_public = excluded.is_public,
  is_mine = excluded.is_mine,
  is_inbound = excluded.is_inbound,
  subject = excluded.subject,
  created_date = excluded.created_date,
  synced_at = excluded.synced_at
`);

const insertArtifact = db.prepare(`
INSERT OR IGNORE INTO artifacts (id, case_id, case_number, kind, value, created_at)
VALUES (@id, @case_id, @case_number, @kind, @value, @created_at)
`);

const insertCommitment = db.prepare(`
INSERT OR IGNORE INTO commitments (
  id, case_id, case_number, due_at, raw_text, source, source_comment_id,
  state, created_at, updated_at
) VALUES (
  @id, @case_id, @case_number, @due_at, @raw_text, 'parsed', @source_comment_id,
  @state, @created_at, @updated_at
)
`);

function caseRow(c: SalesforceCase, syncedAt: number) {
  return {
    id: c.Id,
    case_number: c.CaseNumber,
    subject: c.Subject,
    description: c.Description,
    status: c.Status,
    priority: c.Priority,
    type: c.Type,
    origin: c.Origin,
    component: c.Problem_Type__c,
    sub_component: c.Sub_Component__c,
    account: c.Account ? c.Account.Name : null,
    contact_name: c.Contact_Name__c,
    owner: c.Owner ? c.Owner.Name : null,
    owner_title: c.Owner ? c.Owner.Title : null,
    labels: c.Labels__c,
    is_escalated: c.IsEscalated ? 1 : 0,
    is_closed: c.IsClosed ? 1 : 0,
    created_date: c.CreatedDate,
    last_modified_date: c.LastModifiedDate,
    closed_date: c.ClosedDate,
    ncc_date: c.NCC_date__c,
    last_customer_update: c.Last_Customer_Update__c,
    active_ttr_days: c.Active_TTR__c,
    product_area: deriveProductArea({
      problemType: c.Problem_Type__c,
      subComponent: c.Sub_Component__c,
      subject: c.Subject,
      description: c.Description,
    }),
    synced_at: syncedAt,
  };
}

function commentRow(c: SalesforceCaseComment, caseNumber: string, syncedAt: number) {
  const author = c.CreatedBy ? c.CreatedBy.Name : null;
  const mine = authoredByMe(author);
  return {
    id: c.Id,
    case_id: c.ParentId,
    case_number: caseNumber,
    source: "comment",
    body: c.CommentBody || "",
    author,
    author_email: c.CreatedBy ? c.CreatedBy.Email : null,
    is_public: c.IsPublished ? 1 : 0,
    is_mine: mine ? 1 : 0,
    // A public comment by anyone other than me is treated as customer-side
    // input. Internal notes by colleagues are not: they do not put the ball
    // back in my court with the customer.
    is_inbound: !mine && c.IsPublished ? 1 : 0,
    subject: null as string | null,
    created_date: c.CreatedDate,
    synced_at: syncedAt,
  };
}

function emailRow(e: SalesforceEmail, caseNumber: string, syncedAt: number) {
  const author = e.FromName || e.FromAddress;
  const mine = !e.Incoming && authoredByMe(author);
  return {
    id: e.Id,
    case_id: e.ParentId,
    case_number: caseNumber,
    source: "email",
    body: e.TextBody || "",
    author,
    author_email: e.FromAddress,
    is_public: 1,
    is_mine: mine ? 1 : 0,
    is_inbound: e.Incoming ? 1 : 0,
    subject: e.Subject,
    created_date: e.MessageDate || e.CreatedDate,
    synced_at: syncedAt,
  };
}

/* -------------------------------------------------------- derived per case */

interface TouchRow {
  created_date: string;
  is_mine: number;
  is_inbound: number;
  is_public: number;
  body: string;
  id: string;
}

const selectTimeline = db.prepare(
  "SELECT id, created_date, is_mine, is_inbound, is_public, body FROM comments WHERE case_id = ? ORDER BY created_date ASC",
);

const updateDerived = db.prepare(`
UPDATE cases SET
  error_signature = @error_signature,
  first_response_at = @first_response_at,
  last_my_touch = @last_my_touch,
  last_customer_touch = @last_customer_touch,
  needs_my_reply = @needs_my_reply,
  comment_count = @comment_count,
  comments_synced_at = @comments_synced_at
WHERE id = @id
`);

/**
 * Recompute everything derived from a case's full timeline, then re-extract
 * artifacts and commitments. Runs inside the sync transaction.
 */
function recomputeCase(caseId: string, caseNumber: string, isClosed: boolean, seedText: string): number {
  const rows = selectTimeline.all(caseId) as TouchRow[];

  let firstResponse: string | null = null;
  let lastMine: string | null = null;
  let lastCustomer: string | null = null;

  for (const r of rows) {
    if (r.is_mine) {
      lastMine = r.created_date;
      if (!firstResponse && r.is_public) firstResponse = r.created_date;
    } else if (r.is_inbound) {
      lastCustomer = r.created_date;
    }
  }

  // The single most important state in the queue: the customer spoke last.
  const needsReply =
    !isClosed &&
    !!lastCustomer &&
    (!lastMine || Date.parse(lastCustomer) > Date.parse(lastMine));

  const corpus = [seedText, ...rows.map((r) => r.body)].filter(Boolean).join("\n\n");
  const artifacts = extractArtifacts(corpus);

  const ts = now();
  db.prepare("DELETE FROM artifacts WHERE case_id = ?").run(caseId);
  for (const a of artifacts) {
    insertArtifact.run({
      id: newId(),
      case_id: caseId,
      case_number: caseNumber,
      kind: a.kind,
      value: a.value,
      created_at: ts,
    });
  }

  let added = 0;
  for (const r of rows) {
    if (!r.is_mine || !r.body) continue;
    const found = parseCommitments(r.body, new Date(r.created_date));
    for (const p of found) {
      const info = insertCommitment.run({
        id: newId(),
        case_id: caseId,
        case_number: caseNumber,
        due_at: p.dueAt ? p.dueAt.toISOString() : null,
        raw_text: p.raw,
        source_comment_id: r.id,
        state: p.dueAt ? "active" : "unparsed",
        created_at: ts,
        updated_at: ts,
      });
      if (info.changes) added++;
    }
  }

  updateDerived.run({
    id: caseId,
    error_signature: errorSignature(artifacts),
    first_response_at: firstResponse,
    last_my_touch: lastMine,
    last_customer_touch: lastCustomer,
    needs_my_reply: needsReply ? 1 : 0,
    comment_count: rows.length,
    comments_synced_at: ts,
  });

  return added;
}

/**
 * Move commitments between states.
 *
 * A commitment is met when I posted on the case after making the promise and
 * before it came due; it is breached when the deadline passed with nothing
 * from me. This runs over the whole table on every sync so the bands stay
 * honest without anybody pressing a button.
 */
export function reconcileCommitments(): void {
  const ts = now();
  const nowIso = new Date(ts).toISOString();

  const active = db
    .prepare(
      "SELECT id, case_id, due_at, created_at, source_comment_id FROM commitments WHERE state = 'active' AND due_at IS NOT NULL",
    )
    .all() as Array<{
    id: string;
    case_id: string;
    due_at: string;
    created_at: number;
    source_comment_id: string | null;
  }>;

  const promisedAt = db.prepare("SELECT created_date FROM comments WHERE id = ?");
  const touchAfter = db.prepare(
    "SELECT created_date FROM comments WHERE case_id = ? AND is_mine = 1 AND created_date > ? AND created_date <= ? ORDER BY created_date ASC LIMIT 1",
  );

  const markMet = db.prepare(
    "UPDATE commitments SET state = 'met', met_at = ?, updated_at = ? WHERE id = ?",
  );
  const markBreached = db.prepare(
    "UPDATE commitments SET state = 'breached', updated_at = ? WHERE id = ?",
  );

  for (const c of active) {
    let from = new Date(c.created_at).toISOString();
    if (c.source_comment_id) {
      const src = promisedAt.get(c.source_comment_id) as { created_date: string } | undefined;
      if (src) from = src.created_date;
    }

    const met = touchAfter.get(c.case_id, from, c.due_at) as
      | { created_date: string }
      | undefined;

    if (met) {
      markMet.run(met.created_date, ts, c.id);
    } else if (c.due_at < nowIso) {
      markBreached.run(ts, c.id);
    }
  }
}

/* ------------------------------------------------------------- the sync run */

export async function syncOnce(full = false): Promise<SyncResult> {
  if (inFlight) return inFlight;
  inFlight = runSync(full).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(full: boolean): Promise<SyncResult> {
  const started = Date.now();
  const state = getSyncState();
  const since = full ? null : state.watermark;

  patchSyncState({ running: 1, last_attempt: started });
  log.info("sync.start", { full, since });

  try {
    const cases = await listCasesModifiedSince(since);

    if (!cases.length) {
      // Nothing moved in Salesforce, but a deadline can arrive on its own.
      await runEvents(null, false);
      const durationMs = Date.now() - started;
      patchSyncState({
        running: 0,
        last_success: Date.now(),
        last_error: null,
        error_count: 0,
        last_duration_ms: durationMs,
      });
      log.info("sync.done", { cases: 0, comments: 0, durationMs });
      return { ok: true, cases: 0, comments: 0, commitments: 0, durationMs, emailsUnavailable: isEmailAccessDenied() };
    }

    const caseIds = cases.map((c) => c.Id);
    const numberById = new Map(cases.map((c) => [c.Id, c.CaseNumber]));

    // Comments are pulled for the changed cases only. A comment edit bumps the
    // parent case's LastModifiedDate, so the delta stays correct without
    // re-reading every thread on every poll.
    const comments = await getCommentsForCases(caseIds);
    const emails = await getEmailsForCases(caseIds);

    const syncedAt = now();
    let newCommitments = 0;

    // A row cannot tell you it moved, so the before-state is read while it is
    // still the before-state. Only the cases in this batch are looked at.
    const priorRows = db
      .prepare(
        "SELECT case_number, needs_my_reply, status FROM cases WHERE id IN (" +
          caseIds.map(() => "?").join(",") +
          ")",
      )
      .all(...caseIds) as Array<{ case_number: string; needs_my_reply: number; status: string | null }>;
    const priorSeen = new Set(priorRows.map((r) => r.case_number));
    const priorNeedsReply = new Map(priorRows.map((r) => [r.case_number, !!r.needs_my_reply]));
    const priorStatus = new Map(priorRows.map((r) => [r.case_number, r.status]));

    const write = db.transaction(() => {
      for (const c of cases) upsertCase.run(caseRow(c, syncedAt));

      for (const cm of comments) {
        const num = numberById.get(cm.ParentId);
        if (!num) continue;
        upsertComment.run(commentRow(cm, num, syncedAt));
      }

      for (const em of emails) {
        const num = numberById.get(em.ParentId);
        if (!num) continue;
        upsertComment.run(emailRow(em, num, syncedAt));
      }

      for (const c of cases) {
        const seed = [c.Subject, c.Description].filter(Boolean).join("\n\n");
        newCommitments += recomputeCase(c.Id, c.CaseNumber, c.IsClosed, seed);
      }
    });

    write();
    reconcileCommitments();

    // Quality scoring runs here and not inside recomputeCase(): the Reliability
    // dimension reads commitment states, and those states are only correct
    // after reconciliation has moved what came due. Layer 1 is pure regex over
    // rows already in hand, so this costs no API call and no round trip.
    const graded = scoreCases(caseIds);

    const afterRows = db
      .prepare(
        "SELECT case_number, subject, priority, account, created_date, last_customer_touch," +
          " is_closed, needs_my_reply, status FROM cases WHERE id IN (" +
          caseIds.map(() => "?").join(",") +
          ")",
      )
      .all(...caseIds) as Array<{
      case_number: string;
      subject: string | null;
      priority: string | null;
      account: string | null;
      created_date: string | null;
      last_customer_touch: string | null;
      is_closed: number;
      needs_my_reply: number;
      status: string | null;
    }>;

    const delta: SyncDelta = { created: [], replied: [] };
    const statusTransitions: Array<{ caseNumber: string; newStatus: string | null }> = [];
    for (const r of afterRows) {
      const d: DeltaCase = {
        caseNumber: r.case_number,
        subject: r.subject,
        priority: r.priority,
        account: r.account,
        createdDate: r.created_date,
        lastCustomerTouch: r.last_customer_touch,
        isClosed: !!r.is_closed,
      };
      if (!priorSeen.has(r.case_number)) delta.created.push(d);
      if (r.needs_my_reply && !priorNeedsReply.get(r.case_number)) delta.replied.push(d);
      // A row cannot tell you it moved, same as needs_my_reply above -- only a
      // case that existed before with a different status counts as a
      // transition. A full resync would make every case look like it just
      // transitioned, so it is suppressed the same way case.new events are.
      if (priorSeen.has(r.case_number) && priorStatus.get(r.case_number) !== r.status) {
        statusTransitions.push({ caseNumber: r.case_number, newStatus: r.status });
      }
    }

    // A full resync repopulates an empty cache, where every case looks new.
    // Announcing all of them would be indistinguishable from a malfunction.
    const suppressTransitionEvents = full || since === null;
    await runEvents(delta, suppressTransitionEvents);
    if (!suppressTransitionEvents) {
      await sweepTransitions(statusTransitions).catch((err) =>
        log.warn("coverage.sweep_failed", { error: (err as Error).message }),
      );
    }

    // Watermark from the data, not the clock: a case modified during the run
    // must not be skipped next time.
    const watermark = cases.reduce(
      (max, c) => (c.LastModifiedDate > max ? c.LastModifiedDate : max),
      state.watermark || "",
    );

    const durationMs = Date.now() - started;
    patchSyncState({
      running: 0,
      watermark: watermark || null,
      last_success: Date.now(),
      last_error: null,
      error_count: 0,
      last_duration_ms: durationMs,
    });

    log.info("sync.done", {
      cases: cases.length,
      comments: comments.length,
      emails: emails.length,
      commitments: newCommitments,
      scored: graded.scored,
      scoreFailures: graded.failed,
      durationMs,
      watermark,
    });

    return {
      ok: true,
      cases: cases.length,
      comments: comments.length + emails.length,
      commitments: newCommitments,
      durationMs,
      emailsUnavailable: isEmailAccessDenied(),
    };
  } catch (e) {
    const durationMs = Date.now() - started;
    const message = errText(e);
    const prior = getSyncState();
    patchSyncState({
      running: 0,
      last_error: message,
      error_count: prior.error_count + 1,
      last_duration_ms: durationMs,
    });
    log.error("sync.failed", { error: message, durationMs, errorCount: prior.error_count + 1 });
    return {
      ok: false,
      cases: 0,
      comments: 0,
      commitments: 0,
      durationMs,
      error: message,
      emailsUnavailable: isEmailAccessDenied(),
    };
  }
}

/* ------------------------------------------------------------- the schedule */

/** Is the clock inside the configured active window? */
export function withinActiveWindow(at: Date = new Date()): boolean {
  const p = zoned(at);
  if (getSettingBool("activeWindowWeekdaysOnly") && (p.weekday === 0 || p.weekday === 6)) {
    return false;
  }
  const start = getSettingNumber("activeWindowStart");
  const end = getSettingNumber("activeWindowEnd");
  if (start === end) return true; // configured as always-on
  if (start < end) return p.hour >= start && p.hour < end;
  return p.hour >= start || p.hour < end; // window wraps midnight
}

function nextDelay(): number {
  const errors = getSyncState().error_count;
  const base = Math.max(1, getSettingNumber("syncIntervalMinutes")) * 60_000;
  if (!errors) return base;
  // Exponential backoff on consecutive failures, capped so a recovered
  // Salesforce is picked up within half an hour.
  const backoff = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * Math.pow(2, Math.min(errors, 8) - 1));
  return Math.max(base, backoff);
}

function schedule(delay: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delay);
  if (typeof timer.unref === "function") timer.unref();
}

async function tick(): Promise<void> {
  if (withinActiveWindow()) {
    await syncOnce(false);
  } else {
    log.debug("sync.skipped", { reason: "outside active window" });
  }
  schedule(nextDelay());
}

/** Start the background loop. The first pull runs shortly after boot. */
export function startSync(): void {
  log.info("sync.scheduled", {
    intervalMinutes: getSettingNumber("syncIntervalMinutes"),
    activeWindow: getSetting("activeWindowStart") + "-" + getSetting("activeWindowEnd"),
  });
  schedule(3_000);
}

export function stopSync(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
