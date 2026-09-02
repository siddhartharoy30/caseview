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
].join(", ");

export function escapeSoqlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function ownerClause(joiner = " AND "): string {
  return config.salesforce.ownerName
    ? `Owner.Name = '${escapeSoqlString(config.salesforce.ownerName)}'${joiner}`
    : "";
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

export async function listOpenCases(): Promise<SalesforceCase[]> {
  const soql = `SELECT ${CASE_FIELDS} FROM Case WHERE ${ownerClause()}IsClosed = false ORDER BY CreatedDate ASC LIMIT 500`;
  return soqlQueryAll<SalesforceCase>(soql);
}

/**
 * Delta pull: every owned case touched since the watermark, open or closed.
 * `since` is a Salesforce datetime literal (ISO 8601 with offset).
 */
export async function listCasesModifiedSince(since: string | null): Promise<SalesforceCase[]> {
  const filters: string[] = [];
  if (config.salesforce.ownerName) {
    filters.push(`Owner.Name = '${escapeSoqlString(config.salesforce.ownerName)}'`);
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
