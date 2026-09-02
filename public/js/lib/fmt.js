/**
 * Formatting.
 *
 * House rule from the spec: a timestamp is always shown absolutely, with its
 * timezone. Relative time ("3h ago") is allowed only as a supplement, never as
 * the only form — "2 days ago" is useless when you are reconstructing what
 * happened on a case.
 */

export const TZ = "America/New_York";

const dtf = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts });

const F_DATETIME = dtf({ month: "short", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
const F_DATETIME_SHORT = dtf({ month: "short", day: "2-digit", hour: "numeric", minute: "2-digit", hour12: true });
const F_DATE = dtf({ weekday: "short", month: "short", day: "2-digit", year: "numeric" });
const F_DATE_SHORT = dtf({ month: "short", day: "2-digit" });
const F_TIME = dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const F_TIME_UTC = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const F_DAY_KEY = dtf({ year: "numeric", month: "2-digit", day: "2-digit" });

const toDate = (v) => (v instanceof Date ? v : typeof v === "number" ? new Date(v) : v ? new Date(v) : null);
const valid = (d) => d && !Number.isNaN(d.getTime());

/** "Sep 02, 2026, 4:15 PM ET" — the canonical form. */
export function dateTime(value) {
  const d = toDate(value);
  return valid(d) ? F_DATETIME.format(d) + " ET" : "—";
}

/** "Sep 02, 4:15 PM" — for dense tables where the year is noise. */
export function dateTimeShort(value) {
  const d = toDate(value);
  return valid(d) ? F_DATETIME_SHORT.format(d) : "—";
}

/** "Tue, Sep 02, 2026" */
export function dateOnly(value) {
  const d = toDate(value);
  return valid(d) ? F_DATE.format(d) : "—";
}

export function dateShort(value) {
  const d = toDate(value);
  return valid(d) ? F_DATE_SHORT.format(d) : "—";
}

export function clockEastern(d = new Date()) { return F_TIME.format(d); }
export function clockUtc(d = new Date()) { return F_TIME_UTC.format(d); }

/** YYYY-MM-DD in Eastern — the grouping key used everywhere. */
export function dayKey(value) {
  const d = toDate(value);
  if (!valid(d)) return "";
  const parts = Object.fromEntries(F_DAY_KEY.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isToday(value) { return dayKey(value) === dayKey(new Date()); }

/** "3h ago" / "in 45m". Supplementary only. */
export function relative(value, now = Date.now()) {
  const d = toDate(value);
  if (!valid(d)) return "";
  const diff = d.getTime() - now;
  const future = diff > 0;
  const s = Math.abs(diff) / 1000;
  let out;
  if (s < 45) out = "just now";
  else if (s < 3600) out = `${Math.round(s / 60)}m`;
  else if (s < 86400) out = `${Math.round(s / 3600)}h`;
  else if (s < 86400 * 30) out = `${Math.round(s / 86400)}d`;
  else out = `${Math.round(s / (86400 * 30))}mo`;
  if (out === "just now") return out;
  return future ? `in ${out}` : `${out} ago`;
}

/** Countdown for commitments: "2h 14m" / "-40m" once breached. */
export function countdown(value, now = Date.now()) {
  const d = toDate(value);
  if (!valid(d)) return "—";
  let ms = d.getTime() - now;
  const overdue = ms < 0;
  ms = Math.abs(ms);
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  let out;
  if (days > 0) out = `${days}d ${hours}h`;
  else if (hours > 0) out = `${hours}h ${String(mins).padStart(2, "0")}m`;
  else out = `${mins}m`;
  return overdue ? `-${out}` : out;
}

/** Age of a case in whole days, plus a severity band for colouring. */
export function ageDays(value, now = Date.now()) {
  const d = toDate(value);
  if (!valid(d)) return { days: null, band: "" };
  const days = Math.floor((now - d.getTime()) / 86400000);
  return { days, band: days > 14 ? "red" : days > 7 ? "amber" : "" };
}

export function duration(hours) {
  if (hours === null || hours === undefined || Number.isNaN(hours)) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function pct(value) {
  if (value === null || value === undefined) return "—";
  return `${value}%`;
}

export function num(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("en-US");
}

export function truncate(text, max = 90) {
  const s = String(text || "");
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** Priority normalised to p0..p4 for the chip classes. */
export function priorityClass(priority) {
  const m = String(priority || "").match(/P?([0-4])/i);
  return m ? `p${m[1]}` : "p4";
}
