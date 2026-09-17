/**
 * Isolated Chrome launch. `__Secur-rubrik-token` is scoped by host, not
 * port -- a cookie set by cluster A on 127.0.0.1:9770 is sent to cluster B
 * on 127.0.0.1:9780. Rotating ports does nothing; a genuinely separate
 * profile per session is the only fix (docs/PLAN_V8_CDM.md's predecessor
 * plan). Spawned directly (not via `open -na`) so the process is trackable
 * and closeable, and so LaunchServices can't hand the URL to an
 * already-running Chrome instance -- exactly the cookie-jar leak this exists
 * to avoid.
 */

import { spawn, ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { cdmConfig } from "./cdmHelperConfig";
import { log, errText } from "./log";

export interface ChromeLaunch {
  child: ChildProcess;
  profileDir: string;
}
export type ChromeLaunchResult = ChromeLaunch | { ok: false; code: "chrome_missing"; message: string };

export async function launchIsolatedChrome(url: string, sessionId: string): Promise<ChromeLaunchResult> {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), `qview-cdm-${sessionId.slice(0, 8)}-`));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        cdmConfig.chromePath,
        [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--new-window", url],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        resolve({
          ok: false,
          code: "chrome_missing",
          message: `Chrome not found at "${cdmConfig.chromePath}". Set CHROME_BIN_PATH in the CDM helper's environment.`,
        });
        return;
      }
      log.warn("cdm.chrome_spawn_failed", { error: errText(err) });
      resolve({ ok: false, code: "chrome_missing", message: "Could not launch Chrome." });
      return;
    }
    resolve({ child, profileDir });
  });
}

/**
 * Closed with SIGTERM only, never escalated to SIGKILL -- Chrome treats
 * SIGTERM as a clean quit, SIGKILL can lose typed text in the window.
 */
export async function closeChromeAndCleanup(child: ChildProcess | null, profileDir: string | null): Promise<void> {
  if (child && child.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (profileDir) {
    // Give Chrome a moment to release its own lock files before removing.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await fs.rm(profileDir, { recursive: true, force: true });
    } catch (err) {
      log.warn("cdm.chrome_profile_cleanup_failed", { error: errText(err) });
    }
  }
}
