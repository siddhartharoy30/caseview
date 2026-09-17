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
 * The first live pass tried four guessed usernames (`support`, `support_basic`,
 * `rksupport`, `rksupport_basic`) and all were denied -- not because of a
 * permission gate, but because none of them were the actual right string.
 * The real rule (confirmed against the operator's own usage): the target
 * username depends on the OS account `portal connect` drops you into --
 * if that account's name contains "basic" (e.g. `rksupport_basic`), the
 * target is the literal string `support_basic$` (yes, with a trailing `$`);
 * otherwise (e.g. plain `rksupport`), the target is `admin`. There is no
 * list to try -- exactly one of these two is correct for a given node, and
 * this file detects which by parsing the OS username out of the node's own
 * shell prompt after `portal connect` succeeds.
 *
 * The documented escalation path (`portal token --escalate`, seen in Phase
 * 0's recon) opens a real JIRA ticket / Slack post and is deliberately not
 * something this code triggers on its own -- that requires a human's
 * judgement about whether escalation is actually warranted. If the correct
 * candidate above is still denied, that's a genuine permission gate and the
 * manual fallback is the honest next step, not a bug in this file.
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

// The two possible targets -- never a list to iterate, exactly one is
// correct for a given node, selected by which OS account portal connect
// drops us into (see the module header). `support_basic$`'s trailing `$`
// is literal: harmless to bash (a `$` followed by a space/EOL is not an
// expansion) and never Tcl-interpreted since it only ever appears inside a
// Tcl variable's stored value, not typed directly into a Tcl string.
const BASIC_TARGET_USER = "support_basic$";
const DEFAULT_TARGET_USER = "admin";

/**
 * Connects to the node, detects which OS account we landed as, picks the
 * one correct --username target for it, generates to a node-local temp
 * file, validates via a same-node curl (so the token never appears in a
 * command line we send -- $(cat <path>) is expanded by the remote shell
 * itself, not by us), extracts it only on a validated success, hands it to
 * the clipboard, and deletes the temp file regardless of outcome.
 *
 * This function itself never returns the token text -- see generateToken().
 */
async function tryGenerateAndPbcopy(clusterUuid: string, caseNumber: string): Promise<TokenResult> {
  const remoteTmp = "/tmp/.qview_spray_tok";
  const remoteTmpErr = "/tmp/.qview_spray_tok_err";
  const script = [
    `set timeout ${Math.ceil(cdmConfig.claimTimeoutMs / 1000)}`,
    "log_user 1",
    `spawn ${tclQuote(cdmConfig.portalClientPath)} connect`,
    `expect -re {\\$\\s*$}`,
    `send "portal connect --cluster-uuid ${tclQuote(clusterUuid)} --ticket ${tclQuote(caseNumber)}\\r"`,
    `set osuser ""`,
    `expect {`,
    `  -re {\\[y/n\\]\\?\\s*} { send "y\\r"; exp_continue }`,
    // Captures the OS login, e.g. "rksupport_basic@VRAZ238702681" -- printed
    // twice live (once plain, in the terminal-title OSC sequence, once
    // ANSI-coloured in the visible prompt). Deliberately not anchored to
    // what follows: the visible prompt's ":" comes after a colour-reset
    // escape code, which would break a stricter pattern; the plain-text
    // title occurrence matches this loose one just fine either way.
    `  -re {([A-Za-z0-9_.-]+)@[A-Za-z0-9_.-]+} { set osuser $expect_out(1,string) }`,
    `  timeout {}`,
    `}`,
    `sleep 1`,
    `if {[string match "*basic*" $osuser]} {`,
    `  set target_user {${BASIC_TARGET_USER}}`,
    `} else {`,
    `  set target_user {${DEFAULT_TARGET_USER}}`,
    `}`,
    `send "python /opt/rubrik/src/scripts/dev/get_local_spray_token.py --username $target_user > ${remoteTmp} 2>${remoteTmpErr}; echo QVIEW_GEN_DONE:\\$?\\r"`,
    `expect "QVIEW_GEN_DONE:"`,
    `sleep 1`,
    // Validated on the node itself -- "localhost" here is the cluster's own
    // API, no need to route back through the Mac's tunnel.
    `send {curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat ${remoteTmp} 2>/dev/null)" https://localhost/api/v1/cluster/me}`,
    `send "; echo QVIEW_VALIDATE:\\r"`,
    `expect -re {QVIEW_VALIDATE:\\d*}`,
    `sleep 1`,
    // Printed only inside these markers -- the caller extracts the exact
    // slice between them and nothing else ever gets treated as token text.
    // An unvalidated attempt's file is empty, so this prints nothing.
    `send {echo QVIEW_TOKEN_START; cat ${remoteTmp} 2>/dev/null; echo QVIEW_TOKEN_END}`,
    `send "\\r"`,
    `expect "QVIEW_TOKEN_END"`,
    `sleep 1`,
    `send {rm -f ${remoteTmp} ${remoteTmpErr}}`,
    `send "\\r"`,
    `sleep 1`,
    `send "exit\\r"`,
    `sleep 1`,
    `send "exit\\r"`,
    `expect eof`,
  ].join("\n");

  const { output, timedOut } = await runExpectScript(script, cdmConfig.claimTimeoutMs + 20000);
  if (timedOut) {
    log.warn("cdm.token_timeout", {});
    return { ok: false, code: "unknown", message: "Token generation timed out." };
  }

  // Which target actually got tried is read back from the transcript rather
  // than tracked separately -- the Tcl `if` above is the single source of
  // truth for the choice, so recovering it here can't drift from what ran.
  const targetUsed = output.includes(`--username ${BASIC_TARGET_USER}`) ? BASIC_TARGET_USER : DEFAULT_TARGET_USER;

  const validateMatch = /QVIEW_VALIDATE:(\d{3})/.exec(output);
  const status = validateMatch ? validateMatch[1] : null;
  if (status === "200") {
    const startTag = "QVIEW_TOKEN_START";
    const endTag = "QVIEW_TOKEN_END";
    const startIdx = output.indexOf(startTag);
    const endIdx = output.indexOf(endTag);
    const slice = startIdx !== -1 && endIdx !== -1 && endIdx > startIdx ? output.slice(startIdx + startTag.length, endIdx) : "";
    // Strip the echoed command line itself and ANSI/terminal control
    // sequences, keep only what looks like a token line.
    const token = slice
      .split(/\r?\n/)
      .map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim())
      .find((line) => /^[A-Za-z0-9._-]{15,}$/.test(line));
    if (token) {
      const copied = await copyToMacClipboard(token);
      // `token` goes out of scope here; nothing else in this function holds
      // a reference to it.
      if (!copied.ok) {
        log.warn("cdm.token_pbcopy_failed", { username: targetUsed });
        return { ok: false, code: "unknown", message: "Token generated and validated, but could not be copied to the clipboard." };
      }
      log.info("cdm.token_ok", { via: "exec", username: targetUsed });
      return { ok: true, via: "exec", username: targetUsed };
    }
  }
  log.warn("cdm.token_no_permission", { username: targetUsed });
  return {
    ok: false,
    code: "no_permission",
    message:
      "Automatic token generation was denied. This account may not have permission to request a spray token on this cluster -- use the manual command below, or escalate via `portal token --escalate` if that's warranted.",
  };
}

export async function generateToken(clusterUuid: string, caseNumber: string): Promise<TokenResult> {
  if (!UUID_RE.test(clusterUuid) || !CASE_RE.test(caseNumber)) {
    return { ok: false, code: "unknown", message: "Invalid cluster UUID or case number." };
  }
  return tryGenerateAndPbcopy(clusterUuid, caseNumber);
}
