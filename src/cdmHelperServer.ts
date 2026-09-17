/**
 * The CDM tunnel helper -- a standalone process, separate from both the main
 * QView server and the RSC helper (docs/PLAN_V8_CDM.md), that runs only on
 * the Mac. It is the only thing that shells `portal_client`, `expect`, or
 * Chrome for CDM access. Kept separate from com.qview.rsc-helper so a
 * `launchctl kickstart -k` after an RSC-side change can never drop a live
 * tunnel into a customer cluster.
 *
 * No SQLite, no Salesforce, no session/cookie auth -- same trust model as
 * the RSC helper: reachable only from localhost, correct Origin.
 */

import { execFile } from "child_process";
import express from "express";
import { cdmConfig } from "./cdmHelperConfig";
import {
  CdmSession,
  createSession,
  getSession,
  listSessions,
  reservedPorts,
  pruneOldSessions,
  toWire,
  writeMarker,
  readAllMarkers,
  removeMarkerFile,
  appendSessionLog,
  setStep,
} from "./cdmSession";
import { checkTunnelOpen, claimAccess, startForward, stopForward, MSG } from "./cdmAccess";
import { generateToken } from "./cdmToken";
import { allocatePort } from "./cdmPorts";
import { resolveUiFlavor, uiPathFor, UiFlavor } from "./cdmVersion";
import { launchIsolatedChrome, closeChromeAndCleanup, ChromeLaunch } from "./cdmChrome";
import { copyToMacClipboard } from "./rscAccess";
import { log, errText } from "./log";

const app = express();
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && cdmConfig.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, sessions: listSessions().filter((s) => s.state === "open").length });
});

app.get("/sessions", (_req, res) => {
  res.json({ sessions: listSessions().map(toWire) });
});

/* Chrome/session bookkeeping that lives alongside the in-memory session --
 * kept out of cdmSession.ts's plain data shape since it's process handles,
 * not wire-serialisable state. */
const chromeHandles = new Map<string, ChromeLaunch>();

async function runSessionLifecycle(
  s: CdmSession,
  opts: { clusterVersion: string | null; caseVersionRaw: string | null },
): Promise<void> {
  s.state = "claiming";
  setStep(s, "Checking whether the cluster has an active support tunnel…");
  const ready = await checkTunnelOpen(s.clusterUuid);
  if (!ready) {
    s.state = "error";
    s.error = { code: "no_tunnel", message: MSG.no_tunnel };
    setStep(s, null);
    return;
  }

  setStep(s, "Claiming access for this case…");
  const claimed = await claimAccess(s.clusterUuid, s.caseNumber);
  if (!claimed.ok) {
    s.state = "error";
    s.error = { code: claimed.code, message: claimed.message };
    setStep(s, null);
    return;
  }

  setStep(s, "Allocating a local port…");
  const port = await allocatePort(reservedPorts());
  if (port == null) {
    s.state = "error";
    s.error = { code: "no_free_port", message: MSG.no_free_port };
    setStep(s, null);
    return;
  }
  s.localPort = port;
  s.state = "connecting";
  setStep(s, `Starting the tunnel on port ${port}…`);

  const forwarded = await startForward(s);
  if (!forwarded.ok) {
    s.state = "error";
    s.error = { code: forwarded.code, message: forwarded.message };
    s.localPort = null;
    setStep(s, null);
    return;
  }

  s.child = forwarded.child;
  writeMarker(s, forwarded.pid);

  const { flavor, version } = resolveUiFlavor(opts.clusterVersion, opts.caseVersionRaw);
  s.clusterVersion = version;
  s.uiFlavor = flavor;
  s.uiUrl = flavor ? `https://127.0.0.1:${s.localPort}${uiPathFor(flavor)}` : null;
  s.state = "open";
  setStep(s, null);
  appendSessionLog("open", s);
  log.info("cdm.session_open", { hasCaseNumber: true, hasClusterUuid: true, flavorKnown: !!flavor });
}

