import { config } from "./config";
import { countApiCalls } from "./db";
import { log, errText } from "./log";

/**
 * Salesforce REST client.
 *
 * Everything here is read-only: there is no POST or PATCH to any Salesforce
 * object anywhere in this codebase, by design.
 */

interface TokenState {
  accessToken: string;
  instanceUrl: string;
  expiresAt: number;
}

let token: TokenState | null = null;

async function refreshAccessToken(): Promise<TokenState> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.salesforce.clientId,
    client_secret: config.salesforce.clientSecret,
    refresh_token: config.salesforce.refreshToken,
  });

  const res = await fetch(`${config.salesforce.instanceUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce OAuth refresh failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { access_token: string; instance_url: string };
  const state: TokenState = {
    accessToken: json.access_token,
    instanceUrl: json.instance_url || config.salesforce.instanceUrl,
    expiresAt: Date.now() + 15 * 60 * 1000, // refresh proactively every 15 min
  };
  token = state;
  return state;
}

async function getToken(): Promise<TokenState> {
  if (token && token.expiresAt > Date.now()) return token;
  return refreshAccessToken();
}

async function sfFetch(path: string): Promise<any> {
  let t = await getToken();
  countApiCalls(1);
  let res = await fetch(`${t.instanceUrl}${path}`, {
    headers: { Authorization: `Bearer ${t.accessToken}` },
  });
  if (res.status === 401) {
    t = await refreshAccessToken();
    countApiCalls(1);
    res = await fetch(`${t.instanceUrl}${path}`, {
      headers: { Authorization: `Bearer ${t.accessToken}` },
    });
  }
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Salesforce API error: ${res.status} ${text}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function soqlQuery(soql: string): Promise<any> {
  const v = config.salesforce.apiVersion;
  return sfFetch(`/services/data/${v}/query?q=${encodeURIComponent(soql)}`);
}

/**
 * Run a SOQL query and follow `nextRecordsUrl` until every page is in hand.
 * Salesforce caps a page at 2,000 records; a full comment backfill will exceed
 * that on its own.
 */
async function soqlQueryAll<T>(soql: string, cap = 20000): Promise<T[]> {
  let data = await soqlQuery(soql);
  const out: T[] = (data.records || []) as T[];
  while (!data.done && data.nextRecordsUrl && out.length < cap) {
    data = await sfFetch(data.nextRecordsUrl);
    out.push(...((data.records || []) as T[]));
  }
  return out;
}

export interface SalesforceCase {
  Id: string;
  CaseNumber: string;
  Subject: string | null;
  Description: string | null;
  Status: string;
  Priority: string | null;
  Type: string | null;
  Origin: string | null;
  Problem_Type__c: string | null;
  Sub_Component__c: string | null;
  IsEscalated: boolean;
  IsClosed: boolean;
  CreatedDate: string;
  LastModifiedDate: string;
  ClosedDate: string | null;
  Owner: { Name: string; Title: string | null } | null;
  Account: { Name: string } | null;
  Contact_Name__c: string | null;
  Labels__c: string | null;
  NCC_date__c: string | null;
  Last_Customer_Update__c: string | null;
  Active_TTR__c: number | null;
  // v8: RSC support access (docs/PLAN_V8.md). Account_Polaris_URL__c is
  // primary -- populated on 15/15 of a real sample of open cases, vs. 2/15
  // for RSCInstance__r.RSCUrl__c, the opposite of what was guessed up front.
  Account_Polaris_URL__c: string | null;
  RSCInstance__r: { RSCUrl__c: string | null; Status__c: string | null } | null;
  US_Federal_Account__c: boolean;
  isFedRAMP__c: boolean;
  Federal_Account_Support_Access__c: string | null;
  // v8 part 2: CDM UI access (docs/PLAN_V8_CDM.md). tag__c, not Name -- Name's
  // field label is literally "Cluster UUID" and duplicates uuid__c.
  Cluster__r: {
    uuid__c: string | null;
    tag__c: string | null;
    software_version__c: string | null;
  } | null;
  Additional_Cluster__r: {
    uuid__c: string | null;
    tag__c: string | null;
    software_version__c: string | null;
  } | null;
  Platform__c: string | null;
  Software_Version__c: string | null;
}

const CASE_FIELDS = [
  "Id",
  "CaseNumber",
  "Subject",
  "Description",
  "Status",
  "Priority",
  "Type",
  "Origin",
  "Problem_Type__c",
  "Sub_Component__c",
  "IsEscalated",
  "IsClosed",
  "CreatedDate",
  "LastModifiedDate",
  "ClosedDate",
  "Owner.Name",
  "Owner.Title",
  "Account.Name",
  "Contact_Name__c",
  "Labels__c",
  "NCC_date__c",
  "Last_Customer_Update__c",
  "Active_TTR__c",
  "Account_Polaris_URL__c",
  "RSCInstance__r.RSCUrl__c",
  "RSCInstance__r.Status__c",
  "US_Federal_Account__c",
  "isFedRAMP__c",
  "Federal_Account_Support_Access__c",
  // v8 part 2: CDM UI access (docs/PLAN_V8_CDM.md). Support_Tunnel__c and
  // Cluster_ID_Read_Only__c are deliberately not synced -- both were checked
  // live and found dead/redundant (see the doc, section 6).
  "Cluster__r.uuid__c",
  "Cluster__r.tag__c",
  "Cluster__r.software_version__c",
  "Additional_Cluster__r.uuid__c",
  "Additional_Cluster__r.tag__c",
  "Additional_Cluster__r.software_version__c",
  "Platform__c",
  "Software_Version__c",
].join(", ");

export function escapeSoqlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

let resolvedOwnerId: string | null = null;

/** Set once at boot by resolveOwnerId(); every owner-scoped query reads
 * this, never config.salesforce.ownerName directly. */
export function ownerId(): string {
  if (!resolvedOwnerId) throw new Error("ownerId() called before resolveOwnerId() completed at boot");
  return resolvedOwnerId;
}

/**
 * Resolve the configured display name to exactly one active User.Id, once,
 * before the server accepts a request or the sync loop starts. Owner.Name is
 * not guaranteed unique in Salesforce -- two people sharing this name would
 * otherwise silently pull a colleague's cases into this queue, a failure
 * that looks identical to the transfer bug this whole project exists to
 * fix. ownerName in .env is unchanged; this only changes what gets queried
 * with it.
 *
 * SALESFORCE_OWNER_ID is the escape hatch for a name that genuinely
 * resolves to more than one active user -- confirmed to happen in this org
 * (a second real account, not a data-entry error). When set, it is used
 * directly, still verified against Salesforce so a typo fails loudly rather
 * than silently scoping to nothing or the wrong person.
 */
export async function resolveOwnerId(): Promise<string> {
  if (config.salesforce.ownerId) {
    const id = config.salesforce.ownerId;
    const soql = `SELECT Id FROM User WHERE Id = '${escapeSoqlString(id)}' AND IsActive = true`;
    const data = await soqlQuery(soql);
    const records = (data.records || []) as Array<{ Id: string }>;
    if (records.length !== 1) {
      throw new Error(`SALESFORCE_OWNER_ID "${id}" does not match exactly one active Salesforce user`);
    }
    resolvedOwnerId = records[0].Id;
    log.info("salesforce.owner_resolved", { ownerId: resolvedOwnerId, source: "SALESFORCE_OWNER_ID" });
    return resolvedOwnerId;
  }

  const name = config.salesforce.ownerName;
  if (!name) {
    throw new Error("SALESFORCE_OWNER_NAME must be set -- QView cannot safely scope any query without it");
  }
  const soql = `SELECT Id, Name FROM User WHERE Name = '${escapeSoqlString(name)}' AND IsActive = true`;
  const data = await soqlQuery(soql);
  const records = (data.records || []) as Array<{ Id: string; Name: string }>;
  if (records.length === 0) {
    throw new Error(`No active Salesforce user is named "${name}" -- check SALESFORCE_OWNER_NAME`);
  }
  if (records.length > 1) {
    throw new Error(
      `${records.length} active Salesforce users are named "${name}" (${records.map((r) => r.Id).join(", ")}) -- ` +
        "ownerName must resolve to exactly one user, or set SALESFORCE_OWNER_ID to disambiguate.",
    );
  }
  resolvedOwnerId = records[0].Id;
  log.info("salesforce.owner_resolved", { ownerId: resolvedOwnerId, ownerName: name });
  return resolvedOwnerId;
}

function ownerClause(joiner = " AND "): string {
  return resolvedOwnerId ? `OwnerId = '${escapeSoqlString(resolvedOwnerId)}'${joiner}` : "";
}

/** Quote a list of Ids for an IN clause. */
function idList(ids: string[]): string {
  return ids.map((id) => `'${escapeSoqlString(id)}'`).join(", ");
}

/** Chunk Ids so a single SOQL statement stays well inside the 100k char limit. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** v9 part 3: the shift console's watch poll needs "is anything about my
 * open cases different" every 15-60s, not the full ~30-field row
 * reconcileOwnership() needs. Same query shape, a smaller field list --
 * not a second query, per the spec's own instruction. */
export interface CaseWatchRow {
  Id: string;
  CaseNumber: string;
  Status: string | null;
  IsEscalated: boolean;
  LastModifiedDate: string;
}
const WATCH_FIELDS = ["Id", "CaseNumber", "Status", "IsEscalated", "LastModifiedDate"];

export async function listOpenCases(): Promise<SalesforceCase[]>;
export async function listOpenCases(light: true): Promise<CaseWatchRow[]>;
export async function listOpenCases(light?: boolean): Promise<SalesforceCase[] | CaseWatchRow[]> {
  // No LIMIT: a SOQL-level LIMIT makes Salesforce return done:true on page
  // one, which makes soqlQueryAll's own pagination unreachable -- silently
  // truncating the authoritative "what's open and mine" set is exactly the
  // failure mode reconciliation exists to avoid. soqlQueryAll's own 20,000
  // cap is the real ceiling now.
  const fields = light ? WATCH_FIELDS : CASE_FIELDS;
  const soql = `SELECT ${fields} FROM Case WHERE ${ownerClause()}IsClosed = false ORDER BY CreatedDate ASC`;
  return light ? soqlQueryAll<CaseWatchRow>(soql) : soqlQueryAll<SalesforceCase>(soql);
}

export interface CaseOwnershipRow {
  Id: string;
  CaseNumber: string;
  OwnerId: string;
  Owner: { Name: string } | null;
  Status: string;
  IsClosed: boolean;
}

/**
 * Reconciliation's "find out where it went": a targeted, unfiltered re-query
 * for exactly the Ids found locally-open-but-not-remotely-open. No owner
 * clause -- that's the point, since the case may no longer be mine. OwnerId
 * is the identity used to decide "is this still mine"; Owner.Name is kept
 * only for the human-readable current_owner display.
 */
export async function getOwnershipStatus(ids: string[]): Promise<CaseOwnershipRow[]> {
  if (!ids.length) return [];
  const out: CaseOwnershipRow[] = [];
  for (const group of chunk(ids, 150)) {
    const soql = `SELECT Id, CaseNumber, OwnerId, Owner.Name, Status, IsClosed FROM Case WHERE Id IN (${idList(group)})`;
    out.push(...(await soqlQueryAll<CaseOwnershipRow>(soql)));
  }
  return out;
}

/**
 * Delta pull: every owned case touched since the watermark, open or closed.
 * `since` is a Salesforce datetime literal (ISO 8601 with offset).
 */
export async function listCasesModifiedSince(since: string | null): Promise<SalesforceCase[]> {
  const filters: string[] = [];
  if (resolvedOwnerId) {
    filters.push(`OwnerId = '${escapeSoqlString(resolvedOwnerId)}'`);
  }
  if (since) {
    filters.push(`LastModifiedDate > ${since}`);
  } else {
    // First run: everything open, plus the closed window metrics need.
    const days = Number(process.env.QVIEW_CLOSED_WINDOW_DAYS || 120);
    const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
    filters.push(`(IsClosed = false OR ClosedDate >= ${cutoff})`);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")} ` : "";
  const soql = `SELECT ${CASE_FIELDS} FROM Case ${where}ORDER BY LastModifiedDate ASC`;
  return soqlQueryAll<SalesforceCase>(soql);
}

