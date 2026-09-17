import { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { cdmConfig } from "./cdmHelperConfig";
import { log, errText } from "./log";

export type CdmSessionState = "starting" | "claiming" | "connecting" | "open" | "stopping" | "stopped" | "error";

export type CdmErrorCode =
  | "portal_missing"
  | "not_authenticated"
  | "no_free_port"
  | "port_taken"
  | "no_tunnel"
  | "claim_failed"
  | "tunnel_failed"
  | "tunnel_timeout"
  | "chrome_missing"
  | "unknown";

export interface CdmSession {
  id: string;
  caseNumber: string; // ALWAYS the real case number (docs/PLAN_V8_CDM.md requirement 3)
  clusterUuid: string;
  clusterTag: string | null;
  clusterVersion: string | null;
  localPort: number | null;
  state: CdmSessionState;
  startedAt: number;
  stoppedAt: number | null;
  error: { code: CdmErrorCode; message: string } | null;
  uiFlavor: "crystal" | "luna" | null;
  uiUrl: string | null;
  tokenStatus: "none" | "auto" | "manual";
  chromeProfileDir: string | null;
  chromePid: number | null;
  // Live-progress text for whatever's currently running (tunnel setup or a
  // token-generation attempt) -- polled by the panel so the operator sees
  // what's happening as it happens, not just a result after the fact.
  currentStep: string | null;
  // Set only by a token-generation attempt; cleared at the start of the
  // next one. Separate from `error` (the tunnel's own failure state) since
  // a denied token generation must not disturb an otherwise-open session.
  tokenGenError: string | null;
  // Never serialised -- see toWire() below, an explicit allowlist rather than
  // a subtraction, so a future field can't leak by accident as this grows.
  child?: ChildProcess;
}

const sessions = new Map<string, CdmSession>();

export interface CdmSessionWire {
  id: string;
  caseNumber: string;
  clusterUuid: string;
  clusterTag: string | null;
  clusterVersion: string | null;
  localPort: number | null;
  state: CdmSessionState;
  startedAt: number;
  stoppedAt: number | null;
  error: { code: CdmErrorCode; message: string } | null;
  uiFlavor: "crystal" | "luna" | null;
  uiUrl: string | null;
  tokenStatus: "none" | "auto" | "manual";
  hasChromeWindow: boolean;
  currentStep: string | null;
  tokenGenError: string | null;
}

export function toWire(s: CdmSession): CdmSessionWire {
  return {
    id: s.id,
    caseNumber: s.caseNumber,
    clusterUuid: s.clusterUuid,
    clusterTag: s.clusterTag,
    clusterVersion: s.clusterVersion,
    localPort: s.localPort,
    state: s.state,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    error: s.error,
    uiFlavor: s.uiFlavor,
    uiUrl: s.uiUrl,
    tokenStatus: s.tokenStatus,
    hasChromeWindow: s.chromePid != null,
    currentStep: s.currentStep,
    tokenGenError: s.tokenGenError,
  };
}

/** Sets the live-progress text the panel polls for. Never call this with
 * anything derived from child-process output -- see cdmAccess.ts/cdmToken.ts
 * headers. Step descriptions are always fixed, hand-written strings. */
export function setStep(s: CdmSession, step: string | null): void {
  s.currentStep = step;
}

export function createSession(caseNumber: string, clusterUuid: string, clusterTag: string | null, clusterVersion: string | null): CdmSession {
  const s: CdmSession = {
    id: uuidv4(),
    caseNumber,
    clusterUuid,
    clusterTag,
    clusterVersion,
    localPort: null,
    state: "starting",
    startedAt: Date.now(),
    stoppedAt: null,
    error: null,
    uiFlavor: null,
    uiUrl: null,
    tokenStatus: "none",
    chromeProfileDir: null,
    chromePid: null,
    currentStep: null,
    tokenGenError: null,
  };
  sessions.set(s.id, s);
  return s;
}

export function getSession(id: string): CdmSession | undefined {
  return sessions.get(id);
}

export function listSessions(): CdmSession[] {
  return [...sessions.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function reservedPorts(): Set<number> {
  const ports = new Set<number>();
  for (const s of sessions.values()) {
    if (s.localPort != null && (s.state === "starting" || s.state === "claiming" || s.state === "connecting" || s.state === "open")) {
      ports.add(s.localPort);
    }
  }
  return ports;
}

/** Caps how many stopped/error sessions the dock/panel needs to render history for. */
export function pruneOldSessions(max = 50): void {
  const done = [...sessions.values()].filter((s) => s.state === "stopped" || s.state === "error");
  done.sort((a, b) => a.startedAt - b.startedAt);
  while (done.length > max) {
    const s = done.shift();
    if (s) sessions.delete(s.id);
  }
}

/* --------------------------------------------- marker-file boot registry */

/**
 * One JSON file per live session, token-free by construction (case, cluster,
 * port, pid, timestamps -- nothing else). Written on open, removed on clean
 * stop. Read at boot so a crashed-and-restarted helper (KeepAlive: true means
 * launchd always restarts it) can find and kill orphaned `portal_client`
 * children rather than leaking them into the pool forever.
 */
interface MarkerFile {
  pid: number;
  port: number;
  caseNumber: string;
  clusterUuid: string;
  clusterTag: string | null;
  startedAt: number;
}

function markerPath(sessionId: string): string {
  return path.join(cdmConfig.sessionDir, `${sessionId}.json`);
}

export function writeMarker(s: CdmSession, pid: number): void {
  try {
    fs.mkdirSync(cdmConfig.sessionDir, { recursive: true });
    const marker: MarkerFile = {
      pid,
      port: s.localPort ?? 0,
      caseNumber: s.caseNumber,
      clusterUuid: s.clusterUuid,
      clusterTag: s.clusterTag,
      startedAt: s.startedAt,
    };
    fs.writeFileSync(markerPath(s.id), JSON.stringify(marker));
  } catch (err) {
    log.warn("cdm.marker_write_failed", { error: errText(err) });
  }
}

export function removeMarker(sessionId: string): void {
  try {
    fs.rmSync(markerPath(sessionId), { force: true });
  } catch {
    // best-effort
  }
}

/**
 * Boot-time sweep. Never kills a bare recorded pid -- pids get recycled --
 * only after confirming via `ps -p <pid> -o comm=` that the process at that
 * pid is still actually `portal_client`.
 */
export function readAllMarkers(): Array<{ file: string } & MarkerFile> {
  try {
    fs.mkdirSync(cdmConfig.sessionDir, { recursive: true });
    const files = fs.readdirSync(cdmConfig.sessionDir).filter((f) => f.endsWith(".json"));
    const out: Array<{ file: string } & MarkerFile> = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(cdmConfig.sessionDir, file), "utf8");
        out.push({ file, ...(JSON.parse(raw) as MarkerFile) });
      } catch {
        // skip a corrupt marker rather than crashing the sweep
      }
    }
    return out;
  } catch (err) {
    log.warn("cdm.marker_read_failed", { error: errText(err) });
    return [];
  }
}

