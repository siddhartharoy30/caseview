import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error("Missing required env var: " + name);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const anthropic = {
  baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "",
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
};

export const config = {
  port: Number(process.env.PORT || 3001),
  salesforce: {
    clientId: required("SALESFORCE_CLIENT_ID"),
    clientSecret: required("SALESFORCE_CLIENT_SECRET"),
    instanceUrl: required("SALESFORCE_INSTANCE_URL"),
    refreshToken: required("SALESFORCE_REFRESH_TOKEN"),
    apiVersion: process.env.SALESFORCE_API_VERSION || "v61.0",
    ownerName: process.env.SALESFORCE_OWNER_NAME || "",
  },
  iqs: {
    coverageHours: process.env.IQS_COVERAGE_HOURS || "9:00 AM - 6:00 PM",
    ownerTz: process.env.IQS_OWNER_TZ || "ET",

    /**
     * Layer 2, the model scorer.
     *
     * Every knob has a working default, and the whole layer is inert without a
     * token: Layer 1 has to stand alone (acceptance criterion 2), so nothing
     * here may become load-bearing for a score to exist.
     */
    layer2: {
      /** Master switch. IQS_LAYER2=off disables the layer even with a token. */
      enabled: (process.env.IQS_LAYER2 || "on").toLowerCase() !== "off",
      /** Defaults to the drafting model so there is one model to reason about. */
      model: process.env.IQS_LAYER2_MODEL || anthropic.model,
      /**
       * Hard daily ceiling in estimated USD. The estimate is local (list
       * prices, not a bill), so this is a safety valve against a runaway loop
       * rather than an accounting control.
       */
      dailyBudgetUsd: num("IQS_LAYER2_DAILY_USD", 2),
      /** Floor between two calls, so a sweep cannot burst the gateway. */
      minIntervalMs: num("IQS_LAYER2_MIN_INTERVAL_MS", 4000),
      /** Cases per background sweep pass, newest first. */
      sweepBatch: num("IQS_LAYER2_SWEEP_BATCH", 3),
      /** Minutes between sweep passes. Zero disables the sweep entirely. */
      sweepMinutes: num("IQS_LAYER2_SWEEP_MINUTES", 20),
      /** Most recent owner comments sent for scoring. */
      maxComments: num("IQS_LAYER2_MAX_COMMENTS", 24),
      /** Per-comment character cap, so one pasted log cannot dominate a call. */
      maxCommentChars: num("IQS_LAYER2_MAX_COMMENT_CHARS", 4000),
      /** How long the usage ledger is kept, in days. */
      usageRetentionDays: num("IQS_LAYER2_USAGE_RETENTION_DAYS", 90),
    },
  },
  anthropic,
  session: { secret: process.env.SESSION_SECRET || "" },
  auth: { allowedEmail: required("QVIEW_ALLOWED_EMAIL") },
};

if (!config.session.secret) {
  throw new Error("SESSION_SECRET must be set to a real random value");
}
