/**
 * Spray-token generation -- the automatic (tier 1) path, tried before the
 * always-present manual fallback (src/cdmHelperServer.ts's manual-token
 * route). Lives in its own file, separate from cdmAccess.ts, precisely so
 * the never-log-the-token rule is localised to one small module.
 *
 * The token is generated, validated, and handed to copyToMacClipboard() in
 * one place (generateToken() below) and NEVER crosses into an HTTP response
 * -- callers get back only {ok, via, username} or an error, never the token
 * itself. This is stricter than the RSC flow (which does send its token to
 * the browser as JSON): there is no ambiguity to resolve here, since the
 * token never needs to leave this process at all.
 *
 * Live-tested against a real cluster (docs/PLAN_V8_CDM.md): `portal connect
 * --cluster-uuid <uuid> --ticket <case>` (run inside the same one-shot,
 * expect-driven bastion session as claimAccess) drops into a real shell on
 * the CDM node itself, logged in as an `rksupport`/`rksupport_basic`-style
 * user depending on the operator's own escalation level. From there,
 * `/opt/rubrik/src/scripts/dev/get_local_spray_token.py --username <name>`
 * is the real script (confirmed present and executable; `.sh` is a thin
 * wrapper around the same `.py`, so this calls the .py directly).
 *
 * What is NOT live-validated: a successful generation on a cluster where the
 * operator's account actually has permission. Every username candidate
 * tried live here (`support`, `rksupport`, `rksupport_basic`, `admin`)
 * failed identically with "Unable to get local spray token... confirm you
 * have the permission to request a token for that user" -- a real,
 * consistent permission gate, not a QView bug or a wrong-username guess.
 * The documented escalation path (`portal token --escalate`, seen in Phase
 * 0's recon) opens a real JIRA ticket / Slack post and is deliberately not
 * something this code triggers on its own -- that requires a human's
 * judgement about whether escalation is actually warranted. So: this
 * strategy is real and will work on a cluster/account combination with
 * adequate permission, but that combination wasn't available to test
 * against live. The manual fallback is not a placeholder for this reason --
 * it is, empirically, the common path today.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cdmConfig } from "./cdmHelperConfig";
import { copyToMacClipboard } from "./rscAccess";
import { log, errText } from "./log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CASE_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Tried in order. "support"/"support_basic" match the wiki's documented
// convention; "rksupport"/"rksupport_basic" match what this OS account
// actually logs in as on the node (docs/PLAN_V8_CDM.md).
const USERNAME_CANDIDATES = ["support", "support_basic", "rksupport", "rksupport_basic"];

export type TokenResult = { ok: true; via: string; username: string } | { ok: false; code: "no_permission" | "unknown"; message: string };

function tclQuote(s: string): string {
  return s.replace(/([\\"$\[\]])/g, "\\$1");
}

/**
 * Runs a one-shot `expect` script exactly like cdmAccess.ts's
 * runExpectScript, duplicated locally rather than shared so this file's
 * token-handling stays self-contained and easy to audit on its own.
 */
function runExpectScript(script: string, timeoutMs: number): Promise<{ output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const scriptPath = path.join(os.tmpdir(), `qview-cdm-tok-${Date.now()}-${Math.random().toString(36).slice(2)}.exp`);
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
      log.warn("cdm.token_expect_spawn_failed", { error: errText(err) });
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ output: buf, timedOut: false });
    });
  });
}

/**
 * Tries each username candidate against the cluster node, entirely within
 * one bastion session. Each candidate: generate to a node-local temp file,
 * validate via a same-node curl (so the token never appears in a command
 * line we send -- $(cat <path>) is expanded by the remote shell itself, not
 * by us), report only DONE/OK/FAIL markers, then delete the temp file
 * regardless of outcome. The first candidate that validates wins; its token
 * is captured from the *validation* step's own success, not re-read.
 *
 * This function itself never returns the token text -- see generateToken().
 */