export function removeMarkerFile(file: string): void {
  try {
    fs.rmSync(path.join(cdmConfig.sessionDir, file), { force: true });
  } catch {
    // best-effort
  }
}

/* ------------------------------------------------------- local session log */

/**
 * Append-only JSONL, one line per open/stop -- case, cluster, port,
 * timestamps. No token, no transcript. A purpose-built file rather than
 * log.ts, because the app log ships to Loki and its redactor is key-name-only
 * (docs/PLAN_V8_CDM.md security requirement 1) -- this file never carries
 * anything sensitive in the first place, by construction of what's written.
 */
export function appendSessionLog(event: "open" | "stop", s: CdmSession): void {
  try {
    const line = JSON.stringify({
      ts: Date.now(),
      event,
      sessionId: s.id,
      caseNumber: s.caseNumber,
      clusterUuid: s.clusterUuid,
      clusterTag: s.clusterTag,
      localPort: s.localPort,
      startedAt: s.startedAt,
      stoppedAt: s.stoppedAt,
      tokenStatus: s.tokenStatus,
      uiFlavor: s.uiFlavor,
    });
    fs.appendFileSync(cdmConfig.sessionLogPath, line + "\n");
  } catch (err) {
    log.warn("cdm.session_log_failed", { error: errText(err) });
  }
}
