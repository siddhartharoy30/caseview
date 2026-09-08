/**
 * The phone-queue monitor singleton -- v5 phase 3.
 *
 * v4 phase 6 put all of this inside `pages/phone.js`'s `render()` closure, so
 * polling and alerting only happened while `/phone` itself was the mounted
 * page -- navigating to the Queue silently turned the monitor off. The whole
 * point of a phone alert is that I am *not* looking at QView (I'm in the CCP
 * window, in a case, in Slack), so that was the bug this phase exists to fix.
 *
 * Started once at boot (see app.js) and left running for the tab's lifetime,
 * the same shape notify.js's own startNotifications() already established.
 * Every rendering surface (the /phone page, the docked panel, the pop-out)
 * is a pure subscribe() callback -- this is the whole mechanism behind "one
 * poll, one alert": only this module ever calls api.phoneBoard() or fires a
 * toast/OS-notification/sound/title-flash, so three surfaces watching at
 * once still produce exactly one of each per event.
 *
 * This module also fully satisfies what the v5 plan calls Phase 4a (a
 * monitor that alerts from any page) -- there is no separate later step for
 * that; polling here is gated only on the master toggle, not on whether any
 * particular surface is currently watching, because at this point in the
 * build order (this phase ships before the pop-out or the dock exist) that
 * is the only gate consistent with both this phase's own requirement and
 * the still-to-come multi-surface one.
 */

import { api } from "./api.js";
import { toast } from "./ui.js";
import * as notify from "./notify.js";

const POLL_MS = 10000;
const ALERT_THRESHOLD_DEFAULT = 3;
const AUTO_OFF_OFFLINE_MS = 5 * 60 * 1000;

const RINGING_STATUSES = new Set(["ringing", "accepting_call"]);

/** Matches the source board's own colour vocabulary (app.css .phn-* rules)
 * rather than inventing a second one that could disagree with the board an
 * agent is also glancing at directly. The one copy every surface imports. */
export const STATUS_TONE = {
  available: "ok",
  ringing: "bad",
  accepting_call: "bad",
  inbound: "info", outbound: "info",
  on_call: "info", on_call__inbound_: "info", on_call__outbound_: "info",
  on_hold__in_: "info", on_hold__out_: "info",
  acw: "info", acw_in_: "info", acw_out_: "info",
  acw__inbound_: "info", acw__outbound_: "info", acw__transfer_: "info",
  after_call_work: "info", zoom: "info",
  busy: "warn", away: "warn",
  offline: "neutral", missed: "bad",
};

export function statusTone(cls) { return STATUS_TONE[cls] || "neutral"; }

const state = {
  loading: true,
  error: null,
  board: null,
  myName: null,
  position: null,
  enabled: false,
  threshold: ALERT_THRESHOLD_DEFAULT,
  soundEnabled: true,
  lastNotifiedPosition: null,
  offlineSince: null,
  audioBlocked: false,
};

const subscribers = new Set();

/** Every rendering surface calls this once; it gets the current state
 * immediately (so it never has to special-case "nothing yet") and again on
 * every change. Returns an unsubscribe function. */
export function subscribe(fn) {
  subscribers.add(fn);
  fn(state);
  return () => subscribers.delete(fn);
}

function emit() {
  for (const fn of subscribers) fn(state);
}

export function getState() { return state; }

let timer = null;
let flashTimer = null;
let originalTitle = null;

function startTitleFlash(text) {
  if (flashTimer) return;
  originalTitle = document.title;
  let on = false;
  flashTimer = setInterval(() => {
    document.title = on ? originalTitle : text;
    on = !on;
  }, 1000);
  window.addEventListener("focus", stopTitleFlash, { once: true });
}

function stopTitleFlash() {
  if (!flashTimer) return;
  clearInterval(flashTimer);
  flashTimer = null;
  if (originalTitle != null) document.title = originalTitle;
  originalTitle = null;
}

/** Re-usable across the phone toggle, the classify dialog (Phase 2) and any
 * future roster edit -- pulls a fresh board read outside the normal 10s
 * cadence, still subject to the server's own fetch floor. */
