/**
 * Layer 1: the deterministic IQS scorer.
 *
 * Pure functions over facts already in the cache. No network, no API key, no
 * model. That is the whole point of the layer: a score has to exist for every
 * case on every sync even when the Anthropic token is unset, so the queue
 * column and the Quality tab are never empty and never cost anything.
 *
 * What it can and cannot do, stated plainly because the UI repeats it: this
 * layer matches structure, not meaning. It can tell that a comment contains an
 * absolute deadline, a numbered step, a cluster ID and a "which means" clause.
 * It cannot tell whether the consequence named is the right one. Layer 2
 * (phase 3) reads for meaning and costs tokens; this one reads for shape and
 * costs nothing. Where a signal is genuinely undecidable from shape alone it
 * takes partial weight and says why, rather than guessing in either direction.
 *
 * The rubric lives in ./rubric. Nothing here redefines a dimension, a maximum,
 * a band or a banned phrase — it only decides whether the text earns them.
 */

import {
  APPLICABLE_DIMENSIONS,
  BANNED_PHRASES,
  BUSINESS_IMPACT_MAP,
  Band,
  Dimension,
  DimensionScope,
  Keyword,
  RUBRIC_VERSION,
  bandFor,
  overallScore,
} from "./rubric";
import { extractArtifacts } from "../artifacts";
import { parseCommitments } from "../commitments";
import { detectKeyword } from "../nextAction";

/* ----------------------------------------------------------------- inputs */

export interface CommentFacts {
  id: string;
  body: string;
  createdDate: string;
  isMine: boolean;
  isPublic: boolean;
  isInbound: boolean;
  source: string;
}

export interface CommitmentFacts {
  id: string;
  state: string;
  dueAt: string | null;
  sourceCommentId: string | null;
  rawText: string;
}

/** Everything the scorer is allowed to look at. Assembled by ./store. */
export interface CaseFacts {
  caseId: string;
  caseNumber: string;
  status: string | null;
  isClosed: boolean;
  subject: string | null;
  description: string | null;
  /** Every comment and email on the case, oldest first. */
  comments: CommentFacts[];
  commitments: CommitmentFacts[];
}

/* ---------------------------------------------------------------- outputs */

export interface SignalResult {
  label: string;
  /** 0..1. Fractional only where the evidence is genuinely partial. */
  weight: number;
  /** A short quote from my own text, so a score can be argued with. */
  evidence: string | null;
  note: string | null;
}

export interface DimensionResult {
  id: string;
  label: string;
  max: number;
  earned: number;
  fraction: number;
  band: Band;
  scope: DimensionScope;
  /** What the scorer actually read, in words. */
  basis: string;
  signals: SignalResult[];
}

export interface Violation {
  id: string;
  label: string;
  replacement: string;
  commentId: string;
  createdDate: string;
  match: string;
  excerpt: string;
}

export interface CommentWww {
  id: string;
  createdDate: string;
  isPublic: boolean;
  source: string;
  what: boolean;
  why: boolean;
  when: boolean;
  whenWaived: boolean;
  earned: number;
  excerpt: string;
}

export interface Layer1Score {
  caseId: string;
  caseNumber: string;
  keyword: Keyword;
  /**
   * The two halves of what produced this score, kept apart on purpose. The
   * rubric is what was applied; the scorer is the code that applied it. The
   * store keys its cache on the pair, but a reader chasing a wrong score wants
   * to see which is which, not a slash-joined string.
   */
  rubricVersion: string;
  scorerVersion: string;
  /** Dimension score out of 100 before language deductions. */
  base: number | null;
  /** Banned-phrase deduction, in points of 100. */
  penalty: number;
  overall: number | null;
  band: Band | null;
  dimensions: DimensionResult[];
  comments: CommentWww[];
  violations: Violation[];
  ownerComments: number;
  notes: string[];
  scoredAt: number;
}

/**
 * Bumped whenever this file's scoring changes shape — new signal, corrected
 * text handling, different arithmetic.
 *
 * A stored score depends on two things: the rubric it was read against and the
 * code that read it. RUBRIC_VERSION covers the first. Without this, editing a
 * scorer leaves every cached row silently wrong, because nothing marks it
 * stale. The cache key is the pair.
 *
 * l1.2 — strip the outbound email envelope before scoring (l1.1 read the
 * leading "From:" line as quoted history and discarded whole comments).
 * l1.3 — treat <div> and friends as line breaks (l1.2 left div-formatted mail
 * on a single line, so the envelope strip consumed the whole comment).
 * l1.4 — strip the run-together envelope too, for the bodies that are stored
 * as one line with no newlines anywhere.
 */
export const SCORER_VERSION = "l1.4";

/**
 * Each banned-phrase occurrence costs a point of the final 100, capped so that
 * one sloppy paragraph cannot swamp four dimensions of real work. The rubric
 * calls these auto-deducts without naming a number; the number is a scorer
 * decision and lives here, where it is visible, not buried in the rubric.
 */
