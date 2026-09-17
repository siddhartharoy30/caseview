/**
 * Crystal vs Luna UI resolution -- Salesforce-only, per the agreed decision
 * ("trust Salesforce, require a real version" -- tunnel-based version
 * probing was considered and explicitly not chosen). "Other" and
 * "Rubrik Security Cloud (RSC)" are not versions; when nothing qualifies,
 * don't guess -- the caller shows both UI choices instead.
 */

export type UiFlavor = "crystal" | "luna";

export function parseMajorMinor(version: string | null | undefined): { major: number; minor: number } | null {
  const m = /^\s*(\d+)\.(\d+)/.exec(version || "");
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function uiFlavorFor(version: string | null | undefined): UiFlavor | null {
  const parsed = parseMajorMinor(version);
  if (!parsed) return null;
  return parsed.major > 9 || (parsed.major === 9 && parsed.minor >= 4) ? "luna" : "crystal";
}

export function uiPathFor(flavor: UiFlavor): string {
  return flavor === "luna" ? "/web/v2/#/support_access_login" : "/web/bin/index.html#/welcome_support";
}

/**
 * Try the cluster-level version first, then the case-level field under the
 * *same* ^\d+\.\d+ rule -- the case-level field currently rescues nothing in
 * observed data (it reads "Other" / "Rubrik Security Cloud (RSC)" / null on
 * every case with a null cluster version), but it's a free, cheap fallback.
 */
export function resolveUiFlavor(clusterVersion: string | null, caseVersionRaw: string | null): { flavor: UiFlavor | null; version: string | null } {
  if (uiFlavorFor(clusterVersion)) return { flavor: uiFlavorFor(clusterVersion), version: clusterVersion };
  if (uiFlavorFor(caseVersionRaw)) return { flavor: uiFlavorFor(caseVersionRaw), version: caseVersionRaw };
  return { flavor: null, version: clusterVersion || caseVersionRaw || null };
}