/** Owned cases closed inside the metrics window, for TTR and volume trends. */
export async function listClosedCasesSince(days: number): Promise<SalesforceCase[]> {
  const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const soql = `SELECT ${CASE_FIELDS} FROM Case WHERE ${ownerClause()}IsClosed = true AND ClosedDate >= ${cutoff} ORDER BY ClosedDate ASC`;
  return soqlQueryAll<SalesforceCase>(soql);
}

export interface StatusTransition {
  caseNumber: string;
  oldValue: string | null;
  newValue: string | null;
  createdDate: string;
}

/**
 * Real Status field history, for phase 7's 30-day coverage backtest.
 * Confirmed live before this was written: CaseHistory tracks Status on this
 * org (it is in the Field picklist) and real transition rows exist for this
 * owner's cases -- so the backtest reads what actually happened rather than
 * simulating from current state.
 */
export async function getRecentStatusHistory(days: number): Promise<StatusTransition[]> {
  const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
  const owner = resolvedOwnerId
    ? `Case.OwnerId = '${escapeSoqlString(resolvedOwnerId)}' AND `
    : "";
  const soql =
    `SELECT Case.CaseNumber, OldValue, NewValue, CreatedDate FROM CaseHistory ` +
    `WHERE ${owner}Field = 'Status' AND CreatedDate >= ${cutoff} ORDER BY CreatedDate ASC`;
  const rows = await soqlQueryAll<{
    Case: { CaseNumber: string } | null;
    OldValue: string | null;
    NewValue: string | null;
    CreatedDate: string;
  }>(soql);
  return rows
    .filter((r) => r.Case?.CaseNumber)
    .map((r) => ({
      caseNumber: r.Case!.CaseNumber,
      oldValue: r.OldValue,
      newValue: r.NewValue,
      createdDate: r.CreatedDate,
    }));
}

