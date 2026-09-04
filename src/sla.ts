import type { SalesforceCase } from "./salesforce";
import { nextActionForKeyword } from "./nextAction";
import type { Keyword } from "./iqs/rubric";
export type { NextAction, NextActionKind } from "./nextAction";

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

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * The queue's Next Action column, now a thin wrapper over ./nextAction.
 *
 * `keyword` is the same bucket the drafter (claude.ts) and the Layer 1 scorer
 * derive from the comment thread -- pass the one already computed for this
 * case (`iqs.keyword` from the cache) rather than a fresh guess from status
 * text, or this column and the drafter can disagree again.
 */
export function deriveNextAction(c: SalesforceCase, keyword: Keyword) {
  return nextActionForKeyword({
    keyword,
    status: c.Status,
    custQuietDays: daysSince(c.Last_Customer_Update__c),
    nccOverdue: c.NCC_date__c ? new Date(c.NCC_date__c).getTime() < Date.now() : false,
    isEscalated: !!c.IsEscalated,
  });
}

