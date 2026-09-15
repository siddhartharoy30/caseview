/**
 * The RSC support-access helper -- a standalone process, separate from the
 * main QView server, that runs only on the Mac (see docs/PLAN_V8.md's Phase
 * 0). It is the only thing that shells `gcloud` or talks to pacman.
 *
 * No SQLite, no Salesforce, no session/cookie auth: it trusts "reachable only
 * from localhost, correct Origin" as its access boundary, which is
 * appropriate for a single-operator local tool -- pacman itself remains the
 * real authorization check (Okta group membership + VPN) regardless of who
 * calls this process.
 */

import express from "express";
import { rscConfig } from "./rscHelperConfig";
import { generateSupportAccess, copyToMacClipboard } from "./rscAccess";
import { log, errText } from "./log";

const app = express();
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && rscConfig.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Chrome's Private Network Access can gate a private/public-IP page (the
  // VM is itself an RFC1918 address) reaching localhost. This is the
  // documented opt-in on the preflight -- verify live in a real browser
  // (docs/PLAN_V8.md), don't just trust that sending the header is enough.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/generate", async (req, res) => {
  const caseNumber = typeof req.body?.caseNumber === "string" ? req.body.caseNumber : "";
  const account = typeof req.body?.account === "string" ? req.body.account.trim() : "";
  if (!account) {
    res.status(400).json({ error: "unknown", message: "No account provided." });
    return;
  }
  try {
    const result = await generateSupportAccess(account);
    if (!result.ok) {
      const status =
        result.code === "cooldown" ? 429 : result.code === "vpn" ? 403 : result.code === "permission" ? 401 : 502;
      res.status(status).json({ error: result.code, message: result.message, remainingSeconds: result.remainingSeconds });
      return;
    }
    // caseNumber is accepted only so the browser's separate audit call (to
    // the main app, not here) can pair this generation with the case that
    // triggered it -- it is never persisted by this process.
    log.info("rsc.generate_ok", { hasCaseNumber: !!caseNumber, grantCount: result.grants.length });
    res.json({ grants: result.grants });
  } catch (err) {
    log.error("rsc.generate_crashed", { error: errText(err) });
    res.status(500).json({ error: "unknown", message: "The RSC helper hit an unexpected error." });
  }
});

app.post("/pbcopy", async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  if (!text) {
    res.status(400).json({ ok: false, error: "No text provided." });
    return;
  }
  const result = await copyToMacClipboard(text);
  res.status(result.ok ? 200 : 500).json(result);
});

// Loopback-only: this process holds no auth of its own, so it must never be
// reachable from the LAN.
app.listen(rscConfig.port, "127.0.0.1", () => {
  log.info("rsc_helper.listening", { port: rscConfig.port });
});
