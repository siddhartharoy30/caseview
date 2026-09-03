/**
 * Browser notifications.
 *
 * The server already decided what counts as an event and wrote it to a table
 * with a deterministic id, so this module has no detection logic in it at all.
 * It polls, it filters by the kinds I asked for, and it raises a notification.
 * Everything about "is this new" is settled by the id.
 *
 * Two behaviours are worth explaining, because both are deliberate and both
 * would look like bugs otherwise:
 *
 *   1. The first poll of a session raises nothing. It only seeds the seen-set.
 *      A tab opened on Monday morning would otherwise fire every event of the
 *      weekend at once, which is noise dressed up as urgency. What happened
 *      while I was away belongs on the pages, not in a stack of popups.
 *
 *   2. The seen-set lives in memory, not localStorage. The store module's own
 *      rule is that no case content is ever written to disk, and an event id
 *      contains a case number. Re-seeding on every load costs one request and
 *      keeps that rule intact.
 *
 * Preferences do live in localStorage, because a kind toggle is not case data.
 */

import * as store from "./store.js";
import { api } from "./api.js";

const KEY_PREFS = "notify.prefs";
const POLL_MS = 60000;
const MAX_PER_POLL = 3; // beyond this, one summary; a burst should not be a barrage

export const KINDS = [
  { id: "case.new", label: "New case assigned to me" },
  { id: "case.replied", label: "Customer replied" },
  { id: "commitment.due", label: "Commitment due within the hour" },
  { id: "commitment.breached", label: "Commitment breached" },
];

const DEFAULT_KINDS = {
  "case.new": true,
  "case.replied": true,
  "commitment.due": true,
  "commitment.breached": true,
};

export function prefs() {
  const p = store.get(KEY_PREFS, {});
  return {
    enabled: !!p.enabled,
    kinds: Object.assign({}, DEFAULT_KINDS, p.kinds || {}),
  };
}

export function setPrefs(patch) {
  const next = Object.assign(prefs(), patch);
  store.set(KEY_PREFS, next);
  return next;
}

/** "granted" | "denied" | "default" | "unsupported" */
export function permission() {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/**
 * Asking for permission is a user gesture, so it belongs to the Settings page
 * rather than to the poller. A denial is recorded as such — flipping the
 * preference on when the browser will never show anything would be a lie the
 * UI then has to keep telling.
 */
export async function requestPermission() {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/* ------------------------------------------------------------------ poller */

const seen = new Set();
let timer = null;
let seeded = false;
let navigateTo = null;

function show(title, body, caseNumber) {
  let n;
  try {
    n = new Notification(title, {
      body: body || "",
      tag: caseNumber || undefined, // a second event on the same case replaces the first
      icon: "/favicon.svg",
    });
  } catch {
    return; // some browsers throw without a service worker; nothing to recover from
  }
  n.onclick = () => {
    window.focus();
    if (caseNumber && navigateTo) navigateTo("/case/" + encodeURIComponent(caseNumber));
    n.close();
  };
}

async function poll() {
  const p = prefs();
  if (!p.enabled || permission() !== "granted") return;

  let events;
  try {
    const res = await api.events(null);
    events = (res && res.events) || [];
  } catch {
    return; // a failed poll is not worth a toast; the sync chip already reports outages
  }

  const fresh = events.filter((e) => !seen.has(e.id));
  for (const e of events) seen.add(e.id);

  // First pass through: remember everything, announce nothing.
  if (!seeded) {
    seeded = true;
    return;
  }

  const wanted = fresh.filter((e) => p.kinds[e.kind] !== false);
  if (!wanted.length) return;

  if (wanted.length > MAX_PER_POLL) {
    show("QView: " + wanted.length + " new events", "Open QView to see what moved.", null);
    return;
  }
  for (const e of wanted) show(e.title, e.detail || "", e.caseNumber);
}

/**
 * Started once at boot and left running. It re-reads preferences on every tick
 * instead of being restarted when they change, so a toggle in Settings takes
 * effect without any wiring between the two.
 */
export function startNotifications(navigate) {
  navigateTo = navigate || null;
  if (timer) return;
  poll();
  timer = setInterval(poll, POLL_MS);
}

export function stopNotifications() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Lets Settings prove the permission path works without waiting for an event. */
export function testNotification() {
  if (permission() !== "granted") return false;
  show("QView", "Test notification. Notifications are working.", null);
  return true;
}
