/**
 * The one true "urgency order" -- extracted from pages/queue.js (v9 part 3)
 * so the shift console's queue pane (lib/consoleQueue.js) can rank cases
 * identically to the Queue page without a second, driftable copy. `lib/`
 * never imports from `pages/` in this codebase (see shiftConsole.js's own
 * note on why pipContent moved out of phone.js for the same reason), so
 * this had to move here rather than the console importing pages/queue.js
 * directly.
 *
 * Behavior is unchanged from the original: same flags, same precedence,
 * same tiebreak order. The Queue page re-imports these instead of keeping
 * its own copies.
 */

import * as fmt from "./fmt.js";

export const STATE_RANK = { reply: 0, breached: 1, due: 2, stale: 3, waiting: 4, "": 5 };

export function prioRank(p) {
  const m = /^P(\d)/i.exec(p || "");
  return m ? Number(m[1]) : 9;
}

/** Derives the row states everything else keys off. */
export function decorate(cases, staleDays, now = Date.now()) {
  for (const c of cases) {
    const due = c.nextCommitment?.dueAt ? Date.parse(c.nextCommitment.dueAt) : NaN;
    c._due = Number.isFinite(due) ? due : null;
    c._ageMs = c.createdDate ? now - Date.parse(c.createdDate) : 0;

    const flags = new Set();
    if (c.needsMyReply) flags.add("reply");
    if (c._due !== null) {
      if (c._due < now) flags.add("breached");
      if (fmt.isToday(c._due)) flags.add("due");
    }
    if (!c.needsMyReply && /wait|pending|customer/i.test(c.status || "")) flags.add("waiting");
    const touch = c.lastMyTouch ? Date.parse(c.lastMyTouch) : null;
    if (!c.isClosed && (touch === null || now - touch > staleDays * 86400000)) flags.add("stale");
    if (c.isEscalated) flags.add("escalated");

    c._flags = flags;
    c._state = ["reply", "breached", "due", "stale", "waiting"].find((k) => flags.has(k)) || "";
  }
  return cases;
}

/** Default ordering when the user has not chosen one: most urgent first. */
export function byUrgency(a, b) {
  const d = STATE_RANK[a._state] - STATE_RANK[b._state];
  if (d) return d;
  const ad = a._due ?? Infinity, bd = b._due ?? Infinity;
  if (ad !== bd) return ad - bd;
  const p = prioRank(a.priority) - prioRank(b.priority);
  if (p) return p;
  return b._ageMs - a._ageMs;
}