export async function getCaseByNumber(caseNumber: string): Promise<SalesforceCase | null> {
  const soql = `SELECT ${CASE_FIELDS} FROM Case WHERE CaseNumber = '${escapeSoqlString(caseNumber)}' LIMIT 1`;
  const data = await soqlQuery(soql);
  const records = data.records as SalesforceCase[];
  return records.length ? records[0] : null;
}

export async function searchCases(q: string): Promise<SalesforceCase[]> {
  const escaped = escapeSoqlString(q);
  const soql = `SELECT ${CASE_FIELDS} FROM Case WHERE CaseNumber LIKE '%${escaped}%' OR Subject LIKE '%${escaped}%' ORDER BY CreatedDate DESC LIMIT 25`;
  const data = await soqlQuery(soql);
  return data.records as SalesforceCase[];
}

/* ------------------------------------------------------------- case comments */

export interface SalesforceCaseComment {
  Id: string;
  ParentId: string;
  CommentBody: string | null;
  IsPublished: boolean;
  CreatedDate: string;
  LastModifiedDate: string;
  CreatedBy: { Name: string; Email: string | null } | null;
}

const COMMENT_FIELDS =
  "Id, ParentId, CommentBody, IsPublished, CreatedDate, LastModifiedDate, CreatedBy.Name, CreatedBy.Email";

