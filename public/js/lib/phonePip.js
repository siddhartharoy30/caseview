/**
 * Document Picture-in-Picture pop-out for the phone queue -- v5 phase 4d.
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
 */

import * as phoneMonitor from "./phoneMonitor.js";
import * as store from "./store.js";

const KEY_SIZE = "phonePip.size";
const DEFAULT_SIZE = { width: 380, height: 520 };

let popupRef = null;

/** "pip" | "insecure-context" | "unsupported-browser". Feature-detected
 * directly -- never navigator.userAgent. */
export function tier() {
  if (typeof window.documentPictureInPicture !== "undefined") return "pip";
  return window.isSecureContext ? "unsupported-browser" : "insecure-context";
}

export function isPipOpen() {
  return typeof documentPictureInPicture !== "undefined" && !!documentPictureInPicture.window;
}

export function isPopupOpen() {
  return !!(popupRef && !popupRef.closed);
}

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
  if (isPipOpen()) { documentPictureInPicture.window.focus(); return; }

  const size = store.get(KEY_SIZE, DEFAULT_SIZE);
  const pipWindow = await documentPictureInPicture.requestWindow(size);
  await cloneStylesheets(pipWindow.document);
  pipWindow.document.body.className = document.body.className; // theme (light/dark) travels with it

  const host = pipWindow.document.body;
  const unsubscribe = phoneMonitor.subscribe((state) => buildContent(host, state, pipWindow));

  pipWindow.addEventListener("pagehide", () => unsubscribe(), { once: true });
  pipWindow.addEventListener("resize", () => {
    store.set(KEY_SIZE, { width: pipWindow.innerWidth, height: pipWindow.innerHeight });
  });
  // Position is never settable on a PiP window -- not attempted.
}

/** Tier 2: a plain named popup, so re-clicking focuses it instead of
 * opening a second one. No always-on-top guarantee, unlike tier 1. */
export function openPopupFallback() {
  if (isPopupOpen()) { popupRef.focus(); return; }
  popupRef = window.open("/phone", "qview-phone-popup", "width=380,height=520");
}

/**
 * Phase 4's own rule: a window that stays on top after the master toggle
 * (or the 5-minute-offline auto-off) turns the monitor off is a bug. This
 * subscriber is the one place that rule is enforced, regardless of which
 * of the two window kinds is open.
 */
phoneMonitor.subscribe((state) => {
  if (state.enabled) return;
  if (isPipOpen()) documentPictureInPicture.window.close();
  if (isPopupOpen()) popupRef.close();
});