export const BANNED_PENALTY_PER_HIT = 1;
export const BANNED_PENALTY_CAP = 10;

/* ------------------------------------------------------------ text hygiene */

const TAG = /<[^>]{0,400}>/g;
/**
 * Tags that end a line of prose. Outlook and the Salesforce email composer lay
 * paragraphs out with <div>, not <p>, so converting only <br> and </p> leaves
 * an entire message on one line — and every line-anchored rule downstream
 * (envelope, quote markers, signatures) then either matches everything or
 * nothing.
 */
const BLOCK =
  /<\/?(?:div|p|br|tr|li|ul|ol|table|h[1-6]|blockquote|section|article|header|footer|pre|hr)\b[^>]{0,200}>/gi;
/** CSS and script text is not prose; Outlook ships a <style> block on every mail. */
const NON_PROSE = /<(script|style)\b[^>]{0,200}>[\s\S]{0,40000}?<\/\1\s*>/gi;
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Case comments arrive as plain text, email bodies as whatever the customer's
 * client produced. Both go through the same door so a signal cannot depend on
 * which one it landed in.
 */
export function toPlainText(body: string): string {
  let t = body || "";
  if (t.includes("<")) t = t.replace(NON_PROSE, " ").replace(BLOCK, "\n").replace(TAG, " ");
  t = t.replace(/&[a-z#0-9]{2,8};/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
  return t.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

const HEADER_LINE = /^\s*(From|To|Cc|Bcc|Subject|Sent|Date|Reply-To|Importance)\s*:/i;
/** A folded address list continues the header above it: indented, and an address. */
const HEADER_FOLD = /^\s+\S/;
/**
 * The same envelope, run together on one line.
 *
 * Not every comment arrives with newlines — a good number are stored as a
 * single line with the headers and the first sentence separated only by
 * spaces, and a line-based strip either takes the whole comment or none of it.
 *
 * Only From/To/Cc/Bcc/Reply-To are matched, and only where the value is a
 * single whitespace-free token (one address, or a semicolon-joined list). That
 * is what makes it safe to run against prose: a sentence never follows the
 * word "To:" with an unbroken token and then another header key. Subject and
 * Date can contain spaces and are deliberately left to the line-based pass.
 */
const INLINE_ENVELOPE = /^\s*(?:(?:From|To|Cc|Bcc|Reply-To)\s*:[ \t]*\S+[ \t]*)+/i;

/**
 * Drop the envelope an outbound Salesforce email carries at the very top.
 *
 * Every email comment I send begins "From: support@rubrik.com / To: … / Cc: …".
 * That block is delivery metadata, authored by neither side, and it has to go
 * before anything else looks at the text — for two separate reasons. The first
 * `From:` line would otherwise read as the start of quoted history and take the
 * entire comment with it. And the Cc list is a run of email addresses that the
 * artifact extractor would happily count as technical detail I supplied.
 *
 * Only a block at the top counts. A `From:` further down is real quoted
 * history and is left for QUOTE_MARKERS to find.
 */
function stripEnvelope(text: string): string {
  // The run-together form first. It is anchored and single-line, so on a normal
  // multi-line mail it takes the first header and leaves the rest to the loop.
  const inlined = text.replace(INLINE_ENVELOPE, "");
  const lines = inlined.split("\n");
  let i = 0;
  let sawHeader = inlined !== text;

  while (i < lines.length) {
    const line = lines[i];
    if (HEADER_LINE.test(line)) {
      sawHeader = true;
      i++;
      continue;
    }
    // Blank lines pad the block; before any header they are just leading space.
    if (!line.trim()) {
      i++;
      continue;
    }
    // A wrapped Cc list, but never an indented first sentence of the body.
    if (sawHeader && HEADER_FOLD.test(line) && line.includes("@") && !/[.!?]/.test(line)) {
      i++;
      continue;
    }
    break;
  }

  // `text` unchanged rather than the rejoin, so a body with no envelope at all
  // keeps its exact original spacing.
  return sawHeader ? lines.slice(i).join("\n") : text;
}

const QUOTE_MARKERS = [
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^\s*From:\s.+$/im,
  /^\s*On .{3,80}wrote:\s*$/im,
  /^\s*_{10,}\s*$/m,
];

const SIGNATURE_MARKERS = [
  /^\s*Best regards,\s*$/im,
  /^\s*Coverage hours\b/im,
  /^\s*Kind regards,\s*$/im,
  /^\s*Thanks,\s*$/im,
];

function cutAtFirst(text: string, markers: RegExp[]): string {
  let cut = text.length;
  for (const re of markers) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return cut === text.length ? text : text.slice(0, cut);
}

/**
 * The words I actually wrote in one comment.
 *
 * A reply that quotes the customer's mail carries their sentences too, and a
 * signature block carries a URL and the word "support" on every single
 * comment. Scoring either would credit or punish text nobody authored for this
 * case, so both are cut before any signal runs.
 */
export function ownText(body: string): string {
  // Envelope first, or its own From: line reads as quoted history and the
  // whole comment disappears.
  const plain = stripEnvelope(toPlainText(body));
  // Quoted history next: a signature marker inside the quote must not be the
  // cut point for the whole comment.
  const unquoted = cutAtFirst(plain, QUOTE_MARKERS);
  return cutAtFirst(unquoted, SIGNATURE_MARKERS).trim();
}

function excerpt(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** The sentence a match landed in, trimmed for display. */
function sentenceAround(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf(".", index) + 1);
  const dot = text.indexOf(".", index + length);
  const end = dot === -1 ? Math.min(text.length, index + length + 120) : dot + 1;
  return excerpt(text.slice(start, end));
}

/** First match of `re` in `text`, returned as a display-ready quote. */
function quote(text: string, re: RegExp): string | null {
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  rx.lastIndex = 0;
  const m = rx.exec(text);
  return m ? sentenceAround(text, m.index, m[0].length) : null;
}

function has(text: string, re: RegExp): boolean {
  const rx = new RegExp(re.source, re.flags.replace("g", ""));
  return rx.test(text);
}

/* ---------------------------------------------------------------- keyword */

/**
 * Which response type the case's current posture calls for, decided from
 * cached rows.
 *
 * Phase 4 moved the actual derivation to ../nextAction, which drafting
 * (claude.ts) and the queue's Next Action column also call, so all three can
 * no longer disagree. This stays as the entry point cached rows go through
 * because CommentFacts is already exactly the shape that derivation needs.
 */
export function detectKeywordFromComments(
  status: string | null,
  comments: CommentFacts[],
): Keyword {
  return detectKeyword(status, comments).keyword;
}

/* --------------------------------------------------------- banned phrases */

interface Span {
  start: number;
  end: number;
  phraseIndex: number;
  match: string;
}

/**
 * Banned phrases in one comment, with overlaps collapsed.
 *
 * The rubric keeps overlapping patterns on purpose ("as soon as possible"
 * matches two entries) and says collapsing is the scorer's job. Longest span
 * wins; an exact tie goes to the earlier rubric entry, so the result does not
 * depend on match order.
 */
export function findBannedPhrases(text: string): Array<{ phraseIndex: number; start: number; end: number; match: string }> {
  const spans: Span[] = [];
  BANNED_PHRASES.forEach((p, phraseIndex) => {
    const rx = new RegExp(p.pattern.source, p.pattern.flags.includes("g") ? p.pattern.flags : p.pattern.flags + "g");
    rx.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, phraseIndex, match: m[0] });
      if (m.index === rx.lastIndex) rx.lastIndex++;
    }
  });

  spans.sort((a, b) => {
    const lenDiff = b.end - b.start - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    if (a.phraseIndex !== b.phraseIndex) return a.phraseIndex - b.phraseIndex;
    return a.start - b.start;
  });

  const kept: Span[] = [];
  for (const s of spans) {
    if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/**
 * Tier 1 of phase 5's auto-repair: every banned phrase already names its own
 * required replacement in the rubric, so fixing one is a substitution, not a
 * decision. Free, deterministic, and safe to run before ever reaching for a
 * model -- the common case (a stray banned phrase, nothing else wrong) never
 * spends a token.
 */
export function mechanicalRepair(text: string): { text: string; fixedCount: number } {
  let out = text;
  let fixedCount = 0;
  for (const p of BANNED_PHRASES) {
    const rx = new RegExp(p.pattern.source, p.pattern.flags.includes("g") ? p.pattern.flags : p.pattern.flags + "g");
    out = out.replace(rx, () => {
      fixedCount++;
      return p.replacement;
    });
  }
  return { text: out, fixedCount };
}

/* ---------------------------------------------------------------- signals */

const ASKS_FOR_IMPACT =
  /\b(?:can|could|would)\s+you\s+(?:please\s+)?(?:share|provide|confirm|clarify|let me know|elaborate)[^.?]{0,60}\b(?:impact|affect)|what\s+(?:is|'s)\s+the\s+(?:business\s+)?impact|how\s+(?:is|are)\s+(?:this|these|it)\s+(?:impact|affect)/i;

const IMPACT_STATEMENT =
  /\b(?:until\b[^.]{0,200}\b(?:is|are)\s+(?:impaired|impacted|unavailable|blocked|at risk)|this\s+(?:means|impacts|affects)\b|business\s+impact\b|which\s+means\b|the\s+impact\s+(?:is|of)\b)/i;

const UNTIL_CLAUSE = /\buntil\b[^.]{0,240}\b(?:impaired|impacted|unavailable|blocked|degraded|at risk|cannot|unable)\b/i;
const WHICH_MEANS = /\bwhich\s+means\b/i;

const CAPABILITY =
  /\b(?:backup|backups|archival|archive|archiving|replication|replicat\w+|restore|restores|recovery|snapshot|snapshots|retention|SLA domain|protection|indexing|live mount|instant recovery|export|failover|cloud[- ]native protection|key rotation|rekey|upgrade|cluster expansion|node add|threat hunt|ransomware investigation|anomaly detection)\b/i;

const BUSINESS_CONSEQUENCE = new RegExp(
  [
    "\\bRPO\\b",
    "\\bRTO\\b",
    "\\brecovery point\\b",
    "\\bbusiness continuity\\b",
    "\\bcompliance\\b",
    "\\bregulatory\\b",
    "\\baudit\\b",
    "\\bdata protection posture\\b",
    "\\bredundancy\\b",
    "\\bsecurity patch(?:es)?\\b",
    "\\bunprotected\\b",
    "\\bnot protected\\b",
    "\\bnot recoverable\\b",
    "\\bexposure\\b",
    "\\bretention (?:policy|target|requirement)",
    "\\bcannot validate\\b",
    "\\bservice level\\b",
  ].join("|"),
  "i",
);

/** Consequence phrasings the rubric itself supplies, used as extra evidence. */
const MAPPED_CONSEQUENCES = Object.values(BUSINESS_IMPACT_MAP);

const NUMBERED_STEP = /^\s{0,4}\d{1,2}[.)]\s+\S/gm;

const SCOPE_LANGUAGE =
  /\b(?:\d{1,6}\s+(?:of|out of)\s+\d{1,6}|all\s+\d{1,6}\s+\w+|only\s+the\s+\w+|limited to\b|isolated to\b|across\s+\d{1,6}\s+\w+|affect(?:s|ed|ing)\s+\d{1,6}\s+\w+|\d{1,6}\s+(?:nodes?|clusters?|jobs?|VMs?|objects?|filesets?|mailboxes?|sites?|users?|databases?|volumes?|shares?|snapshots?))\b/i;

const REPRO_LANGUAGE =
  /\b(?:to reproduce|reproduc(?:e|ed|ible|ing)|steps taken|steps to|when (?:I|we|you) (?:run|ran|trigger|triggered|start|started)|repeated the|re-?ran)\b/i;

const ERROR_CODE_TEXT = /\b(?:error|err|status|exception|code)\s*[:#=]?\s*[A-Z][A-Z0-9_]{2,}\b|\b[A-Z]{2,}[-_]\d{3,}\b/;

const TIMELINE_LANGUAGE =
  /\b(?:20\d\d-\d\d-\d\d|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}\s*(?:AM|PM|UTC|ET|PT)|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}|since\s+(?:\d|the|last|yesterday)|first (?:observed|occurred|seen)|started (?:on|at)|between\s+\d)/i;

const ENVIRONMENT =
  /\b(?:CDM|RSC|Polaris|Andes|AWS|Azure|GCP|GCS|S3|VMware|vSphere|vCenter|ESXi|Hyper-?V|Nutanix|AHV|SQL Server|MSSQL|Oracle|SAP HANA|Db2|MongoDB|NAS|Isilon|NetApp|Windows|Linux|RHEL|CentOS|Ubuntu|M365|Microsoft 365|Office 365|Exchange|SharePoint|OneDrive|Salesforce|Kubernetes|EKS|AKS|GKE)\b/;

const WHAT_DONE =
  /\b(?:I|we)\s+(?:have\s+)?(?:reviewed|checked|confirmed|analy[sz]ed|ran|run|collected|gathered|escalated|applied|updated|verified|identified|found|traced|compared|reproduced|opened|tested|restarted|upgraded|removed|added|configured|examined|inspected|pulled|validated|corrected|cleared|disabled|enabled|raised|completed|deployed)\b|\b(?:the|these)\s+(?:logs?|bundle|trace|output|report)\s+(?:show|showed|confirm|confirmed|indicate|indicated)\b/i;

const WHY_REASON =
  /\b(?:because|since\s+the|which\s+(?:indicates|confirms|means|points to|explains)|this\s+(?:means|indicates|suggests|confirms|explains|points to)|in order to|so that|to\s+(?:determine|confirm|isolate|rule out|validate|identify|establish|narrow)|the reason|due to|as a result|root cause)\b/i;

const ROOT_CAUSE_DEFINITE =
  /\b(?:root cause\s+(?:was|is)\b|was confirmed to be\b|the cause\s+(?:was|is)\b|caused by\b|traced to\b|resulted from\b|stemmed from\b)/i;

const HEDGE = /\b(?:appears?\s+to\s+have\s+been|appears?\s+to\s+be|likely\s+(?:caused|due)|probably|might\s+have|may\s+have\s+been|possibly|we think|seems to)\b/i;

const VALIDATION_QUANTIFIED =
  /\b(?:\d{1,4}\s+consecutive|\d{1,4}\s+successful|\d{1,4}\s+(?:jobs?|runs?|backups?|snapshots?|restores?)\s+(?:completed|succeeded|passed)|success rate of\s+\d|completed\s+(?:in|at)\s+\d|\d{1,3}%\s+(?:success|complete))\b/i;

const REOPEN_WINDOW = /\b(?:re-?open(?:ed|ing)?)\b/i;
const ABSOLUTE_DATE =
  /\b(?:20\d\d-\d\d-\d\d|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*20\d\d)?)\b/;

