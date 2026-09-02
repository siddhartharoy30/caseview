/**
 * Follow-up commitment parsing.
 *
 * A missed follow-up deadline is a hard failure, so this module errs toward
 * over-detection: anything that reads like a promise is captured, and if the
 * datetime cannot be resolved the commitment is still recorded with
 * `dueAt = null` so it surfaces as "unparsed" instead of vanishing.
 *
 * The canonical phrasings this must always get right:
 *   "I will follow up with you by 6:00 PM EST today, Monday, August 18, 2026."
 *   "I will follow up with you by 6:00 PM EST on Tuesday, August 19, 2026."
 */

import { fromWallClock, zoned, addBusinessDays } from "./businessHours";

export interface ParsedCommitment {
  /** The sentence the promise was found in. */
  raw: string;
  /** Resolved deadline, or null when the sentence promised without a date. */
  dueAt: Date | null;
  /** False when a date was found but had to be assumed (e.g. end of day). */
  exactTime: boolean;
}

/** Phrases that make a sentence a commitment. */
const TRIGGER =
  /\b(?:i(?:'ll|\s+will|\s+shall)|we(?:'ll|\s+will))\s+(?:(?:also|then|now|try\s+to|aim\s+to|plan\s+to)\s+)?(?:follow(?:ing)?\s*-?\s*up|update|get\s+back|circle\s+back|reach\s+out|revert|respond|reply|check\s+back|have\s+(?:an?\s+)?(?:answer|update|response)|provide\s+(?:an?\s+)?(?:answer|update|response)|send\s+(?:you\s+)?(?:an?\s+)?(?:answer|update|response))\b/i;

/**
 * Phrases that look like a commitment but are conditional or historical, and
 * must not create a deadline.
 */
const NEGATION =
  /\b(?:if\s+(?:you|we|i|the)|once\s+(?:you|we|i|the)|as\s+soon\s+as|when\s+(?:you|we|i|the)|unless|in\s+case|should\s+you|i\s+will\s+not|i\s+won't|i\s+had\s+(?:said|planned)|i\s+was\s+going\s+to)\b/i;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** Fixed offsets in minutes for zones other than Eastern. */
const FIXED_OFFSETS: Record<string, number> = {
  cst: -360, cdt: -300, ct: -360,
  mst: -420, mdt: -360, mt: -420,
  pst: -480, pdt: -420, pt: -480,
  utc: 0, gmt: 0, z: 0,
  ist: 330,
  cet: 60, cest: 120,
  bst: 60,
};

const EASTERN = /^(est|edt|et|eastern)$/i;

/** Split into sentences without losing the delimiter context. */
function sentences(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface TimeOfDay { hour: number; minute: number; exact: boolean; zone: string | null; }

function parseTimeOfDay(s: string): TimeOfDay | null {
  const zoneMatch = /\b(EST|EDT|ET|CST|CDT|CT|MST|MDT|MT|PST|PDT|PT|UTC|GMT|IST|CET|CEST|BST|Eastern)\b/i.exec(s);
  const zone = zoneMatch ? zoneMatch[1].toLowerCase() : null;

  // "6:00 PM", "6 PM", "6:00PM"
  const ampm = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i.exec(s);
  if (ampm) {
    let hour = Number(ampm[1]) % 12;
    if (/^p/i.test(ampm[3])) hour += 12;
    return { hour, minute: Number(ampm[2] || 0), exact: true, zone };
  }

  // "17:00", "by 1700 hrs"
  const h24 = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s);
  if (h24) {
    return { hour: Number(h24[1]), minute: Number(h24[2]), exact: true, zone };
  }

  // Named times.
  if (/\b(?:end\s+of\s+(?:the\s+)?day|eod|close\s+of\s+business|cob)\b/i.test(s)) {
    return { hour: 18, minute: 0, exact: true, zone };
  }
  if (/\b(?:start\s+of\s+(?:the\s+)?day|sod|first\s+thing|beginning\s+of\s+the\s+day)\b/i.test(s)) {
    return { hour: 9, minute: 0, exact: true, zone };
  }
  if (/\bnoon|midday\b/i.test(s)) {
    return { hour: 12, minute: 0, exact: true, zone };
  }
  if (/\bmorning\b/i.test(s)) return { hour: 12, minute: 0, exact: false, zone };
  if (/\bafternoon\b/i.test(s)) return { hour: 17, minute: 0, exact: false, zone };
  if (/\bevening\b/i.test(s)) return { hour: 18, minute: 0, exact: false, zone };

  return zone ? { hour: 18, minute: 0, exact: false, zone } : null;
}

interface CalendarDate { year: number; month: number; day: number; }

function parseCalendarDate(s: string, reference: Date): CalendarDate | null {
  const ref = zoned(reference);

  // "August 18, 2026" / "Aug 18 2026" / "August 18"
  const monthFirst =
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/.exec(s);
  if (monthFirst && MONTHS[monthFirst[1].toLowerCase()]) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const day = Number(monthFirst[2]);
    const year = monthFirst[3] ? Number(monthFirst[3]) : inferYear(ref, month, day);
    if (day >= 1 && day <= 31) return { year, month, day };
  }

  // "18 August 2026"
  const dayFirst = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?(?:,?\s*(\d{4}))?\b/.exec(s);
  if (dayFirst && MONTHS[dayFirst[2].toLowerCase()]) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const day = Number(dayFirst[1]);
    const year = dayFirst[3] ? Number(dayFirst[3]) : inferYear(ref, month, day);
    if (day >= 1 && day <= 31) return { year, month, day };
  }

  // "08/18/2026" or "8/18" — US order, which is what this queue writes.
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : inferYear(ref, month, day);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year, month, day };
  }

  // "2026-08-18"
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }

  return null;
}

