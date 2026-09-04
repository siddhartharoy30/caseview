/**
 * Layer 2: the model scorer.
 *
 * Layer 1 answers "did the signals appear" with regexes. It cannot answer
 * "was the business impact actually meaningful to this customer", so Layer 2
 * asks a model the same rubric questions and the two answers are shown side
 * by side. The DELTA is the product here. A dimension where the regex sees a
 * signal and the model does not is usually a template phrase that satisfies
 * the letter of the rubric and none of its intent, which is exactly the thing
 * a self-review never catches.
 *
 * Three rules this file exists to keep:
 *
 *   1. Layer 1 stands alone. Nothing here is imported by the sync path, and
 *      no score depends on this layer existing. With no token the module
 *      loads, reports enabled:false, and never calls out.
 *
 *   2. The rubric is not restated. Every dimension, maximum, signal list and
 *      band threshold in the prompt is rendered from ./rubric at call time
 *      (constraint 10). A rubric edit changes the prompt with no edit here.
 *
 *   3. The arithmetic is ours, not the model's. The model returns earned
 *      points per dimension and nothing else; the overall is computed by the
 *      same overallScore() Layer 1 uses. A model cannot hand back an
 *      out-of-band total, and the two layers stay comparable because they
 *      divide by the same denominator.
 *
 * Cached by content hash, not by time (PLAN_V3 decision 3): unchanged text is
 * never re-scored, and a rubric, model or prompt move invalidates.
 */

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { log } from "../log";
import {
  RUBRIC_VERSION,
  BANDS,
  BAND_LABELS,
  bandFor,
  applicableDimensions,
  DIMENSIONS_BY_ID,
  overallScore,
} from "./rubric";
import type { Band, Keyword } from "./rubric";
import { toPlainText, ownText, detectKeywordFromComments } from "./layer1";
import type { CaseFacts, CommentFacts } from "./layer1";

/**
 * Bumped whenever the prompt changes.
 *
 * PLAN_V3 decision 3 specifies the hash as "comment bodies + RUBRIC_VERSION +
 * model". The prompt version is folded in as well, deliberately: a reworded
 * prompt changes the score exactly as a reworded rubric does, and a cache that
 * did not notice would serve scores no current prompt would produce.
 *
 *   l2.1  first release
 */
export const PROMPT_VERSION = "l2.1";

export const LAYER = "layer2";

/* ------------------------------------------------------------------ types */

export interface Layer2Dimension {
  id: string;
  label: string;
  max: number;
  earned: number;
  fraction: number;
  band: Band;
  /** Why the model landed on that number, in its own words. */
  rationale: string;
  /** A quote from my own text, or null when the model found nothing to quote. */
  evidence: string | null;
  /** The concrete thing that would have earned the rest. */
  gap: string | null;
}

export interface Layer2Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Local estimate at list price. Not a bill. */
  costUsd: number;
  ms: number;
}

export interface Layer2Score {
  caseId: string;
  caseNumber: string;
  keyword: Keyword;
  rubricVersion: string;
  promptVersion: string;
  model: string;
  contentHash: string;
  overall: number | null;
  band: Band | null;
  dimensions: Layer2Dimension[];
  /** One paragraph on the case as a whole. */
  summary: string;
  /** The single highest-value change, or null if the model named none. */
  topFix: string | null;
  /** Anything the scorer wants the reader to know about the scoring itself. */
  notes: string[];
  usage: Layer2Usage;
  scoredAt: number;
}

/** Why the layer declined to run. Never an exception: this layer is optional. */
export type Layer2Unavailable =
  | { ok: false; reason: "disabled"; detail: string }
  | { ok: false; reason: "no-token"; detail: string }
  | { ok: false; reason: "budget"; detail: string }
  | { ok: false; reason: "no-content"; detail: string }
  | { ok: false; reason: "error"; detail: string };