/* ------------------------------------------------------------- dimensions */

interface MyComment extends CommentFacts {
  text: string;
}

function signal(label: string, weight: number, evidence: string | null, note: string | null = null): SignalResult {
  return { label, weight: Math.max(0, Math.min(1, weight)), evidence, note };
}

function assemble(d: Dimension, basis: string, signals: SignalResult[]): DimensionResult {
  const fraction = signals.length
    ? signals.reduce((sum, s) => sum + s.weight, 0) / signals.length
    : 0;
  return {
    id: d.id,
    label: d.label,
    max: d.max,
    earned: Math.round(d.max * fraction * 100) / 100,
    fraction,
    band: bandFor(fraction),
    scope: d.scope,
    basis,
    signals,
  };
}

/**
 * The window the `first3` dimensions are read from.
 *
 * The rubric puts business impact and technical definition in the case's first
 * three comments. When the customer posts three times before I get a word in,
 * my opening still is my opening, so it is included even if it falls outside
 * that window. Anything later is a case that took too long to define itself,
 * and it scores that way.
 */
function openingWindow(all: CommentFacts[], mine: MyComment[]): MyComment[] {
  const firstThreeIds = new Set(all.slice(0, 3).map((c) => c.id));
  const inWindow = mine.filter((c) => firstThreeIds.has(c.id));
  if (inWindow.length) return inWindow;
  return mine.length ? [mine[0]] : [];
}

