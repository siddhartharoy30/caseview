/**
 * Business-hours arithmetic for the browser.
 *
 * This is a deliberate mirror of `src/businessHours.ts`. The server owns the
 * rules — it is what parses "two business days" into a stored `dueAt` — but a
 * countdown has to tick in front of you, once a second is too often to ask a
 * server and once a minute is too slow to trust. So the same nine-to-six,
 * Monday-to-Friday, America/New_York window lives here too.
 *
 * The constants are duplicated rather than served from an endpoint on purpose:
 * they are the shift, not configuration, and a countdown that silently changes
 * meaning because a fetch failed would be worse than one that is simply fixed.
 * If the shift ever moves, both files move together.
 *
 * Everything works in epoch milliseconds and converts to New York wall clock
 * only where the rules require it, so DST is handled by the platform's tz
 * database and not by a hardcoded offset. No dependency: the whole module is
 * smaller than one would be.
 */

export const TZ = "America/New_York";
export const DAY_START_HOUR = 9;
export const DAY_END_HOUR = 18;
export const BUSINESS_MS_PER_DAY = (DAY_END_HOUR - DAY_START_HOUR) * 3600000;

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const ms = (at) => (typeof at === "number" ? at : new Date(at).getTime());

/** Wall-clock parts of an instant, as seen in New York. */
export function zoned(at) {
  const out = {};
  for (const p of PARTS.formatToParts(new Date(ms(at)))) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    // Intl emits "24" for midnight under hour12:false in some engines.
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAY_INDEX[out.weekday] ?? 0,
  };
}

/** Offset of New York from UTC, in ms, at a given instant. */
function offsetMs(at) {
  const p = zoned(at);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Instant for a New York wall-clock time. Two passes: guess with the offset at
 * the naive instant, then correct using the offset at the guess. That converges
 * for every real transition, including the spring-forward gap.
 */
export function fromWallClock(year, month, day, hour = 0, minute = 0, second = 0) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naive - offsetMs(naive);
  guess = naive - offsetMs(guess);
  return new Date(guess);
}

export function isWeekend(at) {
  const wd = zoned(at).weekday;
  return wd === 0 || wd === 6;
}

function dayStart(at) {
  const p = zoned(at);
  return fromWallClock(p.year, p.month, p.day, DAY_START_HOUR, 0, 0).getTime();
}

function dayEnd(at) {
  const p = zoned(at);
  return fromWallClock(p.year, p.month, p.day, DAY_END_HOUR, 0, 0).getTime();
}

function nextMidnight(at) {
  const p = zoned(at + 24 * 3600000);
  return fromWallClock(p.year, p.month, p.day, 0, 0, 0).getTime();
}

export function isWithinBusinessHours(at) {
  const t = ms(at);
  if (isWeekend(t)) return false;
  return t >= dayStart(t) && t < dayEnd(t);
}

/**
 * The next instant inside the business window, or `at` itself when it already
 * is one.
 */
export function nextBusinessInstant(at) {
  let t = ms(at);
  for (let i = 0; i < 14; i++) {
    if (!isWeekend(t)) {
      const s = dayStart(t);
      const e = dayEnd(t);
      if (t < s) return new Date(s);
      if (t < e) return new Date(t);
    }
    const p = zoned(t + 24 * 3600000);
    t = fromWallClock(p.year, p.month, p.day, DAY_START_HOUR, 0, 0).getTime();
  }
  return new Date(t);
}

/**
 * Business milliseconds between two instants. Negative when `to` is before
 * `from`, so it drops straight into an overdue countdown.
 */
export function businessMsBetween(from, to) {
  let a = ms(from);
  let b = ms(to);
  if (a === b) return 0;

  const sign = b > a ? 1 : -1;
  if (sign < 0) {
    const t = a;
    a = b;
    b = t;
  }

  let total = 0;
  let cursor = a;

  // Day by day, with a 400-iteration ceiling so a bad date cannot hang the tab.
  for (let i = 0; i < 400 && cursor < b; i++) {
    if (isWeekend(cursor)) {
      cursor = nextMidnight(cursor);
      continue;
    }
    const s = dayStart(cursor);
    const e = dayEnd(cursor);
    const segStart = Math.max(cursor, s);
    const segEnd = Math.min(b, e);
    if (segEnd > segStart) total += segEnd - segStart;

    if (b <= e) break;
    cursor = nextMidnight(cursor);
  }

  return total * sign;
}

