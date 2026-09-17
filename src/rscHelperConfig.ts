import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Config for the RSC support-access helper -- a separate process from the
 * main QView server (see docs/PLAN_V8.md's Phase 0). Runs only on the Mac:
 * it's the only place `gcloud` is authenticated as the support-impersonation
 * identity, and the only place on the VPN pacman requires.
 */
export const rscConfig = {
  // Bare "gcloud" matches the user's own manual script, which runs from an
  // interactive shell that already has it on PATH. A launchd LaunchAgent does
  // not source .zshrc/.zprofile, so the plist that starts this process must
  // set GCLOUD_BIN_PATH explicitly rather than relying on this default.
  gcloudPath: process.env.GCLOUD_BIN_PATH || "gcloud",
  pacmanBaseUrl: process.env.PACMAN_BASE_URL || "https://pacman.prod.my.rubrik.com",
  port: num("RSC_HELPER_PORT", 8756),
  // The known origins the case-detail page can be served from. Anything else
  // gets no Access-Control-Allow-Origin and the browser blocks the response.
  allowedOrigins: (process.env.RSC_ALLOWED_ORIGINS || "http://10.26.118.153:3001,https://10.26.118.153:3443,http://localhost:3001")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // "Only one token active per support user per account" -- self-throttle for
  // this long rather than fire a request pacman will refuse.
  cooldownMs: num("RSC_COOLDOWN_MS", 120_000),
  // Identity tokens are hourly, but the spec says not to bank on it.
  identityTokenTtlMs: num("RSC_IDENTITY_TOKEN_TTL_MS", 4 * 60 * 1000),
};