function scoreBusinessImpact(d: Dimension, window: MyComment[], all: CommentFacts[]): DimensionResult {
  const text = window.map((c) => c.text).join("\n\n");
  const basis = window.length
    ? `${window.length} of my comment${window.length === 1 ? "" : "s"} in the case's opening (first ${Math.min(3, all.length)} entries)`
    : "no comment of mine to read";

  const asks = ASKS_FOR_IMPACT.exec(text);
  const stated = IMPACT_STATEMENT.exec(text);

  const s1 = stated && !asks
    ? signal(d.signals[0], 1, sentenceAround(text, stated.index, stated[0].length))
    : signal(
        d.signals[0],
        0,
        asks ? sentenceAround(text, asks.index, asks[0].length) : null,
        asks ? "impact was asked of the customer instead of stated" : "no impact statement found",
      );

  const until = UNTIL_CLAUSE.exec(text);
  const means = WHICH_MEANS.exec(text);
  const s2 = until && means
    ? signal(d.signals[1], 1, sentenceAround(text, until.index, until[0].length))
    : signal(
        d.signals[1],
        until || means ? 0.5 : 0,
        until ? sentenceAround(text, until.index, until[0].length)
          : means ? sentenceAround(text, means.index, means[0].length) : null,
        until && !means ? 'the "which means" consequence clause is missing'
          : means && !until ? 'the "until ... is impaired" clause is missing'
          : "neither half of the formula is present",
      );

  const cap = CAPABILITY.exec(text);
  const s3 = cap
    ? signal(d.signals[2], 1, sentenceAround(text, cap.index, cap[0].length))
    : signal(d.signals[2], 0, null, "no named Rubrik capability in the impact statement");

  const mapped = MAPPED_CONSEQUENCES.find((c) => text.toLowerCase().includes(c.toLowerCase()));
  const consequence = BUSINESS_CONSEQUENCE.exec(text);
  const s4 = mapped
    ? signal(d.signals[3], 1, excerpt(mapped), "matches a rubric consequence mapping")
    : consequence
    ? signal(d.signals[3], 1, sentenceAround(text, consequence.index, consequence[0].length))
    : signal(d.signals[3], 0, null, "consequence not stated in operational terms");

  return assemble(d, basis, [s1, s2, s3, s4]);
}

