import fs from "fs";
import path from "path";

/**
 * Structured JSON logging.
 *
 * One JSON object per line, written to stdout and appended to a file. Promtail
 * scrapes the file; `docker logs` shows the same records. Keeping both means a
 * container restart does not lose history and an interactive debug session does
 * not have to tail a file.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL as Level) || "info"] ?? LEVELS.info;
const LOG_FILE = process.env.QVIEW_LOG_FILE || "/data/qview.log";

let stream: fs.WriteStream | null = null;

function fileStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    // A broken log file must never take the process down.
    stream.on("error", () => { stream = null; });
    return stream;
  } catch {
    return null;
  }
}

/** Never let a secret-shaped value reach the log. */
const REDACT = /^(.*(token|secret|password|authorization|refresh).*)$/i;

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = REDACT.test(k) ? "[redacted]" : v;
  }
  return out;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < MIN_LEVEL) return;

  const record = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...scrub(fields),
  });

  if (level === "error" || level === "warn") process.stderr.write(record + "\n");
  else process.stdout.write(record + "\n");

  fileStream()?.write(record + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

/** Turn an unknown thrown value into something safe to put in a log field. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
