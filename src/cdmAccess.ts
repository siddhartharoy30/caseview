/**
 * CDM tunnel access -- readiness check, claim, and the long-lived forward
 * session. Lives in the CDM helper process only (src/cdmHelperServer.ts);
 * the main QView app never shells out to portal_client.
 *
 * The spray token (generated separately, src/cdmToken.ts, Phase 5) must
 * never be logged. This file doesn't touch the token at all, but the same
 * discipline applies to anything portal_client prints: `claim`'s and
 * `list`'s output is read into a bounded, closure-local buffer, matched
 * against a fixed set of patterns, and discarded -- never logged raw, never
 * returned to an endpoint. Error messages always come from the MSG lookup
 * table below, never from a substring of child output. Check any new log
 * call in this file against that before adding it (docs/PLAN_V8_CDM.md
 * security requirement 1).
 */

import { spawn, ChildProcess } from "child_process";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cdmConfig } from "./cdmHelperConfig";
import { CdmErrorCode, CdmSession, removeMarker } from "./cdmSession";
import { log, errText } from "./log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Salesforce case numbers are numeric; Jira-style tickets (CDM/SPARK/INFRA/
// ALERT, per the local forward prompt's own text) are alphanumeric-plus-dash.
// Either way: never let anything but this shape reach an interpolated shell
// string.
const CASE_RE = /^[A-Za-z0-9_-]{1,40}$/;

export const MSG: Record<CdmErrorCode, string> = {
  portal_missing: `portal_client not found. Set PORTAL_CLIENT_PATH in the CDM helper's environment.`,
  not_authenticated: "Your portal certificate has expired or is missing. Run `portal_client login` in a terminal, then try again.",
  no_free_port: `No free port in the CDM pool (${cdmConfig.portMin}-${cdmConfig.portMax}). Stop an unused session and retry.`,
  port_taken: "That port was taken by another process between allocation and bind. Retrying will pick a different one.",
  no_tunnel: "This cluster has no active support-tunnel connection to Rubrik right now. Ask the customer to confirm Support Tunnel is enabled, or try again later.",
  claim_failed: "Could not claim access to this cluster for this case. Check the case number and cluster UUID.",
  tunnel_failed: "The tunnel failed to start. Check that the cluster is still reachable and try again.",
  tunnel_timeout: "The tunnel did not come up in time. It may have dropped -- try again.",
  chrome_missing: `Chrome not found. Set CHROME_BIN_PATH in the CDM helper's environment.`,
  unknown: "The CDM helper hit an unexpected error.",
};

function assertValid(clusterUuid: string, caseNumber: string): { ok: true } | { ok: false; code: CdmErrorCode; message: string } {
  if (!UUID_RE.test(clusterUuid) || !CASE_RE.test(caseNumber)) {
    return { ok: false, code: "unknown", message: "Invalid cluster UUID or case number." };
  }
  return { ok: true };
}

/* --------------------------------------------------- the one-shot expect step */

/**
 * Runs a short `expect` script (a pre-installed macOS/BSD system binary, not
 * a new dependency -- docs/PLAN_V8_CDM.md section 3.4) and returns its
 * combined output for local pattern-matching. Bounded and discarded by the
 * caller; never logged raw. Used only for the one-shot bastion interactions
 * (readiness check, claim) -- the long-lived forward tunnel never goes
 * through this path (see startForward below).
 */
function runExpectScript(script: string, timeoutMs: number): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const scriptPath = path.join(os.tmpdir(), `qview-cdm-${Date.now()}-${Math.random().toString(36).slice(2)}.exp`);
    fs.writeFileSync(scriptPath, script, { mode: 0o600 });
    let buf = "";
    const MAX_BUF = 16384;
    let settled = false;
    const child = spawn(cdmConfig.expectPath, ["-f", scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      cleanup();
      resolve({ output: buf, timedOut: true });
    }, timeoutMs);
    const onChunk = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    function cleanup() {
      try {
        fs.rmSync(scriptPath, { force: true });
      } catch {
        // best-effort
      }
    }
    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ output: buf, timedOut: false });
    });
    child.on("error", (err) => {
      // ENOENT on portal_client itself surfaces here since expect's spawn
      // failure gets echoed to its own stderr, not this event -- this branch
      // is really "expect itself failed to launch."
      log.warn("cdm.expect_spawn_failed", { error: errText(err) });
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ output: buf, timedOut: false });
    });
  });
}