function scoreTechnicalDefinition(d: Dimension, window: MyComment[], all: CommentFacts[]): DimensionResult {
  const text = window.map((c) => c.text).join("\n\n");
  const basis = window.length
    ? `${window.length} of my comment${window.length === 1 ? "" : "s"} in the case's opening (first ${Math.min(3, all.length)} entries)`
    : "no comment of mine to read";

  const artifacts = extractArtifacts(text);
  const kinds = new Set(artifacts.map((a) => a.kind));
  const named = artifacts.filter((a) =>
    ["cluster_id", "cluster_name", "log_bundle", "bucket", "job_id", "ip", "jira"].includes(a.kind),
  );

  const numbered = text.match(NUMBERED_STEP) || [];
  const errorText = ERROR_CODE_TEXT.exec(text);
  const scopeM = SCOPE_LANGUAGE.exec(text);
  const reproM = REPRO_LANGUAGE.exec(text);
  const timeM = TIMELINE_LANGUAGE.exec(text);
  const envM = ENVIRONMENT.exec(text);

  const signals = [
    named.length
      ? signal(d.signals[0], 1, named.slice(0, 3).map((a) => a.value).join(", "))
      : signal(d.signals[0], 0, null, "no cluster, bundle, job or host named"),

    kinds.has("error_code")
      ? signal(d.signals[1], 1, artifacts.filter((a) => a.kind === "error_code").slice(0, 3).map((a) => a.value).join(", "))
      : errorText
      ? signal(d.signals[1], 1, sentenceAround(text, errorText.index, errorText[0].length))
      : signal(d.signals[1], 0, null, "no error code quoted"),

    scopeM
      ? signal(d.signals[2], 1, sentenceAround(text, scopeM.index, scopeM[0].length))
      : signal(d.signals[2], 0, null, "how much is affected is not quantified"),

    reproM || numbered.length >= 2
      ? signal(
          d.signals[3],
          1,
          reproM ? sentenceAround(text, reproM.index, reproM[0].length) : excerpt(numbered.slice(0, 2).join(" ")),
        )
      : signal(d.signals[3], 0, null, "no reproduction or investigation steps"),

    kinds.has("version")
      ? signal(d.signals[4], 1, artifacts.filter((a) => a.kind === "version").slice(0, 2).map((a) => a.value).join(", "))
      : signal(d.signals[4], 0, null, "no software version"),

    kinds.has("cluster_id")
      ? signal(d.signals[5], 1, artifacts.filter((a) => a.kind === "cluster_id").slice(0, 2).map((a) => a.value).join(", "))
      : signal(d.signals[5], 0, null, "no cluster ID"),

    timeM
      ? signal(d.signals[6], 1, sentenceAround(text, timeM.index, timeM[0].length))
      : signal(d.signals[6], 0, null, "no dates or times anchoring the problem"),

    envM
      ? signal(d.signals[7], 1, sentenceAround(text, envM.index, envM[0].length))
      : kinds.has("node_count")
      ? signal(d.signals[7], 1, artifacts.filter((a) => a.kind === "node_count")[0].value)
      : signal(d.signals[7], 0, null, "platform or workload not named"),
  ];

  return assemble(d, basis, signals);
}

