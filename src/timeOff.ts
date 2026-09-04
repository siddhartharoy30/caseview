/**
 * Time-off calendar (Phase 6, Feature C's first piece).
 *
 * A declared range is whole days, in the owner's timezone -- "out Sep 10
 * through Sep 12" means midnight to midnight America/New_York, not the
 * container's UTC clock. rangeBoundsMs() goes through the same
 * businessHours.ts:fromWallClock() every other date-sensitive part of this
 * codebase already uses, for the same reason Phase 1 fixed claude.ts's date
 * formatting: a bare `new Date("2026-09-10")` parses as UTC midnight, which
 * is 8 PM the previous evening in New York.
 */

import { randomUUID } from "crypto";
import { db, now } from "./db";
import { fromWallClock } from "./businessHours";

export interface TimeOffRange {
  id: string;
  startDate: string;
  endDate: string;
  note: string | null;
  createdAt: number;
}

interface TimeOffRow {
  id: string;
  start_date: string;
  end_date: string;
  note: string | null;
  created_at: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toApi(r: TimeOffRow): TimeOffRange {
  return { id: r.id, startDate: r.start_date, endDate: r.end_date, note: r.note, createdAt: r.created_at };
}

/** Upcoming and current ranges first, so the calendar reads earliest-relevant-first. */
export function listTimeOff(): TimeOffRange[] {
  return (db.prepare("SELECT * FROM time_off ORDER BY start_date ASC").all() as TimeOffRow[]).map(toApi);
}

export function addTimeOff(startDate: string, endDate: string, note: string | null): TimeOffRange {
  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    throw new Error("Dates must be YYYY-MM-DD");
  }
  if (endDate < startDate) {
    throw new Error("End date is before the start date");
  }
  const row: TimeOffRow = {
    id: randomUUID(),
    start_date: startDate,
    end_date: endDate,
    note: note?.trim() || null,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO time_off (id, start_date, end_date, note, created_at)
     VALUES (@id, @start_date, @end_date, @note, @created_at)`,
  ).run(row);
  return toApi(row);
}

export function deleteTimeOff(id: string): void {
  db.prepare("DELETE FROM time_off WHERE id = ?").run(id);
}

/**
 * A declared range's start-of-day through end-of-day in New York, as the
 * same ISO-with-offset strings `commitments.due_at` is stored in -- so the
 * comparison in queries.ts:commitmentsInRange() is a plain TEXT BETWEEN,
 * not a parse-and-compare.
 */
export function rangeBoundsMs(startDate: string, endDate: string): { startIso: string; endIso: string } {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const start = fromWallClock(sy, sm, sd, 0, 0, 0);
  const end = fromWallClock(ey, em, ed, 23, 59, 59);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
