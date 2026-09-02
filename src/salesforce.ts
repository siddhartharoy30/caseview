import { config } from "./config";

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
  let res = await fetch(`${t.instanceUrl}${path}`, {
    headers: { Authorization: `Bearer ${t.accessToken}` },
  });
  if (res.status === 401) {
    t = await refreshAccessToken();
    res = await fetch(`${t.instanceUrl}${path}`, {
      headers: { Authorization: `Bearer ${t.accessToken}` },
    });
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Salesforce API error: ${res.status} ${text}`);
  }
  return res.json();
}

function soqlQuery(soql: string): Promise<any> {
  const v = config.salesforce.apiVersion;
  return sfFetch(`/services/data/${v}/query?q=${encodeURIComponent(soql)}`);
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

function escapeSoqlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function listOpenCases(): Promise<SalesforceCase[]> {
  const ownerClause = config.salesforce.ownerName
    ? `Owner.Name = '${escapeSoqlString(config.salesforce.ownerName)}' AND `
    : "";
  const soql = `SELECT ${CASE_FIELDS} FROM Case WHERE ${ownerClause}IsClosed = false ORDER BY CreatedDate ASC LIMIT 200`;
  const data = await soqlQuery(soql);
  return data.records as SalesforceCase[];
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

export interface SalesforceCaseComment {
  Id: string;
  CommentBody: string | null;
  IsPublished: boolean;
  CreatedDate: string;
  CreatedBy: { Name: string } | null;
}

export async function getCaseComments(caseId: string): Promise<SalesforceCaseComment[]> {
  const soql = `SELECT Id, CommentBody, IsPublished, CreatedDate, CreatedBy.Name FROM CaseComment WHERE ParentId = '${escapeSoqlString(
    caseId
  )}' AND IsPublished = true ORDER BY CreatedDate ASC`;
  const data = await soqlQuery(soql);
  return data.records as SalesforceCaseComment[];
}