export type Layer2Result = { ok: true; score: Layer2Score } | Layer2Unavailable;

/* ------------------------------------------------------------ availability */

/**
 * Whether the layer can run at all, decided without touching the network.
 *
 * Callers check this before doing any work so the UI can say "no token"
 * rather than show a spinner that resolves into an error.
 */
export function availability(): { enabled: boolean; reason: string; model: string } {
  const l2 = config.iqs.layer2;
  if (!l2.enabled) {
    return { enabled: false, reason: "IQS_LAYER2 is off", model: l2.model };
  }
  if (!config.anthropic.authToken) {
    return { enabled: false, reason: "No Anthropic token is configured", model: l2.model };
  }
  return { enabled: true, reason: "", model: l2.model };
}

/* ------------------------------------------------------------------ prices */

/**
 * List prices in USD per million tokens, matched on a substring of the model
 * id so a dated snapshot resolves to its family.
 *
 * This is a local estimate for budgeting. The gateway reports no spend, and
 * Rubrik's internal billing is not per-call anyway, so the number's only jobs
 * are to make the cost of a re-score legible and to trip the daily cap.
 * Unknown models fall through to the Sonnet row rather than costing zero,
 * because a silent zero would disable the cap.
 */
const PRICES: Array<{ match: string; input: number; output: number }> = [
  { match: "opus", input: 15, output: 75 },
  { match: "haiku", input: 1, output: 5 },
  { match: "sonnet", input: 3, output: 15 },
];

const DEFAULT_PRICE = { input: 3, output: 15 };

export function priceFor(model: string): { input: number; output: number } {
  const m = model.toLowerCase();
  for (const p of PRICES) if (m.includes(p.match)) return { input: p.input, output: p.output };
  return DEFAULT_PRICE;
}

export function estimateCostUsd(
  model: string,
  u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): number {
  const p = priceFor(model);
  const M = 1000000;
  // Published multipliers: a cache read is a tenth of an input token, a cache
  // write is one and a quarter.
  const cost =
    (u.inputTokens * p.input) / M +
    (u.outputTokens * p.output) / M +
    ((u.cacheReadTokens || 0) * p.input * 0.1) / M +
    ((u.cacheWriteTokens || 0) * p.input * 1.25) / M;
  return Math.round(cost * 1e6) / 1e6;
}

/* -------------------------------------------------------------- the corpus */

export interface ScorableComment {
  id: string;
  createdDate: string;
  isPublic: boolean;
  text: string;
}

/**
 * My own comments, as plain text, in the same normalisation Layer 1 scored.
 *
 * Using ownText() rather than the raw body matters twice over: the model reads
 * what Layer 1 read, so the two are comparable, and the quoted email chain
 * underneath a reply never reaches the gateway.
 */
export function scorableComments(facts: CaseFacts): ScorableComment[] {
  const l2 = config.iqs.layer2;
  const mine: ScorableComment[] = [];

  for (const c of facts.comments as CommentFacts[]) {
    if (!c.isMine) continue;
    const text = ownText(toPlainText(c.body)).trim();
    if (!text) continue;
    mine.push({
      id: c.id,
      createdDate: c.createdDate,
      isPublic: c.isPublic,
      text:
        text.length > l2.maxCommentChars
          ? text.slice(0, l2.maxCommentChars) + "\n[truncated]"
          : text,
    });
  }

  // Newest wins when the cap bites: a review is about recent work. The slice
  // keeps chronological order, so the model still reads a story.
  if (mine.length > l2.maxComments) return mine.slice(mine.length - l2.maxComments);
  return mine;
}

/* --------------------------------------------------------------- the hash */

/**
 * The cache key.
 *
 * Everything that can change the answer is in here and nothing that cannot.
 * Timestamps are deliberately absent: identical text scored a month apart is
 * the same score, which is the whole point of hashing content rather than
 * expiring on a clock.
 */