/** A bare "August 18" means the next August 18 at or after the comment date. */
function inferYear(ref: { year: number; month: number; day: number }, month: number, day: number): number {
  if (month < ref.month || (month === ref.month && day < ref.day - 1)) return ref.year + 1;
  return ref.year;
}

function shiftDays(reference: Date, days: number): CalendarDate {
  const p = zoned(reference.getTime() + days * 24 * 3600_000);
  return { year: p.year, month: p.month, day: p.day };
}

/** Next occurrence of a weekday, strictly after the reference day unless today matches "today". */
function nextWeekday(reference: Date, target: number): CalendarDate {
  const p = zoned(reference);
  let delta = (target - p.weekday + 7) % 7;
  if (delta === 0) delta = 7; // "on Monday" said on a Monday means the next one
  return shiftDays(reference, delta);
}

/** Build an instant from a wall-clock date, time, and zone token. */
function toInstant(date: CalendarDate, time: TimeOfDay): Date {
  const zone = time.zone;
  if (!zone || EASTERN.test(zone)) {
    return fromWallClock(date.year, date.month, date.day, time.hour, time.minute, 0);
  }
  const offsetMin = FIXED_OFFSETS[zone];
  if (offsetMin === undefined) {
    return fromWallClock(date.year, date.month, date.day, time.hour, time.minute, 0);
  }
  const utc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0);
  return new Date(utc - offsetMin * 60_000);
}

/**
 * Parse every commitment in a comment body.
 *
 * `commentDate` anchors relative expressions ("today", "tomorrow", "Monday",
 * "in 2 business days") to when the promise was actually made.
 */
export function parseCommitments(body: string, commentDate: Date): ParsedCommitment[] {
  if (!body) return [];

  const out: ParsedCommitment[] = [];

  for (const sentence of sentences(body)) {
    if (!TRIGGER.test(sentence)) continue;
    if (NEGATION.test(sentence)) continue;

    const time = parseTimeOfDay(sentence);
    let date: CalendarDate | null = parseCalendarDate(sentence, commentDate);
    let exact = time?.exact ?? false;

    if (!date) {
      if (/\btoday\b/i.test(sentence)) {
        date = shiftDays(commentDate, 0);
      } else if (/\btomorrow\b/i.test(sentence)) {
        date = shiftDays(commentDate, 1);
      } else if (/\b(?:in|within|after)\s+(\d{1,2})\s+business\s+days?\b/i.test(sentence)) {
        const n = Number(/\b(?:in|within|after)\s+(\d{1,2})\s+business\s+days?\b/i.exec(sentence)![1]);
        date = zonedToCalendar(addBusinessDays(commentDate, n));
      } else if (/\b(?:in|within|after)\s+(\d{1,2})\s+days?\b/i.test(sentence)) {
        const n = Number(/\b(?:in|within|after)\s+(\d{1,2})\s+days?\b/i.exec(sentence)![1]);
        date = shiftDays(commentDate, n);
      } else if (/\b(?:in|within)\s+(\d{1,2})\s+hours?\b/i.test(sentence)) {
        const n = Number(/\b(?:in|within)\s+(\d{1,2})\s+hours?\b/i.exec(sentence)![1]);
        out.push({
          raw: sentence,
          dueAt: new Date(commentDate.getTime() + n * 3600_000),
          exactTime: true,
        });
        continue;
      } else {
        const wd = /\b(?:on\s+|by\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i.exec(sentence);
        if (wd) date = nextWeekday(commentDate, WEEKDAYS[wd[1].toLowerCase()]);
      }
    }

    if (!date) {
      // Reads like a promise, carries no date. Record it as unparsed so it can
      // be corrected by hand rather than silently lost.
      out.push({ raw: sentence, dueAt: null, exactTime: false });
      continue;
    }

    const resolvedTime: TimeOfDay = time || { hour: 18, minute: 0, exact: false, zone: null };
    if (!time) exact = false;

    out.push({ raw: sentence, dueAt: toInstant(date, resolvedTime), exactTime: exact });
  }

  return out;
}

function zonedToCalendar(d: Date): CalendarDate {
  const p = zoned(d);
  return { year: p.year, month: p.month, day: p.day };
}
