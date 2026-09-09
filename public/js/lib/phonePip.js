/**
 * Document Picture-in-Picture pop-out for the phone queue -- v5 phase 4d,
 * made cross-tab-aware in v6 phase 3.
 *
 * A web page cannot make an ordinary browser window stay on top; the
 * Document PiP API (`documentPictureInPicture.requestWindow()`) is the one
 * browser surface that genuinely is always-on-top, hosting arbitrary DOM in
 * a real OS-level window. Its one hard requirement is a secure context --
 * `window.documentPictureInPicture` is simply `undefined` otherwise, which
 * is exactly what `tier()` below checks for directly (never user-agent
 * sniffing, per the plan's own constraint: the reason is always a secure
 * context or an old Chrome, and either way the fallback is identical).
 *
 * Reuses the `phoneMonitor` singleton from phase 3 for its content exactly
 * like the page and the dock do -- opening a pop-out adds a subscriber, not
 * a second poller or a second alert path.
 *
 * v6 phase 3: `documentPictureInPicture.requestWindow()` requires a user
 * gesture, and when the tab owning it dies no other tab can silently
 * reopen it -- no synthetic clicks, no open-on-load, ever. What's achievable
 * instead: never lose visibility, and make recovery one obvious click. This
 * module announces ownership of the pop-out over `tabSync`, so every other
 * tab knows one exists (and can ask to focus it, or notice it's gone and
 * offer a one-click restore via the dock) without ever trying to fake the
 * gesture itself. The pop-out owner also becomes the tabSync leader --
 * the tab with a floating window attached is the one least likely to be
 * closed and least likely to be discarded by Chrome's Memory Saver, so it's
 * the right tab to be polling.
 */

import * as phoneMonitor from "./phoneMonitor.js";
import { statusTone } from "./phoneMonitor.js";
import * as store from "./store.js";
import * as tabSync from "./tabSync.js";
import { h, mount } from "./dom.js";
import { connectButton } from "./connectLauncher.js";

const KEY_SIZE = "phonePip.size";
const KEY_PIP_WAS_OPEN = "phonePip.wasOpen";
const DEFAULT_SIZE = { width: 380, height: 520 };

let popupRef = null;
let pipOwnerTabId = null;
const ownershipListeners = new Set();

/** "pip" | "insecure-context" | "unsupported-browser". Feature-detected
 * directly -- never navigator.userAgent. */
export function tier() {
  if (typeof window.documentPictureInPicture !== "undefined") return "pip";
  return window.isSecureContext ? "unsupported-browser" : "insecure-context";
}

/** Whether *this* document owns a live PiP window -- the original,
 * document-scoped check. Still what the kill-rule subscriber below and
 * openPip()'s own re-entrancy guard need, since only this tab can call
 * .close()/.focus() on a window it actually holds. */
function isPipOpenLocally() {
  return typeof documentPictureInPicture !== "undefined" && !!documentPictureInPicture.window;
}

/** v6 phase 3: "is a pop-out open anywhere" -- cross-tab, via the ownership
 * announcement below, so a second QView tab never tries to open a competing
 * one (Chrome allows only one PiP window at a time regardless). */
export function isPipOpen() {
  return pipOwnerTabId != null || isPipOpenLocally();
}

export function isPipOwnerLocal() {
  return pipOwnerTabId === tabSync.tabId;
}

/** True from the moment a pop-out opens until its graceful close -- a crash
 * never clears it, which is exactly the signal the dock's restore banner
 * needs, whether the crash just happened or the browser has since
 * restarted entirely. */
export function pipWasOpen() {
  return store.get(KEY_PIP_WAS_OPEN, false);
}

export function isPopupOpen() {
  return !!(popupRef && !popupRef.closed);
}

function announceOwnership(isOpen) {
  pipOwnerTabId = isOpen ? tabSync.tabId : null;
  tabSync.broadcast("pip-owner", { tabId: tabSync.tabId, isOpen });
  if (isOpen) tabSync.setLeaderOverride(tabSync.tabId);
  else tabSync.clearLeaderOverride();
  for (const fn of ownershipListeners) fn(pipOwnerTabId, {});
}

