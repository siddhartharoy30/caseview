/**
 * The one place that decides what a case's current posture calls for.
 *
 * Phase 1 through 3 shipped this derivation three times: claude.ts read live
 * Salesforce comments to pick a drafting template, iqs/layer1.ts mirrored the
 * same thresholds against cached rows to pick a keyword to score against, and
 * sla.ts answered a related-looking question -- what the queue's Next Action
 * column shows -- from a disjoint set of fields (status text, days since the
 * customer last touched the case, whether NCC slipped) that never looked at
 * the comment thread at all. The result: a case in "Resolved - Pending
 * Customer" got a CLOSURE draft immediately (status alone decided it) while
 * the queue still labelled it "Follow up" for up to four more days (a
 * separate quiet-days clock decided that). Same case, two disagreeing
 * answers, because the code asked two different questions.
 *
 * detectKeyword() below is the single derivation. Everything downstream --
 * drafting, Layer 1 scoring, the queue label -- is a thin wrapper over its
 * result, so they cannot drift apart again without both being edited.
 */

import type { Keyword } from "./iqs/rubric";

/** The minimum shape any comment source needs to expose. */
export interface CommentSignal {
  isPublic: boolean;
  isMine: boolean;
}

export type ClosurePath = "confirmed" | "noresponse";

export interface KeywordDetection {
  keyword: Keyword;
  /** Set only when keyword is CLOSURE. */
  path?: ClosurePath;
  /** Set only when keyword is FOLLOWUP. */
  attempt?: 1 | 2;
  /** The raw run length the decision was made from, for callers that want it. */
  trailingMine: number;
}

/** Status text that, on its own, settles the case regardless of the thread. */
function isTerminalStatus(status: string | null | undefined): boolean {
  const s = (status || "").toLowerCase();
  return s.includes("pending closure") || s.includes("resolved") || s.includes("closed");
}

/**
 * IQS "3-Strikes" rule: 2 unanswered owner outreach comments in a row
 * (FOLLOWUP 1, FOLLOWUP 2) exhausts follow-up attempts; a 3rd unanswered
 * owner comment moves the case to CLOSURE noresponse instead of a 3rd
 * FOLLOWUP.
 *
 * `comments` must be oldest-first, matching how both Salesforce and the local
 * cache already order them. Only public comments count -- an internal note
 * does not move the conversation with the customer forward, so it can
 * neither reset nor extend the trailing streak.
 */
export function detectKeyword(status: string | null | undefined, comments: CommentSignal[]): KeywordDetection {
  if (isTerminalStatus(status)) {
    return { keyword: "CLOSURE", path: "confirmed", trailingMine: 0 };
  }

  const publicComments = comments.filter((c) => c.isPublic);
  if (publicComments.length === 0) {
    return { keyword: "INTRO", trailingMine: 0 };
  }

  let trailingMine = 0;
  for (let i = publicComments.length - 1; i >= 0; i--) {
    if (publicComments[i].isMine) trailingMine++;
    else break;
  }

  if (trailingMine === 0) return { keyword: "UPDATE", trailingMine };
  if (trailingMine >= 3) return { keyword: "CLOSURE", path: "noresponse", trailingMine };
  return { keyword: "FOLLOWUP", attempt: trailingMine === 2 ? 2 : 1, trailingMine };
}

/* ------------------------------------------------------------ queue label */

export type NextActionKind = "work" | "followup" | "closure";

export interface NextAction {
  kind: NextActionKind;
  label: string;
  reason: string;
}

const KIND_BY_KEYWORD: Record<Keyword, NextActionKind> = {
  INTRO: "work",
  UPDATE: "work",
  FOLLOWUP: "followup",
  CLOSURE: "closure",
};

const LABEL_BY_KIND: Record<NextActionKind, string> = {
  work: "Work",
  followup: "Follow up",
  closure: "Closure",
};

export interface NextActionFacts {
  keyword: Keyword;
  status: string | null;
  custQuietDays: number | null;
  nccOverdue: boolean;
  isEscalated: boolean;
}

/**
 * The queue's Next Action column. `kind` is derived from `keyword` alone --
 * the same bucket the drafter and Layer 1 scorer use -- so it can never say
 * "keep working" on a case the drafter would already close. The other facts
 * only shape the reason text.
 */
export function nextActionForKeyword(facts: NextActionFacts): NextAction {
  const kind = KIND_BY_KEYWORD[facts.keyword];
  return { kind, label: LABEL_BY_KIND[kind], reason: reasonFor(facts) };
}

function reasonFor(facts: NextActionFacts): string {
  const { keyword, status, custQuietDays, nccOverdue, isEscalated } = facts;
  const quiet = custQuietDays !== null ? Math.floor(custQuietDays) : null;

  switch (keyword) {
    case "INTRO":
      return "New case — send initial response";
    case "UPDATE":
      if (isEscalated) return "Escalated — needs active work";
      if (nccOverdue) return "NCC overdue — review now";
      return "Needs review";
    case "FOLLOWUP":
      return quiet !== null
        ? `Awaiting customer ${quiet}d — send reminder`
        : "Awaiting customer input";
    case "CLOSURE":
      // Terminal status settled it outright; a non-terminal status here can
      // only mean the 3-strikes no-response path fired instead.
      if (!isTerminalStatus(status)) {
        return "No response after 2 follow-ups — close per non-response process";
      }
      return quiet !== null && quiet >= 4
        ? `Resolved; customer quiet ${quiet}d — close out`
        : "Resolved — confirm fix with customer";
  }
}
