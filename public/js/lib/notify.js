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
import { toast, setToastDurationBase } from "./ui.js";

const KEY_PREFS = "notify.prefs";
const POLL_MS = 30000; // was 60000 -- v4 phase 5 also polls immediately on tab focus, see startNotifications()
const MAX_PER_POLL = 3; // beyond this, one summary; a burst should not be a barrage

export const KINDS = [
  { id: "case.new", label: "New case assigned to me" },
  { id: "case.replied", label: "Customer replied" },
  { id: "case.escalated", label: "Case escalated" },
  { id: "case.waiting_on_support", label: "Case moved to waiting-on-support" },
  { id: "commitment.due", label: "Commitment due within the hour" },
  { id: "commitment.breached", label: "Commitment breached" },
];

const DEFAULT_KINDS = {
  "case.new": true,
  "case.replied": true,
  "case.escalated": true,
  "case.waiting_on_support": true,
  "commitment.due": true,
  "commitment.breached": true,
};

/** Sticky in the in-app toast stack (never auto-dismiss) and eligible for a
 * sound, per phase 5 -- the three kinds where missing it costs the most. */
const PRIORITY_KINDS = new Set(["case.escalated", "case.waiting_on_support", "commitment.breached"]);
const TONE_BY_KIND = { "case.escalated": "err", "commitment.breached": "err", "case.waiting_on_support": "warn" };

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
let onUnreadChange = null;
let soundEnabled = false;
let audioCtx = null;

/**
 * v5 phase 3: generalized from a hardcoded caseNumber third argument to an
 * options bag, and exported -- phoneMonitor.js needs the same OS-notification
 * primitive for a live queue position, which has no case number and no event
 * kind at all, so forcing it through this module's kind system (built for a
 * flat on/off toggle list) would be a worse fit than sharing the primitive
 * directly. Both features still share one permission path via
 * permission()/requestPermission() below.
 */
export function show(title, body, opts = {}) {
  const { tag, onClick } = opts;
  let n;
  try {
    n = new Notification(title, {
      body: body || "",
      tag: tag || undefined, // a second notification with the same tag replaces the first
      icon: "/favicon.svg",
    });
  } catch {
    return; // some browsers throw without a service worker; nothing to recover from
  }
  n.onclick = () => {
    window.focus();
    if (onClick) onClick();
    n.close();
  };
}

/**
 * A short two-tone chime via Web Audio -- no asset file, no new dependency.
 * Default off; even on, it only ever plays for the priority kinds (phase 5)
 * or phone alerts (v5 phase 3, its own separate default-on setting).
 */
export function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    [880, 660].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      const start = t0 + i * 0.11;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  } catch { /* Web Audio unsupported or blocked -- silence is an acceptable fallback */ }
}

/**
 * v5 phase 3: autoplay needs a prior user gesture. Toggling the phone
 * monitor on is that gesture -- calling this from inside that click handler
 * creates (or resumes) the one shared AudioContext both chime() call sites
 * use, so phone alerts aren't blocked the first time they try to play.
 * Returns whether audio is usable, so the caller can say so once rather than
 * failing quietly.
 */
export function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return true;
  } catch {
    return false;
  }
}

async function poll() {
  const p = prefs();

  let res;
  try {
    res = await api.events(null);
  } catch {
    return; // a failed poll is not worth a toast; the sync chip already reports outages
  }
  const events = (res && res.events) || [];
  if (onUnreadChange && res && typeof res.unread === "number") onUnreadChange(res.unread);
  soundEnabled = res && res.soundEnabled === true;
  if (res && typeof res.toastDurationMs === "number") setToastDurationBase(res.toastDurationMs);

  const fresh = events.filter((e) => !seen.has(e.id));
  for (const e of events) seen.add(e.id);

  // First pass through: remember everything, announce nothing.
  if (!seeded) {
    seeded = true;
    return;
  }

  const wanted = fresh.filter((e) => p.kinds[e.kind] !== false);
  if (!wanted.length) return;

  const playSound = soundEnabled && wanted.some((e) => PRIORITY_KINDS.has(e.kind));
  if (playSound) chime();

  if (p.enabled && permission() === "granted") {
    if (wanted.length > MAX_PER_POLL) {
      show("QView: " + wanted.length + " new events", "Open QView to see what moved.");
    } else {
      for (const e of wanted) {
        show(e.title, e.detail || "", {
          tag: e.caseNumber,
          onClick: () => e.caseNumber && navigateTo && navigateTo("/case/" + encodeURIComponent(e.caseNumber)),
        });
      }
    }
  }

  // In-app toasts fire regardless of the OS-notification preference above --
  // they need no permission, so they are the fallback every tab always has.
  if (wanted.length > MAX_PER_POLL) {
    toast(wanted.length + " new events — open the notification centre", "", { duration: 6000 });
  } else {
    for (const e of wanted) {
      toast(e.title, TONE_BY_KIND[e.kind] || "", {
        caseNumber: e.caseNumber || null,
        sticky: PRIORITY_KINDS.has(e.kind),
      });
    }
  }
}

/**
 * Started once at boot and left running. It re-reads preferences on every tick
 * instead of being restarted when they change, so a toggle in Settings takes
 * effect without any wiring between the two. `onUnread` feeds the topbar
 * bell's badge count without the bell needing its own poll loop.
 */
export function startNotifications(navigate, onUnread) {
  navigateTo = navigate || null;
  onUnreadChange = onUnread || null;
  if (timer) return;
  poll();
  timer = setInterval(poll, POLL_MS);
  // Phase 5: poll immediately on tab focus too, instead of waiting out
  // whatever fraction of the 30s interval was left when the tab blurred.
  window.addEventListener("focus", poll);
}

export function stopNotifications() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Lets Settings prove the permission path works without waiting for an event. */
export function testNotification() {
  if (permission() !== "granted") return false;
  show("QView", "Test notification. Notifications are working.");
  return true;
}