/** Delivers the current owner id immediately, then again on every change --
 * the second argument carries `{ lostUngracefully: true }` exactly once,
 * the moment an owner disappears without a graceful close (crash, force
 * quit) -- the dock uses that to auto-expand. */
export function onOwnershipChange(fn) {
  ownershipListeners.add(fn);
  fn(pipOwnerTabId, {});
  return () => ownershipListeners.delete(fn);
}

/** A tab cannot focus another tab's PiP window directly -- it can only ask
 * the owner to. */
export function requestPipFocus() {
  tabSync.broadcast("pip-focus-request", { requestingTabId: tabSync.tabId });
}

tabSync.init(); // idempotent -- phoneMonitor.js also calls this
tabSync.onMessage("pip-owner", (payload) => {
  pipOwnerTabId = payload.isOpen ? payload.tabId : null;
  for (const fn of ownershipListeners) fn(pipOwnerTabId, {});
});
tabSync.onMessage("pip-focus-request", () => {
  if (isPipOpenLocally()) documentPictureInPicture.window.focus();
});
tabSync.onLeaderChange((leaderTabId) => {
  // The one ungraceful-loss signal: the tab we believe owns the pop-out has
  // stopped heartbeating, and we never got a graceful pip-owner{isOpen:false}
  // message for it (that path already nulls pipOwnerTabId directly, making
  // this condition false).
  if (pipOwnerTabId && leaderTabId !== pipOwnerTabId && !tabSync.isTabAlive(pipOwnerTabId)) {
    pipOwnerTabId = null;
    for (const fn of ownershipListeners) fn(null, { lostUngracefully: true });
  }
});

/**
 * Styles never carry over into a PiP document automatically. Cloning the
 * `<link>` elements (not inlining a duplicate copy of the CSS) means a
 * future edit to app.css needs no second file kept in sync. Waiting for
 * every clone's own load/error before the caller reveals content avoids the
 * flash-of-unstyled-content a naive "just append and go" would produce.
 */
function cloneStylesheets(doc) {
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  return Promise.all(links.map((link) => new Promise((resolve) => {
    const clone = link.cloneNode();
    clone.onload = resolve;
    clone.onerror = resolve; // one bad stylesheet must not hang the reveal forever
    doc.head.appendChild(clone);
  })));
}

/**
 * `buildContent(host, state, pipWindow)` is called once per phoneMonitor
 * update, exactly like a page's own paint(state) -- the caller owns
 * rendering, this module owns the window lifecycle. Must be called from a
 * user gesture (a button click), never from page load.
 */
export async function openPip(buildContent) {
  if (isPipOpenLocally()) { documentPictureInPicture.window.focus(); return; }
  if (pipOwnerTabId != null) { requestPipFocus(); return; } // defensive -- the UI shouldn't offer "Pop out" when another tab owns one

  const size = store.get(KEY_SIZE, DEFAULT_SIZE);
  const pipWindow = await documentPictureInPicture.requestWindow(size);
  await cloneStylesheets(pipWindow.document);
  pipWindow.document.body.className = document.body.className; // theme (light/dark) travels with it

  const host = pipWindow.document.body;
  const unsubscribe = phoneMonitor.subscribe((state) => buildContent(host, state, pipWindow));

  announceOwnership(true);
  store.set(KEY_PIP_WAS_OPEN, true);

  pipWindow.addEventListener("pagehide", () => {
    unsubscribe();
    announceOwnership(false);
    store.set(KEY_PIP_WAS_OPEN, false);
  }, { once: true });
  pipWindow.addEventListener("resize", () => {
    store.set(KEY_SIZE, { width: pipWindow.innerWidth, height: pipWindow.innerHeight });
  });
  // Position is never settable on a PiP window -- not attempted.
}

/** Tier 2: a plain named popup, so re-clicking focuses it instead of
 * opening a second one. No always-on-top guarantee, unlike tier 1. Out of
 * scope for v6 phase 3's cross-tab ownership -- the spec targets Document
 * PiP only. */
export function openPopupFallback() {
  if (isPopupOpen()) { popupRef.focus(); return; }
  popupRef = window.open("/phone", "qview-phone-popup", "width=380,height=520");
}