function scoreWww(d: Dimension, mine: MyComment[], keyword: Keyword): { dim: DimensionResult; perComment: CommentWww[] } {
  const perComment: CommentWww[] = mine.map((c) => {
    const what = has(c.text, WHAT_DONE);
    const why = has(c.text, WHY_REASON);
    // The "When" point is a commitment with an absolute time, read by the same
    // parser that later decides whether it was met. One definition of a
    // deadline, so the two dimensions cannot disagree about one sentence.
    const commitments = safeParseCommitments(c.text, c.createdDate);
    const when = commitments.some((p) => p.dueAt);
    // Closure comments are scored on What and Why only: the close statement and
    // the reopen date replace the follow-up commitment, so requiring a "when"
    // would penalise following the rubric.
    const whenWaived = keyword === "CLOSURE" && c.id === mine[mine.length - 1]?.id;
    const points = (what ? 1 : 0) + (why ? 1 : 0) + (when || whenWaived ? 1 : 0);
    return {
      id: c.id,
      createdDate: c.createdDate,
      isPublic: c.isPublic,
      source: c.source,
      what,
      why,
      when,
      whenWaived: whenWaived && !when,
      earned: points,
      excerpt: excerpt(c.text, 220),
    };
  });

  const basis = perComment.length
    ? `${perComment.length} comment${perComment.length === 1 ? "" : "s"} of mine, averaged`
    : "no comment of mine to read";

  const mean = perComment.length
    ? perComment.reduce((sum, c) => sum + c.earned, 0) / (perComment.length * d.max)
    : 0;

  const count = (fn: (c: CommentWww) => boolean) => perComment.filter(fn).length;
  const n = perComment.length || 1;
  const signals = [
    signal(d.signals[0], count((c) => c.what) / n, null, `${count((c) => c.what)} of ${perComment.length} comments name an action taken`),
    signal(d.signals[1], count((c) => c.why) / n, null, `${count((c) => c.why)} of ${perComment.length} give the reasoning`),
    signal(
      d.signals[2],
      count((c) => c.when || c.whenWaived) / n,
      null,
      `${count((c) => c.when)} of ${perComment.length} carry a dated next step` +
        (count((c) => c.whenWaived) ? ", 1 waived at closure" : ""),
    ),
  ];

  // The signal means are the same number as the per-comment mean by
  // construction; assemble() is used anyway so banding stays in one place.
  const dim = assemble(d, basis, signals);
  dim.earned = Math.round(mean * d.max * 100) / 100;
  dim.fraction = mean;
  dim.band = bandFor(mean);
  return { dim, perComment };
}