export function contentHash(facts: CaseFacts, keyword: Keyword, model: string): string {
  const h = createHash("sha256");
  h.update("qview-iqs-l2-v1\n");
  h.update(RUBRIC_VERSION + "\n");
  h.update(PROMPT_VERSION + "\n");
  h.update(model + "\n");
  h.update(keyword + "\n");
  for (const c of scorableComments(facts)) {
    // The separators are what stop two different comment splits hashing alike.
    h.update(c.id + "\t" + (c.isPublic ? "public" : "internal") + "\n");
    h.update(c.text + "\n--\n");
  }
  return h.digest("hex");
}

/* -------------------------------------------------------------- the prompt */

const SCOPE_PROSE: Record<string, string> = {
  first3: "judge the first three comments on the case, where this should be established",
  everyOwnerComment: "judge each of the engineer's comments and average",
  case: "judge the case as a whole",
  closure: "judge the closing comment",
};

function pct(n: number): number {
  return Math.round(n * 100);
}

/**
 * The rubric, rendered. Not a second copy of it.
 *
 * Every number and every signal string below is read out of ./rubric, so the
 * prompt cannot drift from what Layer 1 applies (constraint 10).
 */
export function buildSystemPrompt(keyword: Keyword): string {
  const dims = applicableDimensions(keyword);

  const dimBlocks = dims.map((d) =>
    [
      "  " + d.id + " (" + d.label + "), worth " + d.max + " points. Scope: " + SCOPE_PROSE[d.scope] + ".",
      "    Signals the rubric asks for:",
      d.signals.map((s) => "      - " + s).join("\n"),
    ].join("\n"),
  );

  return [
    "You are auditing a Rubrik support engineer's own comments on a Salesforce case",
    "against Rubrik's Internal Quality Standards (IQS) rubric " + RUBRIC_VERSION + ".",
    "",
    "You are reviewing the ENGINEER's writing, not the customer's problem. Do not",
    "solve the technical issue, suggest a fix for it, or judge how the case turned",
    "out. Judge only whether the engineer's comments carry the signals the rubric",
    "asks for.",
    "",
    "Response type for this case: " + keyword + ".",
    "Score exactly these dimensions and no others:",
    "",
    dimBlocks.join("\n\n"),
    "",
    "HOW TO SCORE",
    "- Award a fraction of the maximum, not a pass or a fail. A dimension with four",
    "  signals where two are clearly present and one is gestured at is worth about",
    "  60 percent of its maximum, not 50 and not 100.",
    "- Reward substance, not vocabulary. A comment that names the impaired capability",
    "  and its operational consequence in its own words earns full business impact",
    "  even if it never uses the word impact. A comment that recites the template",
    "  phrase without naming anything specific does not.",
    "- Quote the engineer's own words as evidence. If you cannot find a quote that",
    "  supports a signal, that signal is not present, whatever the comment implies.",
    "- Be a demanding reviewer. Most real comments land in the middle. Reserve full",
    "  marks for a dimension where every signal is unmistakably present.",
    "",
    "BANDS: " +
      BAND_LABELS.meeting + " at or above " + pct(BANDS.meeting) + " percent, " +
      BAND_LABELS.partial + " from " + pct(BANDS.partial) + " to " + (pct(BANDS.meeting) - 1) + " percent, " +
      BAND_LABELS.not_meeting + " below " + pct(BANDS.partial) + " percent.",
    "Do not compute an overall score. Return per-dimension points only; the caller",
    "normalises them.",
    "",
    "OUTPUT: a single JSON object and nothing else. No prose before or after it, no",
    "code fence. Shape:",
    "{",
    '  "dimensions": [',
    '    { "id": "<one of the ids above>",',
    '      "earned": <number, from 0 to that dimension\'s maximum>,',
    '      "rationale": "<one or two sentences, specific to this case>",',
    '      "evidence": "<a short direct quote from the engineer, or null>",',
    '      "gap": "<the one concrete thing that would earn the rest, or null at full marks>" }',
    "  ],",
    '  "summary": "<two or three sentences on the engineer\'s handling of this case>",',
    '  "topFix": "<the single highest-value change to make next time, or null>"',
    "}",
    "Every dimension id listed above must appear exactly once.",
  ].join("\n");
}

