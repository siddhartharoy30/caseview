/**
 * The IQS rubric, in one place.
 *
 * Rubrik scores case comments against an internal quality rubric ("Internal
 * Quality Standards"). Until now the rule text lived inside claude.ts as prose
 * aimed at the model. The scorer needs the same rules as data, and a second
 * copy would drift from the first the moment either changed, so both forms live
 * here and the machine-readable form is the source the prose is rendered from
 * wherever rendering can be exact.
 *
 * Two shapes, one truth:
 *   - BANNED_PHRASES, BANDS and DIMENSIONS render their own prose. Change the
 *     data and the system prompt changes with it.
 *   - BUSINESS_IMPACT_PROSE is kept verbatim because its line wrapping is hand
 *     set and no generic wrapper reproduces it byte for byte. It is tied to
 *     BUSINESS_IMPACT_MAP by assertRubricConsistency() instead, which runs at
 *     import and fails loudly rather than letting the two drift quietly.
 *
 * Anything reading the rubric imports from here. claude.ts holds no copy.
 */

export const RUBRIC_VERSION = "fy27.1.5.0";

export type Keyword = "INTRO" | "UPDATE" | "FOLLOWUP" | "CLOSURE";

/** Score thresholds, as fractions of the applicable maximum. */
export const BANDS = { meeting: 0.8, partial: 0.5 } as const;

export type Band = "meeting" | "partial" | "not_meeting";

/** Which band a 0..1 fraction falls in. The scorer and the UI share this. */
export function bandFor(fraction: number): Band {
  if (fraction >= BANDS.meeting) return "meeting";
  if (fraction >= BANDS.partial) return "partial";
  return "not_meeting";
}

export const BAND_LABELS: Record<Band, string> = {
  meeting: "Meeting",
  partial: "Partially Meeting",
  not_meeting: "Not Meeting",
};

/**
 * Phrases that cost score on sight.
 *
 * `pattern` is what the deterministic scorer matches, `label` is how the phrase
 * is written in the rubric prose, and `replacement` is the instruction given in
 * that prose and echoed back in a violation. Patterns are deliberately a little
 * broader than the labels: "we'll keep you updated" has to be caught as surely
 * as the canonical "we will keep you posted".
 *
 * Entries 3 and 4 overlap on "as soon as possible" on purpose. Collapsing
 * overlapping spans is the scorer's job; the rubric stays declarative.
 */
export interface BannedPhrase {
  id: string;
  label: string;
  replacement: string;
  pattern: RegExp;
}

