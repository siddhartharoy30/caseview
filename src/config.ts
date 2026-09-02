import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error("Missing required env var: " + name);
  return v;
}

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
  },

  anthropic: {
    baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  },

  session: {
    secret: process.env.SESSION_SECRET || "",
  },

  auth: {
    allowedEmail: required("QVIEW_ALLOWED_EMAIL"),
  },
};

if (!config.session.secret) {
  throw new Error("SESSION_SECRET must be set to a real random value");
}