function tclQuote(s: string): string {
  // Inputs are pre-validated against UUID_RE/CASE_RE above, so this is
  // defence in depth, not the only guard: escape Tcl's special characters.
  return s.replace(/([\\"$\[\]])/g, "\\$1");
}

/* ------------------------------------------------------------- readiness */

/**
 * `portal list --cluster-uuid <uuid>` is read-only and side-effect-free.
 * "No tunnels found" means the customer's cluster has no active reverse
 * connection into Rubrik's Teleport infra right now -- an external fact
 * neither QView nor the operator can change (docs/PLAN_V8_CDM.md section
 * 3.2). Anything else printed after the command means a live row.
 */
export async function checkTunnelOpen(clusterUuid: string): Promise<boolean> {
  const script = `
set timeout ${Math.ceil(cdmConfig.claimTimeoutMs / 1000)}
log_user 1
spawn ${tclQuote(cdmConfig.portalClientPath)} connect
expect -re {\\$\\s*$}
send "portal list --cluster-uuid ${tclQuote(clusterUuid)}; echo CDM_LIST_DONE\\r"
expect "CDM_LIST_DONE"
send "exit\\r"
expect eof
`;
  const { output, timedOut } = await runExpectScript(script, cdmConfig.claimTimeoutMs + 5000);
  if (timedOut) return false;
  // Look only at the slice between our own command and the DONE marker so a
  // stray "no tunnels" elsewhere in the banner can't produce a false read.
  const marker = output.indexOf("CDM_LIST_DONE");
  const relevant = marker >= 0 ? output.slice(0, marker) : output;
  const tail = relevant.split(/\r?\n/).slice(-6).join("\n");
  return !/no tunnels found/i.test(tail) && new RegExp(clusterUuid, "i").test(tail);
}

/* ------------------------------------------------------------------ claim */

export async function claimAccess(
  clusterUuid: string,
  caseNumber: string,
): Promise<{ ok: true } | { ok: false; code: CdmErrorCode; message: string }> {
  const valid = assertValid(clusterUuid, caseNumber);
  if (!valid.ok) return valid;

  const script = `
set timeout ${Math.ceil(cdmConfig.claimTimeoutMs / 1000)}
log_user 1
spawn ${tclQuote(cdmConfig.portalClientPath)} connect
expect -re {\\$\\s*$}
send "portal claim --cluster-uuid ${tclQuote(clusterUuid)} --ticket ${tclQuote(caseNumber)} --duration ${cdmConfig.claimDurationDays}\\r"
expect {
  -re {\\[y/n\\]\\?\\s*} { send "y\\r"; exp_continue }
  -re {\\$\\s*$} { }
  timeout { }
}
send "echo CDM_CLAIM_DONE\\r"
expect "CDM_CLAIM_DONE"
send "exit\\r"
expect eof
`;
  const { output, timedOut } = await runExpectScript(script, cdmConfig.claimTimeoutMs + 5000);
  if (timedOut) {
    log.warn("cdm.claim_timeout", { hasClusterUuid: true, hasCaseNumber: true });
    return { ok: false, code: "claim_failed", message: MSG.claim_failed };
  }
  const marker = output.indexOf("CDM_CLAIM_DONE");
  const relevant = marker >= 0 ? output.slice(0, marker) : output;
  if (/not authenticated|certificate has expired|permission denied \(publickey\)/i.test(relevant)) {
    log.warn("cdm.claim_auth_failed", {});
    return { ok: false, code: "not_authenticated", message: MSG.not_authenticated };
  }
  if (/already has ownership/i.test(relevant)) {
    log.info("cdm.claim_ok", { hasClusterUuid: true, hasCaseNumber: true });
    return { ok: true };
  }
  // Anything else is treated as a failure -- deliberately conservative rather
  // than guessing success from silence.
  log.warn("cdm.claim_unclear", {});
  return { ok: false, code: "claim_failed", message: MSG.claim_failed };
}

/* ---------------------------------------------------------------- forward */

function isTcpUp(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: timeoutMs });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port: number, deadline: number): Promise<boolean> {
  while (Date.now() < deadline) {
    if (await isTcpUp(port, 800)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export interface ForwardResult {
  ok: true;
  child: ChildProcess;
  pid: number;
}
export type ForwardOutcome = ForwardResult | { ok: false; code: CdmErrorCode; message: string };

/**
 * The long-lived tunnel process. No PTY needed -- confirmed live
 * (docs/PLAN_V8_CDM.md section 3.4): local `portal_client forward`'s ticket
 * prompt is a plain readline-style prompt on stdout/stdin, satisfied by
 * piped stdio. `stdio` is `["pipe","pipe","pipe"]`, never `"inherit"` --
 * inherit would route the transcript to the LaunchAgent's StandardOutPath, a
 * file on disk, which the never-log rule forbids.
 */
export function startForward(session: CdmSession): Promise<ForwardOutcome> {
  return new Promise((resolve) => {
    const valid = assertValid(session.clusterUuid, session.caseNumber);
    if (!valid.ok) {
      resolve(valid);
      return;
    }
    if (session.localPort == null) {
      resolve({ ok: false, code: "no_free_port", message: MSG.no_free_port });
      return;
    }
    const args = [
      "forward",
      "--cluster-uuid",
      session.clusterUuid,
      "--local-port",
      String(session.localPort),
      "--node-port",
      "443",
    ];
    let child: ChildProcess;
    try {
      child = spawn(cdmConfig.portalClientPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb" },
        detached: true, // own process group: portal_client may fork further; a group signal reaps the tree
      });
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        resolve({ ok: false, code: "portal_missing", message: MSG.portal_missing });
        return;
      }
      log.warn("cdm.forward_spawn_failed", { error: errText(err) });
      resolve({ ok: false, code: "unknown", message: MSG.unknown });
      return;
    }

    let buf = "";
    const MAX_BUF = 8192;
    let ticketSent = false;
    let settled = false;

    const trySendTicket = () => {
      if (ticketSent) return;
      ticketSent = true;
      child.stdin?.write(session.caseNumber + "\n");
    };
    // Write immediately -- the pipe buffers it, and portal_client reads it
    // when it reaches the prompt. This is the robust path; the prompt-text
    // match below is a safety net in case a second prompt ever appears.
    trySendTicket();

    const onChunk = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (buf.length > MAX_BUF) buf = buf.slice(-MAX_BUF);
      if (!ticketSent && /ticket/i.test(buf)) trySendTicket();
      if (/unknown flag|invalid input/i.test(buf) && !settled) {
        settled = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        resolve({ ok: false, code: "tunnel_failed", message: MSG.tunnel_failed });
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        resolve({ ok: false, code: "portal_missing", message: MSG.portal_missing });
      } else {
        log.warn("cdm.forward_runtime_error", { error: errText(err) });
        resolve({ ok: false, code: "unknown", message: MSG.unknown });
      }
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      log.warn("cdm.forward_exited_early", { code });
      resolve({ ok: false, code: "tunnel_failed", message: MSG.tunnel_failed });
    });

    // Authoritative readiness signal: a real TCP connect, not the success
    // line -- independent of exact output text we haven't exhaustively
    // verified across portal_client versions.
    const deadline = Date.now() + cdmConfig.tunnelTimeoutMs;
    waitForPort(session.localPort, deadline).then((up) => {
      if (settled) return;
      settled = true;
      if (up && child.pid) {
        resolve({ ok: true, child, pid: child.pid });
      } else {
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch {
          // already gone
        }
        resolve({ ok: false, code: "tunnel_timeout", message: MSG.tunnel_timeout });
      }
    });
  });
}

/* ------------------------------------------------------------------ stop */

export async function stopForward(session: CdmSession): Promise<void> {
  const child = session.child;
  if (!child || !child.pid) return;
  try {
    child.stdin?.end();
  } catch {
    // already closed
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), cdmConfig.killGraceMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  removeMarker(session.id);
}