export function buildUserPrompt(facts: CaseFacts, comments: ScorableComment[]): string {
  const lines: string[] = [
    "CASE " + facts.caseNumber,
    "Subject: " + (facts.subject || "(none)"),
    "Status: " + (facts.status || "(unknown)") + (facts.isClosed ? " (closed)" : ""),
    "",
    "The customer's description of the problem, for context only. Do not score it:",
    (facts.description || "(none)").slice(0, 2000),
    "",
    "THE ENGINEER'S COMMENTS, oldest first. These are what you score.",
  ];

  comments.forEach((c, i) => {
    lines.push(
      "",
      "--- comment " + (i + 1) + " of " + comments.length + " | " + c.createdDate +
        " | " + (c.isPublic ? "customer-facing" : "internal note") + " ---",
      c.text,
    );
  });

  lines.push("", "Return the JSON object now.");
  return lines.join("\n");
}

/* ---------------------------------------------------------------- the call */

const client = new Anthropic({
  authToken: config.anthropic.authToken,
  apiKey: null,
  baseURL: config.anthropic.baseUrl,
});

interface RawDimension {
  id?: unknown;
  earned?: unknown;
  rationale?: unknown;
  evidence?: unknown;
  gap?: unknown;
}

/**
 * Pull the JSON object out of whatever the model actually sent.
 *
 * The prompt asks for bare JSON, and a fence or a sentence of preamble is the
 * usual way that gets ignored. Losing a paid call to a stray fence would be
 * silly, so recover where recovery is unambiguous and throw otherwise.
 */
/** A fenced code block, if the model wrapped its JSON in one. */
const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;

export function parseModelJson(text: string): Record<string, unknown> {
  let s = text.trim();

  const fence = s.match(FENCE_RE);
  if (fence) s = fence[1].trim();

  if (!s.startsWith("{")) {
    const open = s.indexOf("{");
    const close = s.lastIndexOf("}");
    if (open >= 0 && close > open) s = s.slice(open, close + 1);
  }

  const parsed = JSON.parse(s);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model returned JSON that is not an object");
  }
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

/**
 * Turn the model's answer into a score.
 *
 * Defensive on purpose. Unknown ids are dropped, points are clamped into
 * range, and a dimension the model forgot is left OUT of the denominator
 * rather than scored zero, because a missing answer is not a bad answer and
 * pretending otherwise would quietly understate the case. Every repair leaves
 * a note the reader can see, so a suspiciously high score can be traced to
 * the dimensions that fell out of it.
 */