/** Add business days. Friday 17:00 + 2 is Tuesday 17:00, not Sunday. */
export function addBusinessDays(from, days) {
  let t = nextBusinessInstant(from).getTime();
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    const at = zoned(t);
    const p = zoned(t + 24 * 3600000);
    t = fromWallClock(p.year, p.month, p.day, at.hour, at.minute, 0).getTime();
    if (!isWeekend(t)) remaining--;
  }
  return new Date(t);
}

/** Add business hours, skipping nights and weekends. */
export function addBusinessHours(from, hours) {
  let remaining = hours * 3600000;
  let t = nextBusinessInstant(from).getTime();
  for (let i = 0; i < 400 && remaining > 0; i++) {
    const e = dayEnd(t);
    const available = e - t;
    if (remaining <= available) return new Date(t + remaining);
    remaining -= available;
    t = nextBusinessInstant(e + 60000).getTime();
  }
  return new Date(t);
}

/** "3h 20m", "2d 1h", "-45m". Business time, formatted for a countdown chip. */
export function formatBusinessDuration(msTotal) {
  const sign = msTotal < 0 ? "-" : "";
  let rest = Math.abs(msTotal);

  const days = Math.floor(rest / BUSINESS_MS_PER_DAY);
  rest -= days * BUSINESS_MS_PER_DAY;
  const hours = Math.floor(rest / 3600000);
  rest -= hours * 3600000;
  const minutes = Math.floor(rest / 60000);

  if (days > 0) return sign + days + "d " + hours + "h";
  if (hours > 0) return sign + hours + "h " + minutes + "m";
  return sign + minutes + "m";
}

/**
 * A deadline's remaining time, in both clocks.
 *
 * Both numbers matter and neither substitutes for the other. Business time is
 * how much working room is actually left — it is what decides whether you can
 * still make it. Wall time is when the customer will look. A Friday 6 PM
 * deadline seen on Friday at 5 PM has one business hour and one wall hour left;
 * seen on Friday at 4 PM on a deadline of Monday 10 AM it has one business hour
 * left and sixty-six wall hours, and only the first of those tells you to move.
 */
export function remaining(dueAt, now = Date.now()) {
  const due = ms(dueAt);
  if (!Number.isFinite(due)) return null;
  return {
    due,
    wallMs: due - now,
    businessMs: businessMsBetween(now, due),
    overdue: due <= now,
    /** True when the deadline itself falls outside the shift. */
    outOfHours: !isWithinBusinessHours(due),
  };
}

/** Is this instant on today's New York calendar day? */
export function isSameNyDay(a, b = Date.now()) {
  const x = zoned(a);
  const y = zoned(b);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

/**
 * "today", "tomorrow", "Fri 12 Sep" — the label a band header uses. Calendar
 * days, not business days: a customer promised Friday does not care that
 * Saturday is not a working day.
 */
export function dayLabel(at, now = Date.now()) {
  if (isSameNyDay(at, now)) return "today";
  if (isSameNyDay(at, now + 86400000)) return "tomorrow";
  if (isSameNyDay(at, now - 86400000)) return "yesterday";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(ms(at)));
}

/**
 * The default a manual deadline should start from: the end of today's shift if
 * we are still inside it, otherwise 6 PM on the next working day. This is the
 * commitment you actually make most often — "by 6 PM today" — so it should be
 * one click, not five.
 */
export function defaultDueAt(now = Date.now()) {
  const t = ms(now);
  if (!isWeekend(t) && t < dayEnd(t) && t >= dayStart(t) - 3600000) {
    return new Date(dayEnd(t));
  }
  const next = nextBusinessInstant(t < dayEnd(t) ? t : dayEnd(t) + 60000).getTime();
  return new Date(dayEnd(next));
}

/**
 * Format an instant for a `datetime-local` input, in New York wall clock.
 *
 * The input has no timezone of its own — it shows whatever string you give it
 * and hands back the same shape — so both directions have to go through NY
 * explicitly. A user in Bangalore setting "6:00 PM" means the customer's 6 PM.
 */
export function toLocalInput(at) {
  const p = zoned(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Inverse of `toLocalInput`: a NY wall-clock string back to a real instant. */
export function fromLocalInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ""));
  if (!m) return null;
  return fromWallClock(+m[1], +m[2], +m[3], +m[4], +m[5], 0);
}