function scoreReliability(d: Dimension, facts: CaseFacts, mine: MyComment[]): DimensionResult {
  const commitments = facts.commitments;
  const live = commitments.filter((c) => c.state !== "dismissed" && c.state !== "superseded");
  const byComment = new Map<string, number>();
  for (const c of live) {
    if (!c.sourceCommentId) continue;
    byComment.set(c.sourceCommentId, (byComment.get(c.sourceCommentId) || 0) + 1);
  }

  const commented = [...byComment.entries()];
  const crowded = commented.filter(([, n]) => n > 1);
  const exactlyOne = commented.filter(([, n]) => n === 1);

  const basis = live.length
    ? `${live.length} commitment${live.length === 1 ? "" : "s"} across ${commented.length || 1} comment${commented.length === 1 ? "" : "s"}`
    : "no commitment recorded on this case";

  const s1 = !commented.length
    ? signal(d.signals[0], 0, null, "no follow-up commitment has been made")
    : crowded.length
    ? signal(d.signals[0], exactlyOne.length / commented.length, null, `${crowded.length} comment${crowded.length === 1 ? "" : "s"} carry more than one deadline`)
    : signal(d.signals[0], 1, null, `${exactlyOne.length} comment${exactlyOne.length === 1 ? "" : "s"}, one deadline each`);

  const unparsed = live.filter((c) => !c.dueAt);
  const dated = live.filter((c) => c.dueAt);
  const s2 = !live.length
    ? signal(d.signals[1], 0, null, "nothing to date")
    : unparsed.length
    ? signal(d.signals[1], dated.length / live.length, excerpt(unparsed[0].rawText), `${unparsed.length} promise${unparsed.length === 1 ? "" : "s"} with no absolute date and time`)
    : signal(d.signals[1], 1, excerpt(dated[0].rawText));

  const breached = live.filter((c) => c.state === "breached");
  const met = live.filter((c) => c.state === "met");
  const s3 = breached.length
    ? signal(d.signals[2], 0, excerpt(breached[0].rawText), `${breached.length} deadline${breached.length === 1 ? "" : "s"} passed unmet`)
    : signal(d.signals[2], 1, null, "nothing outstanding is overdue");

  const resolved = met.length + breached.length;
  const s4 = resolved
    ? signal(d.signals[3], met.length / resolved, null, `${met.length} of ${resolved} met when they came due`)
    : signal(d.signals[3], 0.5, null, "no commitment has come due yet, so there is nothing to prove either way");

  const dim = assemble(d, basis, [s1, s2, s3, s4]);
  if (!mine.length) dim.basis = "no comment of mine to read";
  return dim;
}

function scoreClearResolution(d: Dimension, mine: MyComment[]): DimensionResult {
  const closing = [...mine].reverse().find((c) => c.isPublic) || mine[mine.length - 1];
  const text = closing ? closing.text : "";
  const basis = closing ? "my closing comment" : "no closing comment of mine to read";

  const cause = ROOT_CAUSE_DEFINITE.exec(text);
  const hedged = HEDGE.exec(text);
  const s1 = cause && !hedged
    ? signal(d.signals[0], 1, sentenceAround(text, cause.index, cause[0].length))
    : cause && hedged
    ? signal(d.signals[0], 0.5, sentenceAround(text, hedged.index, hedged[0].length), "a root cause is given but hedged")
    : signal(d.signals[0], 0, null, "no definitive root cause statement");

  const numbered = text.match(NUMBERED_STEP) || [];
  const stepText = numbered.join(" ");
  const stepArtifacts = extractArtifacts(text);
  const s2 = numbered.length >= 2 && stepArtifacts.length
    ? signal(d.signals[1], 1, excerpt(stepText, 180))
    : numbered.length >= 2
    ? signal(d.signals[1], 0.5, excerpt(stepText, 180), "steps are numbered but name no artifact")
    : signal(d.signals[1], 0, null, "resolution steps are not numbered");

  const valid = VALIDATION_QUANTIFIED.exec(text);
  const s3 = valid
    ? signal(d.signals[2], 1, sentenceAround(text, valid.index, valid[0].length))
    : signal(d.signals[2], 0, null, "no counted or measured validation evidence");

  const reopen = REOPEN_WINDOW.exec(text);
  const s4 = reopen && ABSOLUTE_DATE.test(text)
    ? signal(d.signals[3], 1, sentenceAround(text, reopen.index, reopen[0].length))
    : reopen
    ? signal(d.signals[3], 0.5, sentenceAround(text, reopen.index, reopen[0].length), "a reopen window is offered without an absolute date")
    : signal(d.signals[3], 0, null, "no reopen window");

  return assemble(d, basis, [s1, s2, s3, s4]);
}

/**
 * parseCommitments() runs date arithmetic over customer-shaped text. A single
 * malformed sentence must not take down a sync, so a failure here means "no
 * commitment found", not an exception.
 */
