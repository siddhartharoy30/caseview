import Anthropic from "@anthropic-ai/sdk";
import { addBusinessDays, TZ } from "./businessHours";
import { config } from "./config";
import { CORE_RULES, TEMPLATE_RULES } from "./iqs/rubric";
import type { Keyword } from "./iqs/rubric";
import type { SalesforceCase, SalesforceCaseComment } from "./salesforce";
import { getPublicCaseComments } from "./salesforce";

const client = new Anthropic({
  authToken: config.anthropic.authToken,
  apiKey: null,
  baseURL: config.anthropic.baseUrl,
});

export interface DraftResult {
  keyword: string;
  customerText: string;
  internalNote: string | null;
  selfCheck: string | null;
}

interface Detection {
  keyword: Keyword;
  path?: "confirmed" | "noresponse";
  attempt?: 1 | 2;
}

// IQS "3-Strikes" rule: 2 unanswered owner outreach comments in a row (FOLLOWUP 1,
// FOLLOWUP 2) exhausts follow-up attempts; a 3rd unanswered owner comment means the
// case moves to CLOSURE noresponse instead of a 3rd FOLLOWUP.
function detectKeyword(c: SalesforceCase, comments: SalesforceCaseComment[]): Detection {
  const status = (c.Status || "").toLowerCase();
  if (status.includes("pending closure") || status.includes("resolved") || status.includes("closed")) {
    return { keyword: "CLOSURE", path: "confirmed" };
  }
  if (comments.length === 0) {
    return { keyword: "INTRO" };
  }

  const ownerName = c.Owner?.Name || "";
  let trailingOwnerCount = 0;
  for (let i = comments.length - 1; i >= 0; i--) {
    if (ownerName && comments[i].CreatedBy?.Name === ownerName) trailingOwnerCount++;
    else break;
  }

  if (trailingOwnerCount === 0) {
    return { keyword: "UPDATE" };
  }
  if (trailingOwnerCount >= 3) {
    return { keyword: "CLOSURE", path: "noresponse" };
  }
  return { keyword: "FOLLOWUP", attempt: trailingOwnerCount === 2 ? 2 : 1 };
}

function addCalendarDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// The container clock is UTC. Without an explicit zone this renders tomorrow's
// date after 8 PM Eastern, and commitments.ts then parses those dates back out
// of the posted comment and measures them in America/New_York. Same zone on
// both sides or the reliability numbers are quietly wrong one evening in three.
function formatLongDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatComments(comments: SalesforceCaseComment[], ownerName: string): string {
  if (!comments.length) return "(no public comments on this case yet)";
  return comments
    .map((cm) => {
      const author = cm.CreatedBy?.Name || "(unknown)";
      const role = author === ownerName ? "owner" : "customer/other";
      return `[${cm.CreatedDate}] ${author} (${role}): ${cm.CommentBody || "(empty)"}`;
    })
    .join("\n\n");
}

function buildFollowupBody(attempt: 1 | 2): string {
  if (attempt === 1) {
    return "This is the first follow-up. Ask again for what's outstanding and commit to a specific next-attempt date/time.";
  }
  return "This is the second and final follow-up. Note this is the second attempt, and state that if there is no response the case will move to close, giving the absolute close-by date/time from the reference dates below.";
}

export async function draftSuggestedReply(c: SalesforceCase): Promise<DraftResult> {
  const comments = await getPublicCaseComments(c.Id);
  const detection = detectKeyword(c, comments);
  const ownerName = c.Owner?.Name || "the case owner";
  const ownerTitle = c.Owner?.Title || "Support Engineer";

  const scaledComments =
    detection.keyword === "INTRO"
      ? comments.slice(-1)
      : detection.keyword === "CLOSURE"
      ? comments
      : comments.slice(-5);

  const now = new Date();
  const referenceDates = [
    `Today: ${formatLongDate(now)}`,
    `Same-day 6 PM commitment: 6:00 PM ${config.iqs.ownerTz} today, ${formatLongDate(now)}`,
    `Next business day: ${formatLongDate(addBusinessDays(now, 1))}`,
    `Two business days out, 6 PM commitment: 6:00 PM ${config.iqs.ownerTz} on ${formatLongDate(addBusinessDays(now, 2))}`,
    `30-day reopen window (from today): through ${formatLongDate(addCalendarDays(now, 30))}`,
  ].join("\n");

  let templateText = TEMPLATE_RULES[detection.keyword];
  if (detection.keyword === "FOLLOWUP") {
    const attempt = detection.attempt || 1;
    templateText = templateText
      .replace("{ATTEMPT}", String(attempt))
      .replace("{ATTEMPT_BODY}", buildFollowupBody(attempt));
  }
  if (detection.keyword === "CLOSURE") {
    const path = detection.path || "confirmed";
    const pathLine =
      path === "confirmed"
        ? "state that you are closing the case today since the customer confirmed resolution"
        : "state that you are closing the case today under Rubrik's standard non-response process after 2 unanswered attempts, naming the specific documented attempt dates from the comment history including any phone attempt";
    templateText = templateText.replace("{PATH}", path).replace("{PATH_LINE}", pathLine);
  }

  const systemPrompt = `${CORE_RULES}\n\n${templateText}`;

  const context = [
    `Case Number: ${c.CaseNumber}`,
    `Subject: ${c.Subject || "(none)"}`,
    `Status: ${c.Status}`,
    `Priority: ${c.Priority || "(none)"}`,
    `Account: ${c.Account?.Name || "(unknown)"}`,
    `Description: ${c.Description || "(none)"}`,
    `Owner Name: ${ownerName}`,
    `Owner Title: ${ownerTitle}`,
    `Coverage Hours: ${config.iqs.coverageHours}`,
    `Owner Timezone: ${config.iqs.ownerTz}`,
    "",
    "Reference dates (use exactly, do not recompute):",
    referenceDates,
    "",
    `Case comment history (${scaledComments.length} of ${comments.length} public comments, oldest to newest):`,
    formatComments(scaledComments, ownerName),
  ].join("\n");

  const res = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Draft the ${detection.keyword} response for this case, following the output contract exactly:\n\n${context}`,
      },
    ],
  });

  const block = res.content.find((b) => b.type === "text");
  const raw = block && block.type === "text" ? block.text.trim() : "";
  const parsed = parseModelOutput(raw, detection.keyword === "CLOSURE");

  return {
    keyword: detection.keyword,
    customerText: parsed.customerText,
    internalNote: parsed.internalNote,
    selfCheck: parsed.selfCheck,
  };
}

function parseModelOutput(
  raw: string,
  isClosure: boolean
): { customerText: string; internalNote: string | null; selfCheck: string | null } {
  const blocks: string[] = [];
  const regex = /```(?:[a-zA-Z]*\n)?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  while ((match = regex.exec(raw)) !== null) {
    blocks.push(match[1].trim());
    lastIndex = regex.lastIndex;
  }

  if (blocks.length === 0) {
    return { customerText: raw, internalNote: null, selfCheck: null };
  }

  const customerText = blocks[0];
  const internalNote = isClosure && blocks.length > 1 ? blocks[1] : null;
  const selfCheck = raw.slice(lastIndex).trim() || null;
  return { customerText, internalNote, selfCheck };
}