export function refreshNow() {
  if (state.enabled) poll();
}

/**
 * v5 phase 3.2's escalation table:
 *   position 3          -> toast + OS notification
 *   position 2          -> + sound
 *   position 1          -> sticky toast + sound + title flash
 *   ringing/accepting   -> all of it, immediately, every time
 */
function maybeAlert() {
  const board = state.board;
  if (!board || !board.ok || !state.enabled) return;
  const pos = state.position ? state.position.position : null;
  const mine = board.agents.find((a) => a.name === state.myName);

  // Auto-off after 5 minutes reading "offline" -- so it does not nag after a
  // shift ends and the tab is left open.
  if (mine && mine.statusClass === "offline") {
    if (state.offlineSince === null) state.offlineSince = Date.now();
    else if (Date.now() - state.offlineSince > AUTO_OFF_OFFLINE_MS) {
      setEnabled(false);
      toast("Phone monitor turned off — offline for 5 minutes", "");
      return;
    }
  } else {
    state.offlineSince = null;
  }

  // Immediate, every time -- a call landing is not subject to the
  // once-per-transition rule below.
  if (mine && RINGING_STATUSES.has(mine.statusClass)) {
    toast("Incoming call", "err", { sticky: true });
    notify.show("Incoming call", state.position ? state.position.poolLabel : "", { tag: "phone-ringing" });
    if (state.soundEnabled) notify.chime();
    startTitleFlash("(!) Incoming call");
  }

  if (pos == null || pos > state.threshold) { state.lastNotifiedPosition = pos; return; }
  if (pos === state.lastNotifiedPosition) return; // once per transition, not per poll
  state.lastNotifiedPosition = pos;

  const caveat = state.position && state.position.uncertain ? " (unconfirmed — unclassified agents ahead)" : "";
  const label = "You're " + (pos <= 1 ? "next" : pos + (pos === 2 ? "nd" : "rd")) + " for the phone queue";
  notify.show(label, state.position ? state.position.poolLabel : "");

  if (pos <= 1) {
    toast(label + caveat, "err", { sticky: true });
    if (state.soundEnabled) notify.chime();
    startTitleFlash("(1) You're next");
  } else if (pos <= 2) {
    toast(label + caveat, "warn");
    if (state.soundEnabled) notify.chime();
  } else {
    toast(label + caveat, "");
  }
}

async function poll() {
  if (!state.enabled) return;
  try {
    const res = await api.phoneBoard();
    state.board = res;
    state.myName = res.myName;
    state.position = res.position;
    state.error = null;
    maybeAlert();
  } catch (err) {
    state.error = err.message || "Could not reach the phone monitor.";
  }
  state.loading = false;
  emit();
  if (state.enabled) timer = setTimeout(poll, POLL_MS);
}

function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = null;
  stopTitleFlash();
}

/** Called once at boot (see app.js). Reads the persisted preference and, if
 * already on, starts polling immediately -- a page reload while the monitor
 * is on must not require re-toggling it. */
export async function init() {
  try {
    const res = await api.settings();
    const s = (res && res.settings) || {};
    state.enabled = s.phoneMonitorEnabled === "true";
    state.threshold = Number(s.phoneAlertThreshold) || ALERT_THRESHOLD_DEFAULT;
    state.soundEnabled = s.phoneSoundEnabled !== "false";
  } catch { /* defaults stand */ }
  state.loading = false;
  emit();
  if (state.enabled) poll();
}

export async function setEnabled(next) {
  state.enabled = next;
  emit();
  await api.saveSettings({ phoneMonitorEnabled: String(next) }).catch(() => {});
  if (next) {
    // The toggle click is the user gesture autoplay needs -- prime it here
    // rather than waiting for the first alert to try and fail silently.
    state.audioBlocked = !notify.primeAudio();
    if (notify.permission() === "default") await notify.requestPermission();
    poll();
  } else {
    stopPolling();
  }
}
