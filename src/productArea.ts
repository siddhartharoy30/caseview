/**
 * Product area classification.
 *
 * Salesforce's Problem_Type__c is authoritative when it is populated. It often
 * is not, so the fallback is a keyword match over subject + description against
 * the areas that actually show up in this queue.
 *
 * Order matters: the first area whose pattern matches wins, so the more
 * specific areas are listed before the general ones.
 */

export const PRODUCT_AREAS = [
  "Cyber Recovery",
  "Archival",
  "M365",
  "AWS",
  "Azure",
  "GCP",
  "RSC",
  "CDM",
] as const;

export type ProductArea = (typeof PRODUCT_AREAS)[number] | "Unclassified";

const PATTERNS: Array<[ProductArea, RegExp]> = [
  ["Cyber Recovery", /\b(cyber\s*recovery|cyber\s*vault|threat\s*hunt|ransomware|anomaly\s*detection|sensitive\s*data|data\s*threat)\b/i],
  ["Archival", /\b(archival|archive|glacier|s3\s*archive|tape|nfs\s*archive|cloud\s*tier|slow\s*archive)\b/i],
  ["M365", /\b(m365|o365|office\s*365|microsoft\s*365|exchange\s*online|sharepoint|onedrive|teams\s*backup)\b/i],
  ["AWS", /\b(aws|ec2|ebs|s3\b|rds\b|amazon\s*web|iam\s*role|cloudformation)\b/i],
  ["Azure", /\b(azure|blob\s*storage|aks\b|azure\s*ad|entra|arm\s*template)\b/i],
  ["GCP", /\b(gcp|google\s*cloud|gcs\b|gce\b|bigquery)\b/i],
  ["RSC", /\b(rsc\b|security\s*cloud|polaris|rubrik\s*security\s*cloud|sonar|radar)\b/i],
  ["CDM", /\b(cdm\b|brik\b|cluster\s*node|node\s*down|rubrik\s*cluster|r6\d{3}|r3\d{3}|upgrade\s*cluster|cdm\s*\d+\.\d+)\b/i],
];

/** Normalise whatever Salesforce has in Problem_Type__c onto our own list. */
function fromSalesforceType(raw: string | null | undefined): ProductArea | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  for (const [area, re] of PATTERNS) {
    if (re.test(t)) return area;
  }
  return null;
}

/**
 * Classify a case. `problemType` is trusted first; text is the fallback.
 * Returns "Unclassified" rather than guessing when nothing matches — an honest
 * blank is more useful than a wrong bucket.
 */
export function deriveProductArea(input: {
  problemType?: string | null;
  subComponent?: string | null;
  subject?: string | null;
  description?: string | null;
}): ProductArea {
  const mapped =
    fromSalesforceType(input.problemType) || fromSalesforceType(input.subComponent);
  if (mapped) return mapped;

  const text = [input.subject || "", input.description || ""].join(" \n ");
  if (!text.trim()) return "Unclassified";

  for (const [area, re] of PATTERNS) {
    if (re.test(text)) return area;
  }
  return "Unclassified";
}
