/**
 * IQS scorecard.
 *
 * Every number here is computed from the local cache so the page is instant,
 * and every number is paired with the filter that reproduces it — a tile the
 * user cannot click into is a tile the user cannot check.
 */

import { db, newId, now } from "./db";
import { zoned, fromWallClock } from "./businessHours";

/** Initial response targets, in minutes. Mirrors src/sla.ts. */
export const IRT_MINUTES: Record<string, number> = { P0: 30, P1: 30, P2: 120, P3: 240, P4: 480 };

export type Period = "week" | "month" | "quarter" | "half" | "custom";

export interface Range {
  from: string; // ISO
  to: string;   // ISO
  label: string;
}

/** Midnight Eastern on the given local date. */
function easternMidnight(year: number, month: number, day: number): Date {
  return fromWallClock(year, month, day, 0, 0, 0);
}

export function resolveRange(period: string, fromParam?: string, toParam?: string): Range {
  const nowD = new Date();
  const p = zoned(nowD);
  const endOfToday = easternMidnight(p.year, p.month, p.day + 1);

  if (period === "custom" && fromParam && toParam) {
    return { from: new Date(fromParam).toISOString(), to: new Date(toParam).toISOString(), label: "Custom" };
  }

  if (period === "month") {
    return {
      from: easternMidnight(p.year, p.month, 1).toISOString(),
      to: endOfToday.toISOString(),
      label: "This month",
    };
  }
  if (period === "quarter") {
    const qStart = p.month - ((p.month - 1) % 3);
    return {
      from: easternMidnight(p.year, qStart, 1).toISOString(),
      to: endOfToday.toISOString(),
      label: "This quarter",
    };
  }
  if (period === "half") {
    const hStart = p.month <= 6 ? 1 : 7;
    return {
      from: easternMidnight(p.year, hStart, 1).toISOString(),
      to: endOfToday.toISOString(),
      label: "This half",
    };
  }

  // Week: Monday-anchored, because the queue is worked Mon-Fri.
  const backToMonday = (p.weekday + 6) % 7;
  return {
    from: easternMidnight(p.year, p.month, p.day - backToMonday).toISOString(),
    to: endOfToday.toISOString(),
    label: "This week",
  };
}

interface MetricCaseRow {
  case_number: string;
  priority: string | null;
  status: string;
  account: string | null;
  product_area: string | null;
  is_closed: number;
  is_escalated: number;
  created_date: string;
  closed_date: string | null;
  first_response_at: string | null;
}

const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3600_000;