app.post("/sessions", (req, res) => {
  const caseNumber = typeof req.body?.caseNumber === "string" ? req.body.caseNumber : "";
  const clusterUuid = typeof req.body?.clusterUuid === "string" ? req.body.clusterUuid : "";
  const clusterTag = typeof req.body?.clusterTag === "string" ? req.body.clusterTag : null;
  const clusterVersion = typeof req.body?.clusterVersion === "string" ? req.body.clusterVersion : null;
  const caseVersionRaw = typeof req.body?.caseVersionRaw === "string" ? req.body.caseVersionRaw : null;
  if (!caseNumber || !clusterUuid) {
    res.status(400).json({ error: "unknown", message: "caseNumber and clusterUuid are required." });
    return;
  }
  const s = createSession(caseNumber, clusterUuid, clusterTag, clusterVersion);
  res.json({ session: toWire(s) });
  // Fire-and-forget: the frontend polls GET /sessions/:id for state.
  runSessionLifecycle(s, { clusterVersion, caseVersionRaw }).catch((err) => {
    s.state = "error";
    s.error = { code: "unknown", message: MSG.unknown };
    log.error("cdm.session_lifecycle_crashed", { error: errText(err) });
  });
});

app.get("/sessions/:id", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) {
    res.status(404).json({ error: "unknown", message: "No such session." });
    return;
  }
  res.json({ session: toWire(s) });
});

app.post("/sessions/:id/stop", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) {
    res.status(404).json({ error: "unknown", message: "No such session." });
    return;
  }
  s.state = "stopping";
  await stopForward(s);
  const chrome = chromeHandles.get(s.id);
  if (chrome && req.body?.closeChrome !== false) {
    await closeChromeAndCleanup(chrome.child, chrome.profileDir);
    chromeHandles.delete(s.id);
  }
  s.state = "stopped";
  s.stoppedAt = Date.now();
  s.chromePid = null;
  s.lastToken = null;
  appendSessionLog("stop", s);
  pruneOldSessions();
  res.json({ session: toWire(s) });
});

app.post("/sessions/:id/open-ui", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s || s.state !== "open" || s.localPort == null) {
    res.status(409).json({ error: "unknown", message: "Session is not open." });
    return;
  }
  const flavorOverride = req.body?.flavor as UiFlavor | undefined;
  const flavor = flavorOverride === "crystal" || flavorOverride === "luna" ? flavorOverride : s.uiFlavor;
  if (!flavor) {
    res.status(400).json({ error: "unknown", message: "No UI flavor known -- pick Crystal or Luna." });
    return;
  }
  const url = `https://127.0.0.1:${s.localPort}${uiPathFor(flavor)}`;
  const existing = chromeHandles.get(s.id);
  if (existing) {
    await closeChromeAndCleanup(existing.child, existing.profileDir);
    chromeHandles.delete(s.id);
  }
  const launched = await launchIsolatedChrome(url, s.id);
  if (!("child" in launched)) {
    res.status(502).json(launched);
    return;
  }
  chromeHandles.set(s.id, launched);
  s.chromePid = launched.child.pid ?? null;
  s.uiUrl = url;
  res.json({ session: toWire(s) });
});

/**
 * Tier 1: automatic generation (src/cdmToken.ts) -- picks the one correct
 * --username for the detected OS account and pbcopy's it on success, never
 * returning the token itself. Fire-and-forget, same shape as session
 * startup: returns immediately, and the caller polls GET /sessions/:id to
 * watch `currentStep` update live and see the final outcome in
 * `tokenStatus`/`tokenGenError` -- a real generation round-trips through a
 * bastion session and can take 20-40s, too long to hold one request open
 * with no visibility into what's happening in the meantime.
 */
const tokenGenInFlight = new Set<string>();