/**
 * Comments for one case.
 *
 * Internal (unpublished) comments are included: the timeline needs the full
 * history to be a real substitute for opening Salesforce. They carry
 * `IsPublished` through so the UI can mark them internal, and the AI drafting
 * path continues to request public comments only.
 */
export async function getCaseComments(caseId: string): Promise<SalesforceCaseComment[]> {
  const soql = `SELECT ${COMMENT_FIELDS} FROM CaseComment WHERE ParentId = '${escapeSoqlString(
    caseId,
  )}' ORDER BY CreatedDate ASC`;
  return soqlQueryAll<SalesforceCaseComment>(soql);
}

/** Public comments only — the customer-facing draft path must never see internals. */
export async function getPublicCaseComments(caseId: string): Promise<SalesforceCaseComment[]> {
  const all = await getCaseComments(caseId);
  return all.filter((c) => c.IsPublished);
}

/** Comments for many cases in one round trip per chunk. */
export async function getCommentsForCases(
  caseIds: string[],
  since: string | null = null,
): Promise<SalesforceCaseComment[]> {
  const out: SalesforceCaseComment[] = [];
  for (const group of chunk(caseIds, 150)) {
    const sinceClause = since ? ` AND LastModifiedDate > ${since}` : "";
    const soql = `SELECT ${COMMENT_FIELDS} FROM CaseComment WHERE ParentId IN (${idList(
      group,
    )})${sinceClause} ORDER BY CreatedDate ASC`;
    out.push(...(await soqlQueryAll<SalesforceCaseComment>(soql)));
  }
  return out;
}