/**
 * Phase 4's own rule: a window that stays on top after the master toggle
 * (or the 5-minute-offline auto-off) turns the monitor off is a bug. This
 * subscriber is the one place that rule is enforced, regardless of which
 * of the two window kinds is open. v6 phase 2's "enabled" broadcast already
 * keeps every tab's local state.enabled in sync (including whichever tab
 * owns the pop-out), so this only needs the isPipOpenLocally() rename to
 * stay correct cross-tab -- it must only ever close a window this tab
 * actually holds.
 */
phoneMonitor.subscribe((state) => {
  if (state.enabled) return;
  if (isPipOpenLocally()) documentPictureInPicture.window.close();
  if (isPopupOpen()) popupRef.close();
});

/**
 * The same same-line/same-region pool `positionOf()` builds server-side,
 * sliced to whoever sits before me in the board's own order -- not a second
 * implementation of the filter that could disagree with the position count
 * itself, just reading the same decorated `board.agents` the board route
 * already sends (each non-federal agent carries its own `region`).
 *
 * Moved here from phone.js in v6 phase 3, so phoneDock.js's restore button
 * can call the exact same renderer /phone uses without lib/ importing from
 * pages/ (a direction this codebase never uses elsewhere).
 */
function agentsAheadOf(state) {
  const board = state.board;
  const r = state.position;
  if (!board || !board.ok || !r || r.position == null) return [];
  const mine = board.agents.find((a) => a.name === state.myName);
  if (!mine) return [];
  const pool = board.agents.filter((a) => !a.federal && a.region === mine.region);
  return pool.slice(0, r.ahead);
}

/**
 * v5 phase 4d: the pop-out's content -- a glance surface, not a page.
 * Reuses `STATUS_TONE`/`.phn-*` CSS verbatim (via the cloned stylesheet
 * above) rather than a second colour vocabulary, so the board, the page
 * and the pop-out never disagree about what amber means. Moved here from
 * phone.js in v6 phase 3 (see agentsAheadOf's comment above).
 */
export function pipContent(host, state) {
  const board = state.board;
  const mine = board && board.ok ? board.agents.find((a) => a.name === state.myName) : null;
  const ringing = mine && (mine.statusClass === "ringing" || mine.statusClass === "accepting_call");
  host.classList.toggle("phn-ringing", !!ringing);

  if (!state.enabled) {
    mount(host, h("div", { class: "phn-pip" }, h("p", { class: "dim", text: "Phone monitor is off." }), connectButton(state)));
    return;
  }
  if (!board || !board.ok) {
    mount(host, h("div", { class: "phn-pip" }, h("p", { class: "dim", text: (board && board.reason) || "Cannot read the board." }), connectButton(state)));
    return;
  }
  if (!mine) {
    mount(host, h("div", { class: "phn-pip" }, h("p", { class: "dim", text: "\"" + state.myName + "\" is not on the board right now." }), connectButton(state)));
    return;
  }

  const r = state.position;
  const pos = r ? r.position : null;
  const ahead = agentsAheadOf(state);

  mount(host, h("div", { class: "phn-pip" },
    h("div", { class: `phn-pip-pos ${pos != null && pos <= state.threshold ? "is-urgent" : ""}`, text: pos != null ? "#" + pos : "—" }),
    r ? h("div", { class: "dim", text: "of " + r.poolSize + " in " + r.poolLabel }) : null,
    h("div", { class: "phn-pip-status" },
      h("span", { class: `chip ${statusTone(mine.statusClass)}`, text: mine.statusText }),
      h("span", { class: "dim", text: "  " + mine.duration })),
    h("div", { class: "dim mono", text: board.queuedAgents + " AMER · " + board.queuedFederal + " Federal" }),
    ahead.length
      ? h("div", { class: "phn-pip-ahead" },
          h("p", { class: "eyebrow", text: "Ahead of me" }),
          ahead.map((a) => h("div", { class: "phn-pip-ahead-row" },
            h("span", { text: a.name }),
            h("span", { class: "dim mono", text: a.duration }))))
      : null,
    board.stale ? h("p", { class: "dim", text: "Stale — the board did not respond just now." }) : null,
    connectButton(state)));
}
