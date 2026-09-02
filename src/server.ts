import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { config } from "./config";
import { COOKIE_NAME, makeSessionToken, requireAuth, verifySessionToken } from "./auth";
import { requestOtp, verifyOtp } from "./otp";
import { listOpenCases, getCaseByNumber, searchCases } from "./salesforce";
import { computeSla, deriveQueue, deriveNextAction } from "./sla";
import { getLatestSuggestedReply, saveSuggestedReply } from "./db";
import { draftSuggestedReply } from "./claude";

const app = express();
app.use(express.json());
app.use(cookieParser());

const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 12 * 60 * 60 * 1000,
};

app.post("/api/auth/request-otp", async (req, res) => {
  const email = String(req.body?.email || "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    await requestOtp(email);
  } catch (err: any) {
    return res.status(429).json({ error: err.message || "please wait before requesting another code" });
  }
  res.json({ ok: true });
});

app.post("/api/auth/verify-otp", (req, res) => {
  const email = String(req.body?.email || "").trim();
  const code = String(req.body?.code || "").trim();
  if (!email || !code || !verifyOtp(email, code)) {
    return res.status(401).json({ error: "invalid or expired code" });
  }
  const token = makeSessionToken(email);
  res.cookie(COOKIE_NAME, token, SESSION_COOKIE_OPTS);
  res.json({ ok: true, email });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const email = verifySessionToken(req.cookies?.[COOKIE_NAME]);
  res.json({ authenticated: !!email, email: email || null });
});

app.get("/api/cases", requireAuth, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const cases = await listOpenCases();
    const enriched = cases.map((c) => {
      const sla = computeSla(c);
      return {
        id: c.Id,
        caseNumber: c.CaseNumber,
        subject: c.Subject,
        status: c.Status,
        priority: c.Priority,
        type: c.Type,
        origin: c.Origin,
        component: c.Problem_Type__c,
        subComponent: c.Sub_Component__c,
        account: c.Account?.Name || null,
        owner: c.Owner?.Name || null,
        isEscalated: c.IsEscalated,
        createdDate: c.CreatedDate,
        lastModifiedDate: c.LastModifiedDate,
        contactName: c.Contact_Name__c || null,
        labels: c.Labels__c || null,
        ncc: c.NCC_date__c || null,
        lastCustomerUpdate: c.Last_Customer_Update__c || null,
        activeTtrDays: c.Active_TTR__c ?? null,
        queue: deriveQueue(c),
        sla,
        nextAction: deriveNextAction(c),
      };
    });
    res.json({ cases: enriched });
  } catch (err: any) {
    res.status(502).json({ error: err.message || "salesforce error" });
  }
});

app.get("/api/cases/search", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ cases: [] });
  try {
    const cases = await searchCases(q);
    res.json({
      cases: cases.map((c) => ({
        id: c.Id,
        caseNumber: c.CaseNumber,
        subject: c.Subject,
        status: c.Status,
        priority: c.Priority,
        account: c.Account?.Name || null,
      })),
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message || "salesforce error" });
  }
});

app.post("/api/intelligence/suggest-reply", requireAuth, async (req, res) => {
  const caseNumber = String(req.body?.case_number || "").trim();
  const regenerate = !!req.body?.regenerate;
  if (!caseNumber) return res.status(400).json({ error: "case_number is required" });

  if (!regenerate) {
    const cached = getLatestSuggestedReply(caseNumber);
    if (cached) {
      return res.json({
        draft: cached.draft,
        keyword: cached.keyword,
        internalNote: cached.internal_note,
        selfCheck: cached.self_check,
        cached: true,
        created_at: cached.created_at,
      });
    }
  }

  try {
    const c = await getCaseByNumber(caseNumber);
    if (!c) return res.status(404).json({ error: "case not found" });
    const result = await draftSuggestedReply(c);
    const saved = saveSuggestedReply(
      caseNumber,
      result.customerText,
      result.keyword,
      result.internalNote,
      result.selfCheck
    );
    res.json({
      draft: saved.draft,
      keyword: saved.keyword,
      internalNote: saved.internal_note,
      selfCheck: saved.self_check,
      cached: false,
      created_at: saved.created_at,
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message || "failed to generate draft" });
  }
});

app.get("/api/app-versions", (_req, res) => {
  res.json({ app: "qview", version: "1.0.0" });
});

app.use(express.static(path.join(__dirname, "..", "public"), { index: "dashboard.html" }));

app.listen(config.port, () => {
  console.log("QView listening on port " + config.port);
});