export function buildScore(args: {
  facts: CaseFacts;
  keyword: Keyword;
  model: string;
  hash: string;
  raw: Record<string, unknown>;
  usage: Layer2Usage;
  now: number;
}): Layer2Score {
  const { facts, keyword, model, hash, raw, usage, now } = args;
  const wanted = applicableDimensions(keyword);
  const notes: string[] = [];

  const rawDims = Array.isArray(raw.dimensions) ? (raw.dimensions as RawDimension[]) : [];
  const byId = new Map<string, RawDimension>();
  for (const d of rawDims) {
    const id = typeof d.id === "string" ? d.id : "";
    if (!id) continue;
    if (!DIMENSIONS_BY_ID[id]) {
      notes.push("The model scored an unknown dimension (" + id + "). It was ignored.");
      continue;
    }
    if (!wanted.some((w) => w.id === id)) {
      notes.push("The model scored " + id + ", which does not apply to a " + keyword + ". It was ignored.");
      continue;
    }
    if (byId.has(id)) {
      notes.push("The model scored " + id + " twice. The first answer was kept.");
      continue;
    }
    byId.set(id, d);
  }

  const dimensions: Layer2Dimension[] = [];
  for (const d of wanted) {
    const got = byId.get(d.id);
    if (!got) {
      notes.push(
        "The model did not score " + d.label + ", so it is left out of the total rather than counted as zero.",
      );
      continue;
    }

    let earned = Number(got.earned);
    if (!Number.isFinite(earned)) {
      notes.push("The model gave " + d.label + " a non-numeric score, so it is left out of the total.");
      continue;
    }
    if (earned < 0 || earned > d.max) {
      notes.push("The model scored " + d.label + " at " + earned + " out of " + d.max + ". Clamped into range.");
      earned = Math.min(d.max, Math.max(0, earned));
    }
    earned = Math.round(earned * 100) / 100;

    const fraction = d.max > 0 ? earned / d.max : 0;
    dimensions.push({
      id: d.id,
      label: d.label,
      max: d.max,
      earned,
      fraction,
      band: bandFor(fraction),
      rationale: str(got.rationale) || "No rationale given.",
      evidence: str(got.evidence),
      gap: str(got.gap),
    });
  }

  const overall = dimensions.length ? overallScore(dimensions) : null;

  return {
    caseId: facts.caseId,
    caseNumber: facts.caseNumber,
    keyword,
    rubricVersion: RUBRIC_VERSION,
    promptVersion: PROMPT_VERSION,
    model,
    contentHash: hash,
    overall: overall === null ? null : Math.round(overall * 10) / 10,
    band: overall === null ? null : bandFor(overall / 100),
    dimensions,
    summary: str(raw.summary) || "",
    topFix: str(raw.topFix),
    notes,
    usage,
    scoredAt: now,
  };
}

/**
 * Call the gateway and score one case.
 *
 * Knows nothing about caching or budgets. The store decides whether this
 * should happen at all; this decides what the answer is. Failures come back
 * as a result, never as a throw, because a scoring outage must not be able to
 * take a page down.
 */
export async function scoreWithModel(
  facts: CaseFacts,
  keywordOverride?: Keyword,
): Promise<Layer2Result> {
  const avail = availability();
  if (!avail.enabled) {
    return {
      ok: false,
      reason: config.iqs.layer2.enabled ? "no-token" : "disabled",
      detail: avail.reason,
    };
  }

  const comments = scorableComments(facts);
  if (!comments.length) {
    return { ok: false, reason: "no-content", detail: "This case has no comments of mine to score." };
  }

  const keyword = keywordOverride || detectKeywordFromComments(facts.status, facts.comments);
  const model = config.iqs.layer2.model;
  const hash = contentHash(facts, keyword, model);

  const t0 = Date.now();
  try {
    const msg = await client.messages.create({
      model,
      max_tokens: 2048,
      temperature: 0,
      system: buildSystemPrompt(keyword),
      messages: [{ role: "user", content: buildUserPrompt(facts, comments) }],
    });

    const ms = Date.now() - t0;
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const u = msg.usage as unknown as Record<string, number>;
    const usage: Layer2Usage = {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheWriteTokens: u.cache_creation_input_tokens || 0,
      costUsd: 0,
      ms,
    };
    usage.costUsd = estimateCostUsd(model, usage);

    const raw = parseModelJson(text);
    const score = buildScore({ facts, keyword, model, hash, raw, usage, now: Date.now() });

    log.info("iqs.layer2.scored", {
      caseNumber: facts.caseNumber,
      keyword,
      overall: score.overall,
      ms,
      costUsd: usage.costUsd,
      repairs: score.notes.length,
    });

    return { ok: true, score };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn("iqs.layer2.failed", { caseNumber: facts.caseNumber, ms: Date.now() - t0, detail });
    return { ok: false, reason: "error", detail };
  }
}
