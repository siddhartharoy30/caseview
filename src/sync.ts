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
import { runEvents, SyncDelta, DeltaCase, recordLeftQueueEvent } from "./notify";
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
  listOpenCases,
  getOwnershipStatus,
  ownerId,
  getCommentsForCases,
  getEmailsForCases,
  isEmailAccessDenied,
} from "./salesforce";
import { deriveProductArea } from "./productArea";
import { extractArtifacts, errorSignature } from "./artifacts";
import { parseCommitments } from "./commitments";
import { parseEmailBody, EMAIL_PARSER_VERSION } from "./emailBody";
import { scoreCases } from "./iqs/store";
import { sweepTransitions, triggerStatuses } from "./coverage";
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
  ncc_date, last_customer_update, active_ttr_days, product_area, synced_at,
  owned, current_owner, left_queue_at, left_reason,
  rsc_url, rsc_instance_status, us_federal, is_fedramp, federal_support_access,
  cluster_uuid, cluster_tag, cluster_version,
  cluster2_uuid, cluster2_tag, cluster2_version, platform, case_version_raw
) VALUES (
  @id, @case_number, @subject, @description, @status, @priority, @type, @origin,
  @component, @sub_component, @account, @contact_name, @owner, @owner_title, @labels,
  @is_escalated, @is_closed, @created_date, @last_modified_date, @closed_date,
  @ncc_date, @last_customer_update, @active_ttr_days, @product_area, @synced_at,
  1, @owner, NULL, NULL,
  @rsc_url, @rsc_instance_status, @us_federal, @is_fedramp, @federal_support_access,
  @cluster_uuid, @cluster_tag, @cluster_version,
  @cluster2_uuid, @cluster2_tag, @cluster2_version, @platform, @case_version_raw
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
  synced_at = excluded.synced_at,
  owned = 1,
  current_owner = excluded.owner,
  left_queue_at = NULL,
  left_reason = NULL,
  rsc_url = excluded.rsc_url,
  rsc_instance_status = excluded.rsc_instance_status,
  us_federal = excluded.us_federal,
  is_fedramp = excluded.is_fedramp,
  federal_support_access = excluded.federal_support_access,
  cluster_uuid = excluded.cluster_uuid,
  cluster_tag = excluded.cluster_tag,
  cluster_version = excluded.cluster_version,
  cluster2_uuid = excluded.cluster2_uuid,
  cluster2_tag = excluded.cluster2_tag,
  cluster2_version = excluded.cluster2_version,
  platform = excluded.platform,
  case_version_raw = excluded.case_version_raw
`);

const upsertComment = db.prepare(`
INSERT INTO comments (
  id, case_id, case_number, source, body, author, author_email,
  is_public, is_mine, is_inbound, subject, created_date, synced_at,
  envelope_from, envelope_to, envelope_cc, clean_body, quoted_body, parser_version
) VALUES (
  @id, @case_id, @case_number, @source, @body, @author, @author_email,
  @is_public, @is_mine, @is_inbound, @subject, @created_date, @synced_at,
  @envelope_from, @envelope_to, @envelope_cc, @clean_body, @quoted_body, @parser_version
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
  synced_at = excluded.synced_at,
  envelope_from = excluded.envelope_from,
  envelope_to = excluded.envelope_to,
  envelope_cc = excluded.envelope_cc,
  clean_body = excluded.clean_body,
  quoted_body = excluded.quoted_body,
  parser_version = excluded.parser_version
`);

/** Envelope/quote fields shared by commentRow() and emailRow() -- computed
 * once here so a re-synced comment (edited, or re-pulled after a retry)
 * always carries a fresh parse rather than whatever an older sync wrote. */
function parsedBodyFields(body: string) {
  const parsed = parseEmailBody(body);
  return {
    envelope_from: parsed.envelope?.from ?? null,
    envelope_to: parsed.envelope ? JSON.stringify(parsed.envelope.to) : null,
    envelope_cc: parsed.envelope ? JSON.stringify(parsed.envelope.cc) : null,
    clean_body: parsed.cleanBody,
    quoted_body: parsed.quotedBody,
    parser_version: EMAIL_PARSER_VERSION,
  };
}

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

const selectParsedForComment = db.prepare(
  "SELECT id, raw_text FROM commitments WHERE case_id = ? AND source_comment_id = ? AND source = 'parsed'",
);
const deleteCommitmentById = db.prepare("DELETE FROM commitments WHERE id = ?");

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
    // v8: resolved once here, not on every read -- Account_Polaris_URL__c is
    // primary, RSCInstance__r.RSCUrl__c is a fallback (docs/PLAN_V8.md).
    rsc_url: c.Account_Polaris_URL__c || (c.RSCInstance__r ? c.RSCInstance__r.RSCUrl__c : null) || null,
    rsc_instance_status: c.RSCInstance__r ? c.RSCInstance__r.Status__c : null,
    us_federal: c.US_Federal_Account__c ? 1 : 0,
    is_fedramp: c.isFedRAMP__c ? 1 : 0,
    federal_support_access: c.Federal_Account_Support_Access__c,
    // v8 part 2: CDM UI access (docs/PLAN_V8_CDM.md). tag__c, not Name -- see
    // salesforce.ts. case_version_raw keeps Software_Version__c unfiltered;
    // the ^\d+\.\d+ guard is applied at read time in cdmVersion.ts.
    cluster_uuid: c.Cluster__r ? c.Cluster__r.uuid__c : null,
    cluster_tag: c.Cluster__r ? c.Cluster__r.tag__c : null,
    cluster_version: c.Cluster__r ? c.Cluster__r.software_version__c : null,
    cluster2_uuid: c.Additional_Cluster__r ? c.Additional_Cluster__r.uuid__c : null,
    cluster2_tag: c.Additional_Cluster__r ? c.Additional_Cluster__r.tag__c : null,
    cluster2_version: c.Additional_Cluster__r ? c.Additional_Cluster__r.software_version__c : null,
    platform: c.Platform__c,
    case_version_raw: c.Software_Version__c,
  };
}

function commentRow(c: SalesforceCaseComment, caseNumber: string, syncedAt: number) {
  const author = c.CreatedBy ? c.CreatedBy.Name : null;
  const mine = authoredByMe(author);
  const body = c.CommentBody || "";
  return {
    id: c.Id,
    case_id: c.ParentId,
    case_number: caseNumber,
    source: "comment",
    body,
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
    ...parsedBodyFields(body),
  };
}

function emailRow(e: SalesforceEmail, caseNumber: string, syncedAt: number) {
  const author = e.FromName || e.FromAddress;
  const mine = !e.Incoming && authoredByMe(author);
  const body = e.TextBody || "";
  return {
    id: e.Id,
    case_id: e.ParentId,
    case_number: caseNumber,
    source: "email",
    body,
    author,
    author_email: e.FromAddress,
    is_public: 1,
    is_mine: mine ? 1 : 0,
    is_inbound: e.Incoming ? 1 : 0,
    subject: e.Subject,
    created_date: e.MessageDate || e.CreatedDate,
    synced_at: syncedAt,
    ...parsedBodyFields(body),
  };
}

/* -------------------------------------------------------- derived per case */

interface TouchRow {
  created_date: string;
  is_mine: number;
  is_inbound: number;
  is_public: number;
  body: string;
  clean_body: string | null;
  id: string;
}

const selectTimeline = db.prepare(
  "SELECT id, created_date, is_mine, is_inbound, is_public, body, clean_body FROM comments WHERE case_id = ? ORDER BY created_date ASC",
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

  // Correction 6: a promise the customer quotes back from my own earlier
  // email must not re-mint as a fresh commitment. clean_body has the quoted
  // history already stripped (see emailBody.ts); body is the fallback only
  // for a row somehow not yet backfilled.
  //
  // Correction 5's hazard, actually hit: switching the parser's input from
  // raw HTML body to clean_body changes raw_text for basically every
  // existing commitment (the old parser, fed "<br/>"-laced HTML instead of
  // real newlines, could not bound a sentence correctly and often captured
  // several paragraphs instead of one). idx_commitments_dedupe is keyed on
  // the literal raw_text, so a shifted value looks like a brand new
  // commitment instead of the same one re-observed -- confirmed against
  // real data (case 01273803 went from 14 to 31 rows on the first sync after
  // this change). Reconciling per comment -- delete whatever no longer
  // matches the current parse, insert whatever's missing -- fixes this
  // without discarding met/breached history for commitments whose raw_text
  // happens to still match.
  let added = 0;
  for (const r of rows) {
    if (!r.is_mine) continue;
    const text = r.clean_body ?? r.body;
    const found = text ? parseCommitments(text, new Date(r.created_date)) : [];
    const freshTexts = new Set(found.map((p) => p.raw));
    const existing = selectParsedForComment.all(caseId, r.id) as Array<{ id: string; raw_text: string }>;
    for (const ex of existing) if (!freshTexts.has(ex.raw_text)) deleteCommitmentById.run(ex.id);

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
      `SELECT cm.id, cm.case_id, cm.due_at, cm.created_at, cm.source_comment_id
         FROM commitments cm
         JOIN cases c ON c.id = cm.case_id
        WHERE cm.state = 'active' AND cm.due_at IS NOT NULL AND c.owned = 1`,
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

/* ------------------------------------------------------- ownership reconcile */

const selectLocalOpenOwned = db.prepare(
  "SELECT id, case_number FROM cases WHERE owned = 1 AND is_closed = 0",
);

const markLeftQueue = db.prepare(`
  UPDATE cases SET owned = 0, left_queue_at = @left_queue_at,
    left_reason = @left_reason, current_owner = @current_owner
  WHERE id = @id
`);

/**
 * A case transferred away from me drops out of listCasesModifiedSince()'s
 * owner-scoped delta forever, with no tombstone -- the local row just
 * freezes in whatever state it held at transfer time. listOpenCases() is the
 * authoritative remote open+owned set; anything locally marked owned+open
 * but absent from it has left the queue. Runs every sync regardless of the
 * delta batch's size -- a transfer is exactly the kind of change
 * listCasesModifiedSince() cannot see, so this cannot depend on the delta
 * having found anything. Never throws: a failure here must not fail an
 * otherwise-successful sync -- the delta side already landed and the
 * watermark still needs to advance.
 */
export async function reconcileOwnership(): Promise<{ left: number; skipped: boolean }> {
  if (!getSettingBool("reconcileOwnership")) return { left: 0, skipped: true };

  try {
    const remote = await listOpenCases();

    // soqlQueryAll's own hard cap (20,000) is the real ceiling now that
    // listOpenCases() carries no SOQL-level LIMIT. Hitting it means the page
    // may be truncated -- treating everything past it as "transferred" would
    // be exactly the false positive this guard exists to prevent.
    if (remote.length >= 20000) {
      log.warn("sync.reconcile_ownership_skipped", { reason: "hit the 20000-row cap", count: remote.length });
      return { left: 0, skipped: true };
    }

    const remoteIds = new Set(remote.map((c) => c.Id));
    const local = selectLocalOpenOwned.all() as Array<{ id: string; case_number: string }>;
    const missing = local.filter((r) => !remoteIds.has(r.id));
    if (!missing.length) return { left: 0, skipped: false };

    const requeried = await getOwnershipStatus(missing.map((r) => r.id));
    const byId = new Map(requeried.map((r) => [r.Id, r]));

    const ts = now();
    const nowIso = new Date(ts).toISOString();
    const left: string[] = [];

    db.transaction(() => {
      for (const row of missing) {
        const r = byId.get(row.id);
        if (!r) {
          // Deleted or merged in Salesforce -- mark it and leave it alone.
          markLeftQueue.run({ id: row.id, left_queue_at: nowIso, left_reason: "not_found", current_owner: null });
          left.push(row.case_number);
          continue;
        }
        const stillMine = r.OwnerId === ownerId();
        if (!stillMine) {
          markLeftQueue.run({ id: row.id, left_queue_at: nowIso, left_reason: "transferred", current_owner: r.Owner?.Name ?? null });
          left.push(row.case_number);
        } else if (r.IsClosed) {
          // The delta pull should have caught this closure already -- it
          // didn't, which means something else is wrong. Worth a log line.
          log.warn("sync.reconcile_missed_closure", { caseNumber: row.case_number });
          markLeftQueue.run({ id: row.id, left_queue_at: nowIso, left_reason: "closed_elsewhere", current_owner: null });
          left.push(row.case_number);
        }
        // else: still open, still mine -- a transient race between the two
        // reads (e.g. reopened between listOpenCases() and this requery).
        // Leave owned=1; the next cycle settles it either way.
      }
    })();

    if (left.length) {
      recordLeftQueueEvent(left, ts);
      log.info("sync.reconcile_ownership", { left: left.length, cases: left });
    }
    return { left: left.length, skipped: false };
  } catch (e) {
    log.warn("sync.reconcile_ownership_failed", { error: errText(e) });
    return { left: 0, skipped: true };
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
      // Nothing moved in Salesforce, but a deadline can arrive on its own --
      // and so can a transfer, which this delta query can never see (that's
      // exactly why reconciliation exists), so it must run on this path too.
      await runEvents(null, false);
      await reconcileOwnership();
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
        "SELECT case_number, needs_my_reply, status, is_escalated FROM cases WHERE id IN (" +
          caseIds.map(() => "?").join(",") +
          ")",
      )
      .all(...caseIds) as Array<{
      case_number: string;
      needs_my_reply: number;
      status: string | null;
      is_escalated: number;
    }>;
    const priorSeen = new Set(priorRows.map((r) => r.case_number));
    const priorNeedsReply = new Map(priorRows.map((r) => [r.case_number, !!r.needs_my_reply]));
    const priorStatus = new Map(priorRows.map((r) => [r.case_number, r.status]));
    // Phase 5, correction 1: case.escalated detection did not exist anywhere
    // -- is_escalated was read (current state) but never diffed against its
    // prior value. Same before/after-map pattern as needs_my_reply above.
    const priorEscalated = new Map(priorRows.map((r) => [r.case_number, !!r.is_escalated]));

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
    await reconcileOwnership();

    // Quality scoring runs here and not inside recomputeCase(): the Reliability
    // dimension reads commitment states, and those states are only correct
    // after reconciliation has moved what came due. Layer 1 is pure regex over
    // rows already in hand, so this costs no API call and no round trip.
    const graded = scoreCases(caseIds);

    const afterRows = db
      .prepare(
        "SELECT case_number, subject, priority, account, created_date, last_customer_touch," +
          " last_modified_date, is_closed, needs_my_reply, status, is_escalated FROM cases WHERE id IN (" +
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
      last_modified_date: string;
      is_closed: number;
      needs_my_reply: number;
      status: string | null;
      is_escalated: number;
    }>;

    const delta: SyncDelta = { created: [], replied: [], escalated: [], waitingOnSupport: [] };
    const statusTransitions: Array<{ caseNumber: string; newStatus: string | null }> = [];
    const triggers = new Set(triggerStatuses());
    for (const r of afterRows) {
      const d: DeltaCase = {
        caseNumber: r.case_number,
        subject: r.subject,
        priority: r.priority,
        account: r.account,
        createdDate: r.created_date,
        lastCustomerTouch: r.last_customer_touch,
        lastModifiedDate: r.last_modified_date,
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
        // Phase 5: case.waiting_on_support fires off the exact same
        // transition coverage.ts's sweepTransitions() consumes -- same
        // trigger-status list, so coverage and notifications cannot disagree
        // about which transitions matter.
        if (r.status && triggers.has(r.status)) {
          delta.waitingOnSupport.push({ ...d, newStatus: r.status });
        }
      }
      // Escalation, per correction 1: detection did not exist -- built here.
      if (priorSeen.has(r.case_number) && r.is_escalated && !priorEscalated.get(r.case_number)) {
        delta.escalated.push(d);
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
