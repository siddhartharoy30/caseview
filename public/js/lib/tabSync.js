/**
 * Cross-tab leader election -- v6 phase 2.
 *
 * Every open QView tab runs its own `phoneMonitor` module instance (module
 * state is per JS realm, i.e. per tab), so with no coordination N tabs mean
 * N poll loops and N separate alerts for the same single position change.
 * This module elects exactly one leader among the open tabs; phoneMonitor.js
 * uses it to decide who polls and who alerts, everyone else just listens.
 *
 * `BroadcastChannel` carries messages between live tabs, but says nothing
 * about a tab that was killed rather than closed gracefully -- a
 * `localStorage` heartbeat (via store.js) is the liveness signal for that.
 * Lowest tab id among tabs currently heartbeating wins: deterministic, so
 * two tabs electing at once converge without a negotiation round.
 */

import * as store from "./store.js";

const CHANNEL_NAME = "qview-phone";
const HEARTBEAT_MS = 2000;
const STALE_MS = 5000;
const HEARTBEATS_KEY = "tabSync.heartbeats";

/** crypto.randomUUID() is spec'd as secure-context-only (HTTPS/localhost).
 * QView's live listener is plain HTTP on a LAN IP -- not a secure context --
 * so this falls back to a Math.random id. Uniqueness among a handful of
 * open tabs is all this needs, not cryptographic strength. */
function generateTabId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export const tabId = generateTabId();

let channel = null;
let inited = false;
let currentLeaderId = null;
let leaderOverrideId = null;
let heartbeatTimer = null;

const leaderListeners = new Set();
const messageListeners = new Map(); // type -> Set<fn>

function readHeartbeats() {
  return store.get(HEARTBEATS_KEY, {});
}

/** Writes this tab's own timestamp and prunes any other tab's entry that's
 * gone stale, so the map never grows unbounded even for tabs that die
 * without ever running `pagehide` (crash, force-quit). */
function writeHeartbeat() {
  store.update(HEARTBEATS_KEY, {}, (prev) => {
    const next = { ...prev, [tabId]: Date.now() };
    const now = Date.now();
    for (const id of Object.keys(next)) {
      if (id !== tabId && now - next[id] > STALE_MS) delete next[id];
    }
    return next;
  });
}

function removeHeartbeat() {
  store.update(HEARTBEATS_KEY, {}, (prev) => {
    const next = { ...prev };
    delete next[tabId];
    return next;
  });
}

function liveTabIds() {
  const hb = readHeartbeats();
  const now = Date.now();
  return Object.keys(hb).filter((id) => id === tabId || now - hb[id] <= STALE_MS);
}

function computeLeader() {
  const ids = liveTabIds();
  if (leaderOverrideId) {
    if (ids.includes(leaderOverrideId)) return leaderOverrideId;
    leaderOverrideId = null; // self-heal: the pinned (pop-out owner) tab is gone
  }
  return ids.length ? ids.sort()[0] : null;
}

function recomputeAndNotify() {
  const next = computeLeader();
  if (next === currentLeaderId) return;
  currentLeaderId = next;
  for (const fn of leaderListeners) fn(currentLeaderId);
}

function dispatchMessage(envelope) {
  if (!envelope || envelope.tabId === tabId) return; // BroadcastChannel never echoes to sender; defensive only
  const set = messageListeners.get(envelope.type);
  if (set) for (const fn of set) fn(envelope.payload, envelope.tabId);
}

/** Idempotent -- safe to call from more than one module (phoneMonitor.js
 * and phonePip.js both do). */
export function init() {
  if (inited) return;
  inited = true;

  channel = ("BroadcastChannel" in window) ? new BroadcastChannel(CHANNEL_NAME) : null;
  if (channel) channel.onmessage = (ev) => dispatchMessage(ev.data);

  writeHeartbeat();
  recomputeAndNotify();
  heartbeatTimer = setInterval(() => { writeHeartbeat(); recomputeAndNotify(); }, HEARTBEAT_MS);

  window.addEventListener("storage", (e) => {
    if (e.key === "qview." + HEARTBEATS_KEY) recomputeAndNotify();
  });

  window.addEventListener("pagehide", () => {
    if (isLeader()) broadcast("abdicate", { tabId });
    removeHeartbeat();
  });

  onMessage("abdicate", () => recomputeAndNotify());
  onMessage("leader-override", (payload) => { leaderOverrideId = payload.overrideTabId; recomputeAndNotify(); });

  // document.wasDiscarded: a tab Chrome's Memory Saver discards and later
  // restores re-evaluates this module from scratch -- fresh tabId, fresh
  // currentLeaderId (null) -- so it naturally rejoins as a follower through
  // the ordinary election above. No special case needed; this comment
  // exists to document why, not to branch on it.
}

export function isLeader() {
  return currentLeaderId === tabId;
}

export function isTabAlive(id) {
  return liveTabIds().includes(id);
}

/** Delivers the current leader id immediately, then again on every change --
 * same "no special-casing nothing-yet" convention as phoneMonitor.subscribe. */
export function onLeaderChange(fn) {
  leaderListeners.add(fn);
  fn(currentLeaderId);
  return () => leaderListeners.delete(fn);
}

/** Pins leadership to a specific tab regardless of id ordering -- used by
 * phonePip.js so the pop-out owner becomes (and stays) the leader. */
export function setLeaderOverride(overrideTabId) {
  leaderOverrideId = overrideTabId;
  broadcast("leader-override", { overrideTabId });
  recomputeAndNotify();
}

export function clearLeaderOverride() {
  leaderOverrideId = null;
  broadcast("leader-override", { overrideTabId: null });
  recomputeAndNotify();
}

export function broadcast(type, payload) {
  if (channel) channel.postMessage({ type, tabId, payload });
}

export function onMessage(type, fn) {
  if (!messageListeners.has(type)) messageListeners.set(type, new Set());
  messageListeners.get(type).add(fn);
  return () => messageListeners.get(type).delete(fn);
}
