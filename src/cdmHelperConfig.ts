import "dotenv/config";
import * as os from "os";
import * as path from "path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Config for the CDM tunnel helper -- a separate process from both the main
 * QView server and the RSC helper (docs/PLAN_V8_CDM.md, decision 4 in
 * PLAN_V8_CDM's predecessor doc). Runs only on the Mac: it's the only place
 * `portal_client` and Chrome are shelled out to. Deliberately a distinct
 * process from com.qview.rsc-helper so a `launchctl kickstart -k` on the RSC
 * helper (routine after an RSC-side change) can never drop a live tunnel
 * into a customer cluster.
 */
export const cdmConfig = {
  // A launchd LaunchAgent does not source .zshrc/.zprofile, so the plist that
  // starts this process must set PORTAL_CLIENT_PATH explicitly -- its PATH
  // does not include /Users/siddhartharoy, where the binary actually lives.
  portalClientPath: process.env.PORTAL_CLIENT_PATH || "/Users/siddhartharoy/portal_client",
  chromePath: process.env.CHROME_BIN_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // `expect` drives the one-shot, PTY-requiring `claim` step (docs/PLAN_V8_CDM.md
  // section 3) -- a pre-installed macOS/BSD system binary, not a new dependency.
  expectPath: process.env.EXPECT_BIN_PATH || "/usr/bin/expect",
  port: num("CDM_HELPER_PORT", 8757),
  allowedOrigins: (process.env.CDM_ALLOWED_ORIGINS || "http://10.26.118.153:3001,https://10.26.118.153:3443,http://localhost:3001")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // 9770-9799: outside macOS's ephemeral port range (49152-65535), so no
  // outbound socket from any app lands here by accident.
  portMin: num("CDM_PORT_MIN", 9770),
  portMax: num("CDM_PORT_MAX", 9799),
  claimTimeoutMs: num("CDM_CLAIM_TIMEOUT_MS", 25_000),
  tunnelTimeoutMs: num("CDM_TUNNEL_TIMEOUT_MS", 45_000),
  killGraceMs: num("CDM_KILL_GRACE_MS", 2_000),
  // Default claim window -- matches `portal claim`'s own default.
  claimDurationDays: num("CDM_CLAIM_DURATION_DAYS", 14),
  // Marker-file registry for the boot-time orphan sweep (docs/PLAN_V8_CDM.md).
  // Token-free by construction -- case, cluster, port, pid, nothing more.
  sessionDir: process.env.CDM_SESSION_DIR || path.join(os.homedir(), "Library", "Application Support", "QView", "cdm-sessions"),
  // Append-only, one JSON line per open/stop -- no token, no transcript.
  sessionLogPath: process.env.CDM_SESSION_LOG_PATH || path.join(os.homedir(), "Library", "Logs", "qview-cdm-sessions.log"),
};
