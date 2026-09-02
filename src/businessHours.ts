/**
 * Business-hours arithmetic for the AMER support shift.
 *
 * Coverage is Monday to Friday, 09:00-18:00 America/New_York. Everything here
 * works in real instants (epoch milliseconds) and converts to New York wall
 * clock only where the rules require it, so DST transitions are handled by the
 * platform's tz database rather than by a hardcoded UTC offset.
 *
 * No date library: the rules are fixed and the whole module is smaller than the
 * dependency would be.
 */

export const TZ = "America/New_York";
export const DAY_START_HOUR = 9;
export const DAY_END_HOUR = 18;
export const BUSINESS_MS_PER_DAY = (DAY_END_HOUR - DAY_START_HOUR) * 3600_000;

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

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface ZonedParts {
  year: number;
  month: number;   // 1-12
  day: number;     // 1-31
  hour: number;    // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday
}

/** Wall-clock parts of an instant, as seen in New York. */
export function zoned(at: Date | number): ZonedParts {
  const d = typeof at === "number" ? new Date(at) : at;
  const out: Record<string, string> = {};
  for (const p of PARTS.formatToParts(d)) {
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
function offsetMs(at: number): number {
  const p = zoned(at);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Round to the second: the formatter drops sub-second precision.
  return asIfUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Instant for a New York wall-clock time. Two passes: guess with the offset at
 * the naive instant, then correct using the offset at the guess. That converges
 * for every real transition, including the spring-forward gap.
 */
export function fromWallClock(
  year: number, month: number, day: number,
  hour = 0, minute = 0, second = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = naive - offsetMs(naive);
  guess = naive - offsetMs(guess);
  return new Date(guess);
}

export function isWeekend(at: Date | number): boolean {
  const wd = zoned(at).weekday;
  return wd === 0 || wd === 6;
}

/** Start of the business day (09:00 NY) containing or covering this instant. */
function dayStart(at: number): number {
  const p = zoned(at);
  return fromWallClock(p.year, p.month, p.day, DAY_START_HOUR, 0, 0).getTime();
}

function dayEnd(at: number): number {
  const p = zoned(at);
  return fromWallClock(p.year, p.month, p.day, DAY_END_HOUR, 0, 0).getTime();
}

export function isWithinBusinessHours(at: Date | number): boolean {
  const t = typeof at === "number" ? at : at.getTime();
  if (isWeekend(t)) return false;
  return t >= dayStart(t) && t < dayEnd(t);
}

/**
 * The next instant that is inside the business window. Returns `at` itself when
 * it already is.
 */
export function nextBusinessInstant(at: Date | number): Date {
  let t = typeof at === "number" ? at : at.getTime();
  for (let i = 0; i < 14; i++) {
    if (!isWeekend(t)) {
      const s = dayStart(t);
      const e = dayEnd(t);
      if (t < s) return new Date(s);
      if (t < e) return new Date(t);
    }
    // Move to 09:00 of the following day and re-test.
    const p = zoned(t + 24 * 3600_000);
    t = fromWallClock(p.year, p.month, p.day, DAY_START_HOUR, 0, 0).getTime();
  }
  return new Date(t);
}

/**
 * Business milliseconds between two instants. Negative when `to` is before
 * `from`, so it can be used directly for overdue countdowns.
 */
export function businessMsBetween(from: Date | number, to: Date | number): number {
  let a = typeof from === "number" ? from : from.getTime();
  let b = typeof to === "number" ? to : to.getTime();
  if (a === b) return 0;

  const sign = b > a ? 1 : -1;
  if (sign < 0) { const t = a; a = b; b = t; }

  let total = 0;
  let cursor = a;

  // Walk day by day. A 400-iteration ceiling keeps a bad input from hanging the
  // request; anything beyond a year of business time is not a real countdown.
  for (let i = 0; i < 400 && cursor < b; i++) {
    if (isWeekend(cursor)) {
      const p = zoned(cursor + 24 * 3600_000);
      cursor = fromWallClock(p.year, p.month, p.day, 0, 0, 0).getTime();
      continue;
    }
    const s = dayStart(cursor);
    const e = dayEnd(cursor);
    const segStart = Math.max(cursor, s);
    const segEnd = Math.min(b, e);
    if (segEnd > segStart) total += segEnd - segStart;

    if (b <= e) break;
    const p = zoned(cursor + 24 * 3600_000);
    cursor = fromWallClock(p.year, p.month, p.day, 0, 0, 0).getTime();
  }

  return total * sign;
}

/**
 * Add business days. Friday 17:00 + 2 business days is Tuesday 17:00, not
 * Sunday. A start outside the window is first pulled to the next business
 * instant so "Saturday + 1" means "Monday", not "Sunday".
 */
export function addBusinessDays(from: Date | number, days: number): Date {
  let t = nextBusinessInstant(from).getTime();
  let remaining = Math.max(0, Math.floor(days));
  while (remaining > 0) {
    const p = zoned(t + 24 * 3600_000);
    t = fromWallClock(p.year, p.month, p.day, zoned(t).hour, zoned(t).minute, 0).getTime();
    if (!isWeekend(t)) remaining--;
  }
  return new Date(t);
}

/** Add business hours, skipping nights and weekends. */
export function addBusinessHours(from: Date | number, hours: number): Date {
  let remaining = hours * 3600_000;
  let t = nextBusinessInstant(from).getTime();
  for (let i = 0; i < 400 && remaining > 0; i++) {
    const e = dayEnd(t);
    const available = e - t;
    if (remaining <= available) return new Date(t + remaining);
    remaining -= available;
    t = nextBusinessInstant(e + 60_000).getTime();
  }
  return new Date(t);
}

/** "3h 20m", "2d 1h", "-45m". Business time, formatted for a countdown chip. */
export function formatBusinessDuration(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  let rest = Math.abs(ms);

  const days = Math.floor(rest / BUSINESS_MS_PER_DAY);
  rest -= days * BUSINESS_MS_PER_DAY;
  const hours = Math.floor(rest / 3600_000);
  rest -= hours * 3600_000;
  const minutes = Math.floor(rest / 60_000);

  if (days > 0) return sign + days + "d " + hours + "h";
  if (hours > 0) return sign + hours + "h " + minutes + "m";
  return sign + minutes + "m";
}