/* -------------------------------------------------------------- email messages */

export interface SalesforceEmail {
  Id: string;
  ParentId: string;
  Subject: string | null;
  TextBody: string | null;
  FromName: string | null;
  FromAddress: string | null;
  ToAddress: string | null;
  Incoming: boolean;
  MessageDate: string | null;
  CreatedDate: string;
  LastModifiedDate: string;
}

const EMAIL_FIELDS =
  "Id, ParentId, Subject, TextBody, FromName, FromAddress, ToAddress, Incoming, MessageDate, CreatedDate, LastModifiedDate";

/** Set once EmailMessage has been shown to be unreadable for this connection. */
let emailAccessDenied = false;

export function isEmailAccessDenied(): boolean {
  return emailAccessDenied;
}

/**
 * Emails on a set of cases.
 *
 * EmailMessage is not readable on every Salesforce configuration. If it is
 * denied, that is recorded once and an empty list is returned — the UI then
 * says emails are unavailable rather than implying there were none.
 */
export async function getEmailsForCases(
  caseIds: string[],
  since: string | null = null,
): Promise<SalesforceEmail[]> {
  if (emailAccessDenied || !caseIds.length) return [];

  const out: SalesforceEmail[] = [];
  for (const group of chunk(caseIds, 150)) {
    const sinceClause = since ? ` AND LastModifiedDate > ${since}` : "";
    const soql = `SELECT ${EMAIL_FIELDS} FROM EmailMessage WHERE ParentId IN (${idList(
      group,
    )})${sinceClause} ORDER BY MessageDate ASC`;
    try {
      out.push(...(await soqlQueryAll<SalesforceEmail>(soql)));
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 400 || status === 403) {
        emailAccessDenied = true;
        log.warn("salesforce.email_access_denied", {
          detail: "EmailMessage is not readable; timelines will show case comments only",
          error: errText(e),
        });
        return out;
      }
      throw e;
    }
  }
  return out;
}

/** A datetime literal SOQL accepts, from an epoch or ISO input. */
export function soqlDatetime(at: Date | number | string): string {
  const d = at instanceof Date ? at : new Date(at);
  return d.toISOString();
}
