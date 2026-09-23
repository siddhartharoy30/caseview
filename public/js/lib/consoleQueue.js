/**
 * Data source for the shift console's queue pane (v9 part 3) -- fetches the
 * same open-case scope the Queue page fetches, ranks it identically via
 * queueRank.js (so the two surfaces never disagree about order), and
 * exposes a subscribe(fn) API shaped like phoneMonitor's singleton so
 * shiftConsole.js can wire it the same way it wires the phone pane.
 *
 * "Needs my response" for this pane's header count and full-row bucket
 * reuses `coverageTriggerStatuses` verbatim -- the spec's own instruction:
 * don't write a third definition, two already agree (the coverage setting
 * and the case.waiting_on_support notification). This is a *different*
 * question from queueRank's `_state === "reply"` (which drives sort order,
 * same as the Queue page); both are reused, neither is redefined here.
 *
 * No polling loop of its own. refresh() is called by shiftConsole.js on
 * open and whenever the watch poll (v9 part 3 phase 3) reports a change --
 * a pane-owned interval hitting /api/cases every N seconds would be a
 * second, undocumented polling path this app has otherwise never had.
 */

import { api } from "./api.js";
import * as store from "./store.js";
import { decorate, byUrgency } from "./queueRank.js";

const KEY_STALE = "queue.staleDays"; // same preference the Queue page reads -- one definition of "stale"
const DEFAULT_STALE_DAYS = 5;

let cases = [];
let triggerStatuses = new Set();
let loaded = false;
let error = null;
const listeners = new Set();

function parseTriggerStatuses(raw) {
  return new Set(String(raw || "").split(",").map((s) => s.trim()).filter(Boolean));
}

function needsResponse(c) {
  return triggerStatuses.has(c.status);
}

function snapshot() {
  const needReply = cases.filter(needsResponse);
  const waitingOnCustomer = cases.filter((c) => c._state === "waiting");
  return {
    loaded,
    error,
    cases,
    needReply,
    waitingOnCustomerCount: waitingOnCustomer.length,
    needsResponse,
  };
}

function notify() {
  const s = snapshot();
  for (const fn of listeners) fn(s);
}

/** Re-fetches cases + the coverage trigger-status list and re-ranks. Safe
 * to call repeatedly -- each call is a fresh, independent fetch, same as
 * the Queue page's own load(). */
export async function refresh() {
  try {
    const staleDays = Number(store.get(KEY_STALE, DEFAULT_STALE_DAYS)) || DEFAULT_STALE_DAYS;
    const [casesRes, settingsRes] = await Promise.all([
      api.cases({ status: "open" }),
      api.settings(),
    ]);
    triggerStatuses = parseTriggerStatuses(settingsRes.settings && settingsRes.settings.coverageTriggerStatuses);
    cases = decorate(casesRes.cases || [], staleDays).sort(byUrgency);
    error = null;
  } catch (err) {
    error = err;
  } finally {
    loaded = true;
    notify();
  }
  return snapshot();
}

/** Immediate-delivery-then-on-change, same convention as phoneMonitor.subscribe
 * and shiftConsole.onOwnershipChange. */
export function subscribe(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

export function getSnapshot() {
  return snapshot();
}