function tally<T extends string | number>(rows: T[]): Array<{ key: T; count: number }> {
  const m = new Map<T, number>();
  for (const r of rows) m.set(r, (m.get(r) || 0) + 1);
  return Array.from(m, ([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

export function scorecard(range: Range) {
  const opened = db
    .prepare(
      `SELECT case_number, priority, status, account, product_area, is_closed, is_escalated,
              created_date, closed_date, first_response_at
       FROM cases WHERE created_date >= ? AND created_date < ?`,
    )
    .all(range.from, range.to) as MetricCaseRow[];

  const closed = db
    .prepare(
      `SELECT case_number, priority, status, account, product_area, is_closed, is_escalated,
              created_date, closed_date, first_response_at
       FROM cases WHERE closed_date IS NOT NULL AND closed_date >= ? AND closed_date < ?`,
    )
    .all(range.from, range.to) as MetricCaseRow[];

  const open = db
    .prepare(
      `SELECT case_number, priority, status, account, product_area, is_closed, is_escalated,
              created_date, closed_date, first_response_at
       FROM cases WHERE is_closed = 0`,
    )
    .all() as MetricCaseRow[];

  /* ---- initial response compliance -------------------------------------- */

  let irtEligible = 0;
  let irtMet = 0;
  const irtMisses: string[] = [];
  for (const c of opened) {
    const target = IRT_MINUTES[c.priority || ""] ?? IRT_MINUTES.P3;
    if (!c.first_response_at) continue; // no response yet: counted in Triage, not scored here
    irtEligible++;
    const minutes = (Date.parse(c.first_response_at) - Date.parse(c.created_date)) / 60_000;
    if (minutes <= target) irtMet++;
    else irtMisses.push(c.case_number);
  }

  /* ---- time to resolve --------------------------------------------------- */

  const ttrByPriority = new Map<string, number[]>();
  for (const c of closed) {
    if (!c.closed_date) continue;
    const key = c.priority || "Unset";
    if (!ttrByPriority.has(key)) ttrByPriority.set(key, []);
    ttrByPriority.get(key)!.push(hoursBetween(c.created_date, c.closed_date));
  }
  const ttr = Array.from(ttrByPriority, ([priority, hours]) => ({
    priority,
    count: hours.length,
    meanHours: hours.reduce((a, b) => a + b, 0) / hours.length,
    medianHours: median(hours),
  })).sort((a, b) => a.priority.localeCompare(b.priority));

  /* ---- commitments: mine, not Salesforce's ------------------------------- */

  const commitments = db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM commitments
       WHERE due_at IS NOT NULL AND due_at >= ? AND due_at < ? GROUP BY state`,
    )
    .all(range.from, range.to) as Array<{ state: string; n: number }>;

  const cm = Object.fromEntries(commitments.map((r) => [r.state, r.n])) as Record<string, number>;
  const settled = (cm.met || 0) + (cm.breached || 0);

  /* ---- aging ------------------------------------------------------------- */

  const nowMs = Date.now();
  const buckets = [
    { key: "0-2d", min: 0, max: 2 },
    { key: "3-7d", min: 2, max: 7 },
    { key: "8-14d", min: 7, max: 14 },
    { key: "15-30d", min: 14, max: 30 },
    { key: "30d+", min: 30, max: Infinity },
  ];
  const aging = buckets.map((b) => ({
    key: b.key,
    minDays: b.min,
    maxDays: b.max === Infinity ? null : b.max,
    count: open.filter((c) => {
      const days = (nowMs - Date.parse(c.created_date)) / 86_400_000;
      return days >= b.min && days < b.max;
    }).length,
  }));

  /* ---- trends ------------------------------------------------------------ */

  const dayKey = (iso: string) => {
    const p = zoned(new Date(iso));
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  };
  const openedByDay = tally(opened.map((c) => dayKey(c.created_date)));
  const closedByDay = tally(closed.filter((c) => c.closed_date).map((c) => dayKey(c.closed_date!)));
  const days = Array.from(new Set([...openedByDay, ...closedByDay].map((d) => d.key))).sort();
  const volume = days.map((d) => ({
    day: d,
    opened: openedByDay.find((x) => x.key === d)?.count || 0,
    closed: closedByDay.find((x) => x.key === d)?.count || 0,
  }));

  /* ---- manual entries ---------------------------------------------------- */

  const manual = db
    .prepare("SELECT metric, period, value, note, updated_at FROM manual_metrics ORDER BY period DESC")
    .all() as Array<{ metric: string; period: string; value: number; note: string | null; updated_at: number }>;

  return {
    range,
    owned: { opened: opened.length, closed: closed.length, open: open.length },
    irt: {
      eligible: irtEligible,
      met: irtMet,
      pct: irtEligible ? Math.round((irtMet / irtEligible) * 1000) / 10 : null,
      misses: irtMisses,
      targets: IRT_MINUTES,
    },
    ttr,
    commitments: {
      met: cm.met || 0,
      breached: cm.breached || 0,
      active: cm.active || 0,
      superseded: cm.superseded || 0,
      pct: settled ? Math.round(((cm.met || 0) / settled) * 1000) / 10 : null,
    },
    openByPriority: tally(open.map((c) => c.priority || "Unset")),
    openByStatus: tally(open.map((c) => c.status)),
    aging,
    byProductArea: tally(open.map((c) => c.product_area || "Unclassified")),
    byAccount: tally(open.map((c) => c.account || "Unknown")).slice(0, 10),
    escalations: open.filter((c) => c.is_escalated || c.priority === "P1" || c.priority === "P0").length,
    volume,
    manual,
  };
}

/** CSAT / NPS / IQS come from another system; they are typed in by hand here. */
export function saveManualMetric(period: string, metric: string, value: number, note?: string) {
  db.prepare(
    `INSERT INTO manual_metrics (id, period, metric, value, note, updated_at)
     VALUES (@id, @period, @metric, @value, @note, @ts)
     ON CONFLICT(period, metric) DO UPDATE SET
       value = excluded.value, note = excluded.note, updated_at = excluded.updated_at`,
  ).run({ id: newId(), period, metric, value, note: note || null, ts: now() });
}

export function deleteManualMetric(period: string, metric: string) {
  db.prepare("DELETE FROM manual_metrics WHERE period = ? AND metric = ?").run(period, metric);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
