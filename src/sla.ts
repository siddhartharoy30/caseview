import type { SalesforceCase } from "./salesforce";

const SLA_WINDOWS_MINUTES: Record<string, number> = {
  P1: 30,
  P2: 120,
  P3: 240,
  P4: 480,
};

export function slaWindowMinutes(priority: string | null): number | null {
  if (!priority) return null;
  const key = priority.toUpperCase().replace(/\s+/g, "");
  return SLA_WINDOWS_MINUTES[key] ?? null;
}

export interface SlaInfo {
  windowMinutes: number | null;
  remainingSeconds: number | null;
  breached: boolean;
}

export function computeSla(c: SalesforceCase): SlaInfo {
  const windowMinutes = slaWindowMinutes(c.Priority);
  if (windowMinutes === null) {
    return { windowMinutes: null, remainingSeconds: null, breached: false };
  }
  const createdMs = new Date(c.CreatedDate).getTime();
  const deadlineMs = createdMs + windowMinutes * 60 * 1000;
  const remainingSeconds = Math.floor((deadlineMs - Date.now()) / 1000);
  return { windowMinutes, remainingSeconds, breached: remainingSeconds < 0 };
}

export function deriveQueue(c: SalesforceCase): string {
  return c.Origin || c.Type || "General";
}

export function caseAgeDays(c: SalesforceCase): number {
  return (Date.now() - new Date(c.CreatedDate).getTime()) / (1000 * 60 * 60 * 24);
}

export type NextActionKind = "work" | "followup" | "closure";

export interface NextAction {
  kind: NextActionKind;
  label: string;
  reason: string;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

// Derives the recommended plan of action for a case from its status, how long
// the customer has been quiet, and whether its NCC commitment has slipped.
export function deriveNextAction(c: SalesforceCase): NextAction {
  const status = (c.Status || "").toLowerCase();
  const custQuietDays = daysSince(c.Last_Customer_Update__c);
  const nccOverdue = c.NCC_date__c ? new Date(c.NCC_date__c).getTime() < Date.now() : false;

  // Resolved and waiting on the customer to confirm the fix.
  if (status.includes("resolved") && status.includes("pending")) {
    if (custQuietDays !== null && custQuietDays >= 4) {
      return {
        kind: "closure",
        label: "Closure",
        reason: `Resolved; customer quiet ${Math.floor(custQuietDays)}d — close out`,
      };
    }
    return {
      kind: "followup",
      label: "Follow up",
      reason: "Resolved — confirm fix with customer",
    };
  }

  // Waiting for the customer to respond with info we need.
  if (status.includes("waiting") && status.includes("customer")) {
    if (custQuietDays !== null && custQuietDays >= 3) {
      return {
        kind: "followup",
        label: "Follow up",
        reason: `Awaiting customer ${Math.floor(custQuietDays)}d — send reminder`,
      };
    }
    return {
      kind: "followup",
      label: "Follow up",
      reason: "Awaiting customer input",
    };
  }

  // Fix is pending with engineering — keep it moving / keep the customer posted.
  if (status.includes("pending fix") || status.includes("pending")) {
    return {
      kind: "work",
      label: "Work",
      reason: nccOverdue ? "Fix pending; NCC overdue — chase" : "Track fix, update customer",
    };
  }

  // Actively being worked.
  if (status.includes("progress")) {
    return {
      kind: "work",
      label: "Work",
      reason: c.IsEscalated ? "Escalated — needs active work" : "Active investigation",
    };
  }

  return {
    kind: "work",
    label: "Work",
    reason: nccOverdue ? "NCC overdue — review now" : "Needs review",
  };
}