export const BANNED_PHRASES: BannedPhrase[] = [
  {
    id: "engage-engineering",
    label: "engage our engineering team",
    replacement: '"I will escalate internally and drive [specific action]"',
    pattern: /\bengage\s+(?:our|the)\s+engineering\s+team\b/gi,
  },
  {
    id: "keep-you-posted",
    label: "we will keep you posted/updated",
    replacement: "give an absolute deadline instead",
    pattern: /\bwe(?:'ll|’ll| will)\s+keep\s+you\s+(?:posted|updated|informed)\b/gi,
  },
  {
    id: "as-soon-as",
    label: "as soon as Engineering provides",
    replacement: "give an absolute deliverable date instead",
    pattern: /\bas\s+soon\s+as\s+(?:engineering|the\s+engineering\s+team|we\s+hear|i\s+hear|possible)\b/gi,
  },
  {
    id: "vague-timing",
    label: "promptly / shortly / ASAP / soon",
    replacement: "give an absolute time instead",
    pattern: /\b(?:promptly|shortly|ASAP|as soon as possible|soon)\b/gi,
  },
  {
    id: "known-issue",
    label: "known issue / known behavior",
    replacement: '"a transient backend state that has been mitigated"',
    pattern: /\bknown\s+(?:issue|behaviou?r|problem)\b/gi,
  },
  {
    id: "internal-tracking",
    label: "Jira / Jira ID / internal ticket",
    replacement: "omit entirely from customer text",
    pattern: /\b(?:jira(?:\s+id)?|internal\s+ticket)\b/gi,
  },
  {
    id: "appears-to-have",
    label: "appears to have been",
    replacement: '"was confirmed to be"',
    pattern: /\bappears?\s+to\s+have\s+been\b/gi,
  },
  {
    id: "should-work",
    label: "should work / should resolve",
    replacement: '"will [action] because [evidence]"',
    pattern: /\bshould\s+(?:work|resolve|fix|help|address)\b/gi,
  },
  {
    id: "checking-on-this",
    label: "checking on this",
    replacement: '"I am reviewing [specific artifact]"',
    pattern: /\bchecking\s+on\s+(?:this|it|that)\b/gi,
  },
];

/**
 * Symptom to business consequence. The drafter is told to use the mapping and
 * the scorer checks whether the consequence actually landed.
 */
export const BUSINESS_IMPACT_MAP: Record<string, string> = {
  "backup job failing": "extends recovery point exposure, risking RPO targets",
  "archive upload failing": "data not protected offsite, weakening data protection posture",
  "encryption rekey stuck": "compliance posture around key rotation at risk",
  "node add failure": "cluster at reduced capacity, weakening redundancy/recovery objectives",
  "restore failure": "cannot validate end-to-end recovery, business continuity risk",
  "M365 backup failure":
    "affected data not recoverable to latest scheduled point, potential compliance exposure",
  "GCS bucket creation failing": "cloud retention/cost-optimization workflows blocked",
  "cluster upgrade failing": "blocked from security patches/feature updates, aging code line",
  "download/checksum mismatch on upgrade":
    "blocked from deploying validated release, holding cluster on current version",
};

/**
 * The scored dimensions.
 *
 * `scope` says what a single score covers, which decides what the scorer feeds
 * it: `first3` looks at a case's first three comments only, `everyOwnerComment`
 * scores each of my comments on its own, `case` is derived from case-level rows
 * (commitments), and `closure` applies only to a closing comment.
 *
 * `appliesTo` drives the "Applicable self-check metrics" line in each template,
 * and drives which dimensions count toward an overall score. A dimension that
 * does not apply drops out of both the earned and the possible total rather
 * than scoring zero.
 */
export type DimensionScope = "first3" | "everyOwnerComment" | "case" | "closure";

export interface Dimension {
  id: string;
  label: string;
  max: number;
  signals: string[];
  scope: DimensionScope;
  appliesTo: Keyword[];
}

export const DIMENSIONS: Dimension[] = [
  {
    id: "businessImpact",
    label: "Business Impact",
    max: 10,
    signals: [
      "impact stated proactively, not requested from the customer",
      "uses the Until/impaired/which means formula",
      "names the specific Rubrik capability that is impaired",
      "states the consequence in operational business terms",
    ],
    scope: "first3",
    appliesTo: ["INTRO", "UPDATE"],
  },
  {
    id: "technicalDefinition",
    label: "Technical Definition",
    max: 10,
    signals: [
      "named artifacts",
      "error codes",
      "scope of the problem",
      "reproduction steps",
      "software versions",
      "cluster IDs",
      "timeline",
      "environment",
    ],
    scope: "first3",
    appliesTo: ["INTRO", "UPDATE"],
  },
  {
    id: "www",
    label: "WWW Quality",
    max: 3,
    signals: [
      "What was done",
      "Why it was done",
      "When the next step lands",
    ],
    scope: "everyOwnerComment",
    appliesTo: ["INTRO", "UPDATE", "FOLLOWUP", "CLOSURE"],
  },
  {
    id: "reliability",
    label: "Reliability",
    max: 10,
    signals: [
      "exactly one commitment in the comment",
      "the commitment carries an absolute date and time",
      "no other commitment on the case is already unmet",
      "the commitment was met when it came due",
    ],
    scope: "case",
    appliesTo: ["INTRO", "UPDATE", "FOLLOWUP"],
  },
  {
    id: "clearResolution",
    label: "Clear Resolution",
    max: 10,
    signals: [
      "root cause stated definitively",
      "numbered resolution steps naming the artifacts touched",
      "quantified validation evidence",
      "reopen window given as an absolute date",
    ],
    scope: "closure",
    appliesTo: ["CLOSURE"],
  },
];

export const DIMENSIONS_BY_ID: Record<string, Dimension> = Object.fromEntries(
  DIMENSIONS.map((d) => [d.id, d]),
);

/** Dimensions that apply to a given response type, in rubric order. */
export function applicableDimensions(keyword: Keyword): Dimension[] {
  return DIMENSIONS.filter((d) => d.appliesTo.includes(keyword));
}

export const APPLICABLE_DIMENSIONS: Record<Keyword, Dimension[]> = {
  INTRO: applicableDimensions("INTRO"),
  UPDATE: applicableDimensions("UPDATE"),
  FOLLOWUP: applicableDimensions("FOLLOWUP"),
  CLOSURE: applicableDimensions("CLOSURE"),
};

/**
 * Overall score out of 100, normalised over the dimensions that applied.
 *
 * The maxima do not sum to 100 and they change per response type, so a raw sum
 * would make a closure comment look worse than an intro for no reason. Dividing
 * by the applicable maximum is also the shape SentryAI's own bundle uses
 * (`m.value / m.max * 100`), which is the closest thing to a calibration check
 * available without an authenticated session.
 */
export function overallScore(earned: Array<{ id: string; earned: number }>): number | null {
  let got = 0;
  let possible = 0;
  for (const e of earned) {
    const d = DIMENSIONS_BY_ID[e.id];
    if (!d) continue;
    got += e.earned;
    possible += d.max;
  }
  if (possible <= 0) return null;
  return (100 * got) / possible;
}

// ---------------------------------------------------------------------------
// The prose the drafter sees. Rendered from the data above wherever rendering
// can be byte exact, so there is no second copy to keep in step by hand.
// ---------------------------------------------------------------------------

function renderBannedPhrases(): string {
  const lines = BANNED_PHRASES.map((p) => `- "${p.label}" -> ${p.replacement}`);
  return [
    "BANNED PHRASES (customer-facing text; each one auto-deducts IQS score — replace as shown):",
    ...lines,
  ].join("\n");
}

const BUSINESS_IMPACT_PROSE = `BUSINESS IMPACT: state impact proactively, never ask the customer for it, using the
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
release, holding cluster on current version.`;

function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

function renderSelfCheck(): string {
  const bi = DIMENSIONS_BY_ID.businessImpact;
  const td = DIMENSIONS_BY_ID.technicalDefinition;
  const www = DIMENSIONS_BY_ID.www;
  return `IQS SELF-CHECK (append after the customer text, outside any code block): label it as an
estimate, not an official score. Only assess metrics applicable to this response type.
Thresholds: ${BAND_LABELS.meeting} >= ${pct(BANDS.meeting)}%, ${BAND_LABELS.partial} ${pct(BANDS.partial)}-${pct(BANDS.meeting) - 1}%, ${BAND_LABELS.not_meeting} < ${pct(BANDS.partial)}%. If a metric
would fall below ${BAND_LABELS.meeting}, name the one concrete signal to add rather than rewriting the
draft. Format example:
IQS self-check (INTRO, estimate)
${bi.label} ${bi.max}/${bi.max} ${BAND_LABELS.meeting} - all ${bi.signals.length} signals
${td.label} 7.5/${td.max} ${BAND_LABELS.meeting} - 6/${td.signals.length} signals (add repro step + scope)
WWW this comment ${www.max}/${www.max} - What+Why+When present
Reliability - 1 valid commitment (follow-up line), on track
Clear Resolution - N/A at intro`;
}

export const CORE_RULES = [
  `You are drafting a Rubrik Salesforce case comment that must pass Rubrik's Internal
Quality Standards (IQS) scoring rubric. Follow every rule below exactly.`,

  `OUTPUT CONTRACT (follow this order, nothing else):
1. The customer-facing message, in its own fenced code block.
2. Only for CLOSURE: a second fenced code block containing the internal resolution note
   (never sent to the customer).
3. An IQS self-check estimate, as plain text, outside of any code block.
Do not add any preamble, narration, or sign-off of your own outside this contract.`,

  `FORMATTING RULES (customer-facing text only):
- No subject line. No em-dashes, ever (use periods, commas, or parentheses instead).
- No bold, no markdown headers, no bullet lists. Numbered steps (1., 2., 3.) are allowed.
- Keep it short and concise. Never copy-paste the case Subject or Description verbatim;
  restate the problem in your own words, naming the specific artifacts involved.
- First-person, definitive language throughout ("I will", "I confirmed") — no hedging.
- Greet the customer by first name only, never full name.`,

  renderBannedPhrases(),

  `VOICE RULES: sound like a real engineer writing naturally, not an AI template. Vary
sentence length. Use plain, direct words. Lead with facts and named artifacts, not
pleasantries. Avoid AI-sounding openers ("I wanted to reach out", "I hope this message
finds you well", "just following up to let you know") and filler ("please don't hesitate",
"at your earliest convenience", "kindly", "rest assured", "as per our conversation").
Never loosen the deadline, WWW, first-person, or banned-phrase rules for the sake of voice.`,

  BUSINESS_IMPACT_PROSE,

  `SIGNATURE BLOCK (exact format, each line on its own line, one blank line before
"Coverage hours", first name only):
Best regards,
[Owner First Name]
[Owner Title], Rubrik Support

Coverage hours (Mon-Fri): [Coverage Hours]
Out-of-hours support: https://www.rubrik.com/support/#contact-numbers`,

  renderSelfCheck(),
].join("\n\n");

/**
 * Per-response-type instructions. Placeholders {ATTEMPT}, {ATTEMPT_BODY},
 * {PATH} and {PATH_LINE} are filled by the drafter.
 *
 * Kept as prose rather than generated: the "Applicable self-check metrics"
 * sentences wrap mid-list in ways a generator cannot reproduce exactly, and the
 * system prompt has to stay byte identical. assertRubricConsistency() checks
 * that every dimension applicable to a keyword is actually named in that
 * keyword's template, which is the part that could silently drift.
 */
export const TEMPLATE_RULES: Record<Keyword, string> = {
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

/** The 3-Strikes rule, named once so the drafter and the scorer cite the same number. */
export const FOLLOWUP_ATTEMPTS_BEFORE_CLOSURE = 2;

/**
 * A JSON-safe view of the rubric for the browser.
 *
 * The Quality tab shows dimension labels, signal wording and band thresholds.
 * It gets them from here rather than restating them in JavaScript, so a rubric
 * edit reaches the UI on the next reload instead of drifting silently out of
 * step with the score beside it. RegExp does not survive JSON, so patterns stay
 * on the server where they are used.
 */
export function rubricMeta() {
  return {
    version: RUBRIC_VERSION,
    bands: BANDS,
    bandLabels: BAND_LABELS,
    dimensions: DIMENSIONS.map((d) => ({
      id: d.id,
      label: d.label,
      max: d.max,
      signals: d.signals,
      scope: d.scope,
      appliesTo: d.appliesTo,
    })),
    bannedPhrases: BANNED_PHRASES.map((p) => ({
      id: p.id,
      label: p.label,
      replacement: p.replacement,
    })),
    scopeNotes: {
      first3: "read from the case's opening comments",
      everyOwnerComment: "scored on each of my comments and averaged",
      case: "derived from the case's commitment record",
      closure: "read from my closing comment",
    } as Record<DimensionScope, string>,
  };
}

/**
 * Guards the two places where prose and data are kept in step by hand rather
 * than by rendering. Runs at import: a mismatch is a bug in this file, and the
 * cheapest moment to find it is boot rather than the first time somebody trusts
 * a score.
 */
export function assertRubricConsistency(): void {
  const flat = BUSINESS_IMPACT_PROSE.replace(/\s+/g, " ");
  for (const [symptom, consequence] of Object.entries(BUSINESS_IMPACT_MAP)) {
    const expected = `${symptom} -> ${consequence}`;
    if (!flat.includes(expected)) {
      throw new Error(
        `rubric: BUSINESS_IMPACT_MAP entry not present in the prose block: "${expected}"`,
      );
    }
  }

  for (const keyword of Object.keys(APPLICABLE_DIMENSIONS) as Keyword[]) {
    const template = TEMPLATE_RULES[keyword];
    for (const d of APPLICABLE_DIMENSIONS[keyword]) {
      if (!template.includes(d.label)) {
        throw new Error(
          `rubric: dimension "${d.label}" applies to ${keyword} but is not named in its template`,
        );
      }
    }
  }
}

assertRubricConsistency();