app.post("/sessions/:id/generate-token", (req, res) => {
  const s = getSession(req.params.id);
  if (!s || s.state !== "open") {
    res.status(409).json({ error: "unknown", message: "Session is not open." });
    return;
  }
  if (tokenGenInFlight.has(s.id)) {
    res.status(409).json({ error: "unknown", message: "A generation attempt is already running for this session." });
    return;
  }
  tokenGenInFlight.add(s.id);
  s.tokenGenError = null;
  res.json({ started: true, session: toWire(s) });
  generateToken(s.clusterUuid, s.caseNumber, (step) => setStep(s, step))
    .then((result) => {
      if (result.ok) {
        s.tokenStatus = "auto";
        // Held only for the panel's explicit "Show token" action (the
        // dedicated reveal route below) -- toWire() never serialises this,
        // so it never appears in the routine GET /sessions polling.
        s.lastToken = result.token;
      } else {
        s.tokenGenError = result.message;
      }
    })
    .catch((err) => {
      s.tokenGenError = "The CDM helper hit an unexpected error generating the token.";
      log.error("cdm.token_generate_crashed", { error: errText(err) });
    })
    .finally(() => {
      tokenGenInFlight.delete(s.id);
      setStep(s, null);
    });
});

/**
 * Explicit reveal, for the panel's "Show token" box -- deliberately not
 * part of the routine GET /sessions/:id polling response, so the token
 * only ever reaches the browser when the operator asks for it directly.
 * Manually-pasted tokens (tier 3) aren't stored here at all: the browser
 * already has whatever the operator typed in, so there's nothing to reveal.
 */
app.get("/sessions/:id/reveal-token", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) {
    res.status(404).json({ error: "unknown", message: "No such session." });
    return;
  }
  res.json({ token: s.lastToken || null });
});

/** Tier 3: manual-token paste, always available regardless of Phase 5's
 * automation. pbcopy's it and marks the session so the panel reflects it. */
app.post("/sessions/:id/manual-token", async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) {
    res.status(404).json({ error: "unknown", message: "No such session." });
    return;
  }
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (!token) {
    res.status(400).json({ error: "unknown", message: "No token provided." });
    return;
  }
  const result = await copyToMacClipboard(token);
  if (result.ok) s.tokenStatus = "manual";
  res.status(result.ok ? 200 : 500).json({ ok: result.ok, session: toWire(s) });
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

/* ------------------------------------------------------- shutdown + sweep */

async function stopAllSessions(reason: string): Promise<void> {
  const live = listSessions().filter((s) => s.state === "open" || s.state === "connecting" || s.state === "claiming");
  log.info("cdm_helper.stopping_sessions", { reason, count: live.length });
  await Promise.all(
    live.map(async (s) => {
      await stopForward(s);
      const chrome = chromeHandles.get(s.id);
      if (chrome) {
        await closeChromeAndCleanup(chrome.child, chrome.profileDir);
        chromeHandles.delete(s.id);
      }
      s.state = "stopped";
      s.stoppedAt = Date.now();
      s.lastToken = null;
      appendSessionLog("stop", s);
    }),
  );
}

/**
 * Boot-time orphan sweep. `KeepAlive: true` in the plist means launchd
 * restarts this process after any crash, which would otherwise orphan every
 * live `portal_client forward` child. Never kills a bare recorded pid --
 * pids get recycled -- only after confirming via `ps -p <pid> -o comm=` that
 * the process at that pid is still actually `portal_client`.
 */
function sweepOrphans(): void {
  const markers = readAllMarkers();
  if (markers.length === 0) return;
  for (const m of markers) {
    execFile("ps", ["-p", String(m.pid), "-o", "comm="], (err, stdout) => {
      const comm = (stdout || "").trim();
      if (!err && comm.endsWith("portal_client")) {
        try {
          process.kill(-m.pid, "SIGTERM");
          log.warn("cdm_helper.orphan_killed", { pid: m.pid, port: m.port });
        } catch {
          // already gone
        }
      }
      removeMarkerFile(m.file);
    });
  }
}

sweepOrphans();

const server = app.listen(cdmConfig.port, "127.0.0.1", () => {
  log.info("cdm_helper.listening", { port: cdmConfig.port });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("cdm_helper.shutdown", { signal });
  server.close();
  await stopAllSessions(signal);
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    void shutdown(sig);
  });
}
// Last resort -- an exit handler can only act synchronously, so this can't
// wait on the async stop above; the boot sweep is the real safety net for a
// SIGKILL that skips this entirely.
process.on("exit", () => {
  for (const s of listSessions()) {
    if (s.child?.pid) {
      try {
        process.kill(-s.child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});