async function tryGenerateAndPbcopy(clusterUuid: string, caseNumber: string): Promise<TokenResult> {
  const remoteTmp = "/tmp/.qview_spray_tok";
  const remoteTmpErr = "/tmp/.qview_spray_tok_err";
  const scriptLines = [
    `set timeout ${Math.ceil(cdmConfig.claimTimeoutMs / 1000)}`,
    "log_user 1",
    `spawn ${tclQuote(cdmConfig.portalClientPath)} connect`,
    `expect -re {\\$\\s*$}`,
    `send "portal connect --cluster-uuid ${tclQuote(clusterUuid)} --ticket ${tclQuote(caseNumber)}\\r"`,
    `expect {`,
    `  -re {\\[y/n\\]\\?\\s*} { send "y\\r"; exp_continue }`,
    `  timeout {}`,
    `  -re {\\$\\s*$} {}`,
    `}`,
    `sleep 2`,
  ];
  for (const user of USERNAME_CANDIDATES) {
    scriptLines.push(
      `send {python /opt/rubrik/src/scripts/dev/get_local_spray_token.py --username ${user} > ${remoteTmp} 2>${remoteTmpErr}}`,
      `send "; echo QVIEW_GEN_${user}:\\$?\\r"`,
      `expect "QVIEW_GEN_${user}:"`,
      `sleep 1`,
      // Validated on the node itself -- "localhost" here is the cluster's
      // own API, no need to route back through the Mac's tunnel.
      `send {curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat ${remoteTmp} 2>/dev/null)" https://localhost/api/v1/cluster/me}`,
      `send "; echo QVIEW_VALIDATE_${user}:\\r"`,
      `expect -re {QVIEW_VALIDATE_${user}:\\d*}`,
      `sleep 1`,
      // Printed only inside these markers -- the caller extracts the exact
      // slice between them and nothing else ever gets treated as token text.
      // A failed candidate's file is empty, so this prints nothing between
      // its own markers.
      `send {echo QVIEW_TOKEN_START_${user}; cat ${remoteTmp} 2>/dev/null; echo QVIEW_TOKEN_END_${user}}`,
      `send "\\r"`,
      `expect "QVIEW_TOKEN_END_${user}"`,
      `sleep 1`,
      `send {rm -f ${remoteTmp} ${remoteTmpErr}}`,
      `send "\\r"`,
      `sleep 1`,
    );
  }
  scriptLines.push(`send "exit\\r"`, `sleep 1`, `send "exit\\r"`, `expect eof`);

  const { output, timedOut } = await runExpectScript(scriptLines.join("\n"), cdmConfig.claimTimeoutMs * USERNAME_CANDIDATES.length + 15000);
  if (timedOut) {
    log.warn("cdm.token_timeout", {});
    return { ok: false, code: "unknown", message: "Token generation timed out." };
  }

  // Only ever pulls the exact slice between one candidate's own START/END
  // markers -- never the full transcript -- and drops it the instant it's
  // been handed to the clipboard. `buf`/`output` themselves are never
  // logged in full anywhere in this file.
  for (const user of USERNAME_CANDIDATES) {
    const validateMatch = new RegExp(`QVIEW_VALIDATE_${user}:(\\d{3})`).exec(output);
    if (!validateMatch || validateMatch[1] !== "200") continue;

    const startTag = `QVIEW_TOKEN_START_${user}`;
    const endTag = `QVIEW_TOKEN_END_${user}`;
    const startIdx = output.indexOf(startTag);
    const endIdx = output.indexOf(endTag);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) continue;
    const slice = output.slice(startIdx + startTag.length, endIdx);
    // Strip the echoed command line itself and ANSI/terminal control
    // sequences, keep only what looks like a token line.
    const token = slice
      .split(/\r?\n/)
      .map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim())
      .find((line) => /^[A-Za-z0-9._-]{15,}$/.test(line));
    if (!token) continue;

    const copied = await copyToMacClipboard(token);
    // `token` goes out of scope here; nothing else in this function holds
    // a reference to it.
    if (!copied.ok) {
      log.warn("cdm.token_pbcopy_failed", { username: user });
      return { ok: false, code: "unknown", message: "Token generated and validated, but could not be copied to the clipboard." };
    }
    log.info("cdm.token_ok", { via: "exec", username: user });
    return { ok: true, via: "exec", username: user };
  }
  log.warn("cdm.token_no_permission", {});
  return {
    ok: false,
    code: "no_permission",
    message:
      "Automatic token generation was denied for every username tried. This account may not have permission to request a spray token on this cluster -- use the manual command below, or escalate via `portal token --escalate` if that's warranted.",
  };
}

export async function generateToken(clusterUuid: string, caseNumber: string): Promise<TokenResult> {
  if (!UUID_RE.test(clusterUuid) || !CASE_RE.test(caseNumber)) {
    return { ok: false, code: "unknown", message: "Invalid cluster UUID or case number." };
  }
  return tryGenerateAndPbcopy(clusterUuid, caseNumber);
}