function safeParseCommitments(text: string, createdDate: string) {
  try {
    const at = new Date(createdDate);
    if (Number.isNaN(at.getTime())) return [];
    return parseCommitments(text, at);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ score */

/**
 * `keywordOverride` bypasses `detectKeywordFromComments()` -- the same override
 * pattern `iqs/layer2.ts`'s model scorer already uses, and now what phase 5's
 * draft preview uses too, so a forced keyword scores exactly as it would draft.
 */
export function scoreCase(facts: CaseFacts, keywordOverride?: Keyword): Layer1Score {
  const all = [...facts.comments].sort((a, b) => a.createdDate.localeCompare(b.createdDate));
  const mine: MyComment[] = all
    .filter((c) => c.isMine && c.body.trim())
    .map((c) => ({ ...c, text: ownText(c.body) }))
    .filter((c) => c.text.length > 0);

  const keyword = keywordOverride || detectKeywordFromComments(facts.status, all);
  const applicable = APPLICABLE_DIMENSIONS[keyword];
  const window = openingWindow(all, mine);
  const notes: string[] = [];

  const dimensions: DimensionResult[] = [];
  let wwwComments: CommentWww[] = [];

  for (const d of applicable) {
    if (d.id === "businessImpact") dimensions.push(scoreBusinessImpact(d, window, all));
    else if (d.id === "technicalDefinition") dimensions.push(scoreTechnicalDefinition(d, window, all));
    else if (d.id === "www") {
      const { dim, perComment } = scoreWww(d, mine, keyword);
      dimensions.push(dim);
      wwwComments = perComment;
    } else if (d.id === "reliability") dimensions.push(scoreReliability(d, facts, mine));
    else if (d.id === "clearResolution") dimensions.push(scoreClearResolution(d, mine));
  }

  // Banned phrases are a customer-facing language rule, so internal notes are
  // exempt: nobody is harmed by the word "Jira" in a note only I read.
  const violations: Violation[] = [];
  for (const c of mine) {
    if (!c.isPublic) continue;
    for (const s of findBannedPhrases(c.text)) {
      const p = BANNED_PHRASES[s.phraseIndex];
      violations.push({
        id: p.id,
        label: p.label,
        replacement: p.replacement,
        commentId: c.id,
        createdDate: c.createdDate,
        match: s.match,
        excerpt: sentenceAround(c.text, s.start, s.end - s.start),
      });
    }
  }

  const penalty = Math.min(BANNED_PENALTY_CAP, violations.length * BANNED_PENALTY_PER_HIT);

  let base: number | null = null;
  let overall: number | null = null;
  let band: Band | null = null;

  if (!mine.length) {
    notes.push("Nothing of mine on this case yet, so there is nothing to score.");
  } else {
    base = overallScore(dimensions.map((d) => ({ id: d.id, earned: d.earned })));
    if (base !== null) {
      base = Math.round(base * 10) / 10;
      overall = Math.round(Math.max(0, base - penalty) * 10) / 10;
      band = bandFor(overall / 100);
    }
  }

  if (window.length && !all.slice(0, 3).some((c) => window.some((w) => w.id === c.id))) {
    notes.push("The customer wrote three times before my first reply, so my opening comment was read outside the usual first-three window.");
  }
  if (keyword === "CLOSURE" && !facts.isClosed) {
    notes.push("Scored as a closure: the case status reads closed-side, or three of my comments have gone unanswered.");
  }

  return {
    caseId: facts.caseId,
    caseNumber: facts.caseNumber,
    keyword,
    rubricVersion: RUBRIC_VERSION,
    scorerVersion: SCORER_VERSION,
    base,
    penalty,
    overall,
    band,
    dimensions,
    comments: wwwComments,
    violations,
    ownerComments: mine.length,
    notes,
    scoredAt: Date.now(),
  };
}

/** The synthetic comment id `iqs/store.ts:previewDraftScore()` scores a staged draft under. */
export const DRAFT_PREVIEW_ID = "draft-preview";

/**
 * Turns a preview score into repair instructions a model can act on --
 * concrete rubric findings, not "make it better." Only the staged draft's own
 * findings are relevant; a gap on an already-posted comment is not something
 * rewriting the draft can fix.
 */
export function repairNotesFor(score: Layer1Score): string[] {
  const notes: string[] = [];

  for (const v of score.violations) {
    if (v.commentId !== DRAFT_PREVIEW_ID) continue;
    notes.push(`Replace the banned phrase "${v.match}" with: ${v.replacement}`);
  }

  const www = score.comments.find((c) => c.id === DRAFT_PREVIEW_ID);
  if (www) {
    if (!www.what) notes.push("Add an explicit What: state plainly what was done or found.");
    if (!www.why) notes.push("Add an explicit Why: state why that action was taken, or what it means for the customer.");
    if (!www.when && !www.whenWaived) notes.push("Add an explicit When: name the specific date/time the next step lands.");
  }

  for (const d of score.dimensions) {
    for (const s of d.signals) {
      if (s.weight < 1 && s.note) notes.push(`${d.label}: ${s.note}`);
    }
  }

  return notes;
}
