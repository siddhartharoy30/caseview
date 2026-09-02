import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";
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

type Keyword = "INTRO" | "UPDATE" | "FOLLOWUP" | "CLOSURE";

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

function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (day !== 0 && day !== 6) added++;
  }
  return result;
}

function addCalendarDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatLongDate(d: Date): string {
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
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

const CORE_RULES = `You are drafting a Rubrik Salesforce case comment that must pass Rubrik's Internal
Quality Standards (IQS) scoring rubric. Follow every rule below exactly.

OUTPUT CONTRACT (follow this order, nothing else):
1. The customer-facing message, in its own fenced code block.
2. Only for CLOSURE: a second fenced code block containing the internal resolution note
   (never sent to the customer).
3. An IQS self-check estimate, as plain text, outside of any code block.
Do not add any preamble, narration, or sign-off of your own outside this contract.

FORMATTING RULES (customer-facing text only):
- No subject line. No em-dashes, ever (use periods, commas, or parentheses instead).
- No bold, no markdown headers, no bullet lists. Numbered steps (1., 2., 3.) are allowed.
- Keep it short and concise. Never copy-paste the case Subject or Description verbatim;
  restate the problem in your own words, naming the specific artifacts involved.
- First-person, definitive language throughout ("I will", "I confirmed") — no hedging.
- Greet the customer by first name only, never full name.

BANNED PHRASES (customer-facing text; each one auto-deducts IQS score — replace as shown):
- "engage our engineering team" -> "I will escalate internally and drive [specific action]"
- "we will keep you posted/updated" -> give an absolute deadline instead
- "as soon as Engineering provides" -> give an absolute deliverable date instead
- "promptly / shortly / ASAP / soon" -> give an absolute time instead
- "known issue / known behavior" -> "a transient backend state that has been mitigated"
- "Jira / Jira ID / internal ticket" -> omit entirely from customer text
- "appears to have been" -> "was confirmed to be"
- "should work / should resolve" -> "will [action] because [evidence]"
- "checking on this" -> "I am reviewing [specific artifact]"

VOICE RULES: sound like a real engineer writing naturally, not an AI template. Vary
sentence length. Use plain, direct words. Lead with facts and named artifacts, not
pleasantries. Avoid AI-sounding openers ("I wanted to reach out", "I hope this message
finds you well", "just following up to let you know") and filler ("please don't hesitate",
"at your earliest convenience", "kindly", "rest assured", "as per our conversation").
Never loosen the deadline, WWW, first-person, or banned-phrase rules for the sake of voice.

BUSINESS IMPACT: state impact proactively, never ask the customer for it, using the
formula "Until [issue] is resolved, [Rubrik capability] is impaired, which means
[business consequence in operational terms]." Use these mappings when applicable:
backup job failing -> extends recovery point exposure, risking RPO targets; archive
upload failing -> data not protected offsite, weakening data protection posture;
encryption rekey stuck -> compliance posture around key rotation at risk; node add
failure -> cluster at reduced capacity, weakening redundancy/recovery objectives; restore
failure -> cannot validate end-to-end recovery, business continuity risk; M365 backup
failure -> affected data not recoverable to latest scheduled point, potential compliance
exposure; GCS bucket creation failing -> cloud retention/cost-optimization workflows
blocked; cluster upgrade failing -> blocked from security patches/feature updates, aging
code line; download/checksum mismatch on upgrade -> blocked from deploying validated
release, holding cluster on current version.

SIGNATURE BLOCK (exact format, each line on its own line, one blank line before
"Coverage hours", first name only):
Best regards,
[Owner First Name]
[Owner Title], Rubrik Support

Coverage hours (Mon-Fri): [Coverage Hours]
Out-of-hours support: https://www.rubrik.com/support/#contact-numbers

IQS SELF-CHECK (append after the customer text, outside any code block): label it as an
estimate, not an official score. Only assess metrics applicable to this response type.
Thresholds: Meeting >= 80%, Partially Meeting 50-79%, Not Meeting < 50%. If a metric
would fall below Meeting, name the one concrete signal to add rather than rewriting the
draft. Format example:
IQS self-check (INTRO, estimate)
Business Impact 10/10 Meeting - all 4 signals
Technical Definition 7.5/10 Meeting - 6/8 signals (add repro step + scope)
WWW this comment 3/3 - What+Why+When present
Reliability - 1 valid commitment (follow-up line), on track
Clear Resolution - N/A at intro`;

const TEMPLATE_RULES: Record<Keyword, string> = {
  INTRO: `TEMPLATE: INTRO
Steps: greet by first name; state "I am [Owner Name] and I have taken full ownership of
this case"; restate the problem in your own words with named artifacts; state business
impact proactively; ask only for any additional impact context you still need; numbered
investigation steps (WHAT the step is + WHY it matters, no per-step deadlines); exactly
one follow-up commitment line before the signature using the same-day 6 PM commitment
reference date below; blank line; then the signature block.
Applicable self-check metrics: Business Impact, Technical Definition, WWW Quality,
Reliability. Clear Resolution is N/A.`,
  UPDATE: `TEMPLATE: UPDATE
Base this on the most recent comment, not the original Description. Steps: one-sentence
progress anchor (what changed since the last update — do not restate the original
issue); WHAT (action taken, named artifacts); WHY (technical reasoning tied to evidence);
one sentence on ongoing business risk; never restate a deadline that has already passed;
exactly one follow-up commitment line before the signature using the two-business-day
6 PM commitment reference date below; blank line; then the signature block.
Applicable self-check metrics: WWW Quality, Reliability, plus Business Impact and
Technical Definition only if still within the case's first 3 comments.`,
  FOLLOWUP: `TEMPLATE: FOLLOWUP (attempt {ATTEMPT} of 2)
Steps: greet by first name; one sentence naming exactly what is still outstanding, with
the named artifact; one sentence on why it matters now; then:
{ATTEMPT_BODY}
Exactly one follow-up commitment line before the signature; blank line; then the
signature block.
Applicable self-check metrics: WWW Quality, Reliability (the next-attempt commitment).
On attempt 2, note in the self-check whether a documented phone attempt exists anywhere
in the comment history — the 3-Strikes close requires at least one phone attempt before
a noresponse closure, and if none is logged, flag internally (not in the customer text)
that a phone call is still needed.`,
  CLOSURE: `TEMPLATE: CLOSURE ({PATH})
This is FINAL. Never ask the customer to confirm, never write "once confirmed I will
close." Base this on the FULL case comment history provided below, oldest to newest.
Produce TWO fenced code blocks: first the customer email, second the internal
resolution note (for the Salesforce Resolution field, never sent to the customer).
Customer email steps: greet by first name; state the root cause definitively ("was
confirmed to be", never "appears to have been"); numbered resolution steps with named
artifacts; quantified validation evidence; {PATH_LINE}; state the 30-day reopen window as
the absolute date given below; no follow-up commitment line and no confirmation
request — the close statement and reopen date replace them (closing comments are scored
on What+Why only, no When required); blank line; then the signature block.
Internal resolution note (plain text, light labels are fine, do not use this structure
in the customer email):
Root cause: [definitive, one to two lines]
Affected environment: [cluster ID, CDM/RSC version, workload, account]
Resolution steps:
1. [technical action with named artifact]
2. [technical action with named artifact]
Validation: [timestamps, consecutive success counts, cluster IDs]
Internal tracking reference: [if any; omit if none]
KB / documentation used: [links]
Prevention / follow-up: [recommended action, product feedback logged, or "none"]
Never put internal tracking references or identifiers in the customer email — only in
the internal note.
Applicable self-check metrics: Clear Resolution (4 signals), WWW Quality (What+Why
only). Business Impact and Technical Definition are already locked from earlier
comments (N/A here).`,
};

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
  const ownerFirstName = ownerName.split(" ")[0];
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
