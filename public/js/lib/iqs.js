/**
 * How a quality score looks, in one place.
 *
 * The queue column and the Quality tab both render bands, fractions and
 * keywords, and a score that is amber in a table cell and green in a detail
 * panel is worse than no score at all. So the band vocabulary — its label, its
 * CSS tone, the threshold it came from — lives here and both callers import it.
 *
 * The thresholds themselves are not duplicated. `bandFor` exists on the server
 * in src/iqs/rubric.ts and every band the UI draws was decided there and shipped
 * in the payload; nothing in this file re-derives one. The two constants below
 * are only used to *explain* a band in a tooltip, and they arrive from
 * /api/cases/:n/iqs alongside the score, so the fallbacks are a cold-start
 * courtesy rather than a second source of truth.
 */

import { h } from "./dom.js";

export const BAND_LABEL = {
  meeting: "Meeting",
  partial: "Partially Meeting",
  not_meeting: "Not Meeting",
};

/** Band → CSS tone suffix. Underscores are not welcome in class names. */
export const BAND_TONE = {
  meeting: "good",
  partial: "mid",
  not_meeting: "bad",
};

export const KEYWORD_LABEL = {
  INTRO: "Intro",
  UPDATE: "Update",
  FOLLOWUP: "Follow-up",
  CLOSURE: "Closure",
};

/** What each response type means, for the tooltip on the keyword chip. */
export const KEYWORD_HINT = {
  INTRO: "Scored as an opening response — impact and technical definition carry the weight",
  UPDATE: "Scored as a progress update — impact, definition, WWW and reliability all apply",
  FOLLOWUP: "Scored as a follow-up — WWW and reliability only; a chase does not restate the case",
  CLOSURE: "Scored as a closure — the closing comment has to stand on its own",
};

export const tone = (band) => BAND_TONE[band] || "none";
export const bandLabel = (band) => BAND_LABEL[band] || "Unscored";

/**
 * A percentage as the rubric means it: a score out of 100 is already a
 * percentage of the *applicable* maximum, because dimensions that do not apply
 * to the response type drop out of the denominator rather than scoring zero.
 */
export const scoreText = (n) => (n === null || n === undefined ? "—" : String(Math.round(n)));

/**
 * The compact score read: a short track plus the number.
 *
 * Used in the queue at row scale and again at the top of the Quality tab, so
 * the same score is the same shape in both places. `width` is the track length
 * in pixels; everything else follows from the band.
 */
export function scoreMeter(overall, band, { width = 34, showNumber = true } = {}) {
  const has = overall !== null && overall !== undefined;
  const pct = has ? Math.max(0, Math.min(100, overall)) : 0;

  return h("span", { class: `iqs-meter t-${has ? tone(band) : "none"}` },
    h("span", { class: "iqs-track", style: { width: `${width}px` } },
      has ? h("span", { class: "iqs-fill", style: { width: `${pct}%` } }) : null),
    showNumber ? h("span", { class: "iqs-num", text: scoreText(overall) }) : null,
  );
}

/** Band pill. The label is spelled out; the colour is the fast read. */
export function bandChip(band, extraText) {
  return h("span", { class: `chip iqs-band t-${tone(band)}`, text: extraText || bandLabel(band) });
}

/** Why a case scored the band it did, in words, for a title attribute. */
export function bandExplain(overall, band, bands) {
  if (overall === null || overall === undefined) return "Not scored — nothing of mine on this case yet";
  const meet = Math.round((bands?.meeting ?? 0.8) * 100);
  const part = Math.round((bands?.partial ?? 0.5) * 100);
  const where = band === "meeting" ? `at or above ${meet}`
    : band === "partial" ? `between ${part} and ${meet - 1}`
    : `below ${part}`;
  return `${bandLabel(band)} — ${Math.round(overall)} of 100 applicable points, ${where}`;
}
