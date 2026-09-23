/**
 * Document Picture-in-Picture shift console -- v5 phase 4d (phone-only pop-out),
 * made cross-tab-aware in v6 phase 3, turned into a multi-pane console in v9
 * part 3.
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
 * v9 part 3: Chrome allows exactly one Document PiP window per browser, so a
 * second always-on-top window for the case queue is not possible -- the
 * phone monitor already occupies the one available slot. So this module
 * stopped being a phone-only pop-out and became a console: one window,
 * three independent panes (ticker, phone, queue), each owning its own
 * subscribe-and-paint cycle into its own container under the PiP body,
 * rather than one subscriber owning the whole body the way the phone pane
 * used to. Window lifecycle, sizing, stylesheet cloning, pagehide handling
 * and cross-tab ownership below are unchanged from v5/v6 -- this release
 * only changes what gets built inside the window once it opens.
 *
 * Reuses the `phoneMonitor` singleton from phase 3 for the phone pane's
 * content exactly like the page and the dock do -- opening the console adds
 * a subscriber, not a second poller or a second alert path.
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
import { h, mount, icon } from "./dom.js";
import { button, toast } from "./ui.js";
import * as consoleQueue from "./consoleQueue.js";
import * as fmt from "./fmt.js";
import { navigate } from "../router.js";
import { api } from "./api.js";

const DEFAULT_WATCH_POLL_INTERVAL_S = 60;

const KEY_SIZE = "phonePip.size";
const KEY_PIP_WAS_OPEN = "phonePip.wasOpen";
const KEY_CONSOLE_THEME = "shiftConsole.theme";
// Taller default than the phone-only pop-out's old 380x520 -- there are now
// up to three stacked panes. Still just a starting point: the resize
// listener below persists whatever the operator actually settles on.
const DEFAULT_SIZE = { width: 380, height: 640 };

let popupRef = null;
let pipOwnerTabId = null;
const ownershipListeners = new Set();

/** "pip" | "insecure-context" | "unsupported-browser". Feature-detected
 * directly -- never navigator.userAgent.
 *
 * Checks isSecureContext FIRST, not just whether `documentPictureInPicture`
 * is defined -- this module's own original assumption ("the property is
 * simply undefined otherwise") turned out not to hold on every Chrome
 * build: the property can exist on `window` in an insecure context (plain
 * http:// on a bare private IP, e.g. QView's own default deployment --
 * see server.ts's TLS listener comment) while `requestWindow()` still
 * rejects when actually called. Checking the real precondition directly
 * avoids depending on that assumption at all. */
export function tier() {
  if (!window.isSecureContext) return "insecure-context";
  return typeof window.documentPictureInPicture !== "undefined" ? "pip" : "unsupported-browser";
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

/** True from the moment the console opens until its graceful close -- a
 * crash never clears it, which is exactly the signal the dock's restore
 * banner needs, whether the crash just happened or the browser has since
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
 * future edit to app.css or console.css needs no second file kept in sync
 * -- whatever stylesheets the main document links, the console gets too.
 * Waiting for every clone's own load/error before the caller reveals
 * content avoids the flash-of-unstyled-content a naive "just append and go"
 * would produce.
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
 * One collapsible pane shell -- the ticker, phone and queue panes (v9 part
 * 3) all use this instead of each inventing its own head/collapse markup.
 * `title` is the always-visible label ("PHONE"); `setMeta(text)` updates the
 * one-line summary next to it, visible whether or not the pane is
 * collapsed, so a collapsed pane still reads at a glance (the spec's own
 * mockup: a collapsed ticker line still shows the price).
 *
 * Collapse state persists per pane, per the same "<owner>.collapsed"
 * localStorage idiom phoneDock.js and tzstrip.js already use.
 */
function consolePane(key, title, { defaultCollapsed = false } = {}) {
  const collapseKey = `shiftConsole.${key}.collapsed`;
  let collapsed = store.get(collapseKey, defaultCollapsed);

  const metaEl = h("span", { class: "qv-console-pane-meta" });
  const caretEl = icon(["M9 6l6 6-6 6"], 13);
  caretEl.classList.add("qv-console-pane-caret");
  const body = h("div", { class: "qv-console-pane-body" });

  const head = h("div", {
    class: "qv-console-pane-head",
    role: "button",
    tabindex: "0",
    "aria-expanded": String(!collapsed),
    onclick: () => toggle(),
    onkeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    },
  },
    h("span", { class: "qv-console-pane-title", text: title }),
    metaEl,
    caretEl);

  const root = h("div", { class: "qv-console-pane", "data-collapsed": String(collapsed) }, head, body);

  function toggle() {
    collapsed = !collapsed;
    root.dataset.collapsed = String(collapsed);
    head.setAttribute("aria-expanded", String(!collapsed));
    store.set(collapseKey, collapsed);
  }

  return {
    root,
    body,
    setMeta(text) { metaEl.textContent = text || ""; },
  };
}

/** One-line summary shown in the phone pane's header, visible even while
 * collapsed -- "#1 of 3 · AMER/IN", matching the spec's own mockup. */
function phoneMetaText(state) {
  if (!state.enabled) return "off";
  const board = state.board;
  if (!board || !board.ok) return "—";
  const mine = board.agents.find((a) => a.name === state.myName);
  if (!mine) return "not on board";
  const r = state.position;
  if (!r || r.position == null) return mine.statusText || "";
  return "#" + r.position + " of " + r.poolSize + (r.poolLabel ? " · " + r.poolLabel : "");
}

/** Reads the persisted console-only theme preference and applies it to the
 * PiP document -- independent of the main app's own light/dark setting,
 * which the className clone above already copied in. Defaults to dark
 * (the "instrument panel" mood), applied *after* that clone so it wins. */
function applyConsoleTheme(pipWindow) {
  const theme = store.get(KEY_CONSOLE_THEME, "dark");
  pipWindow.document.body.classList.toggle("light", theme === "light");
  pipWindow.document.body.classList.toggle("dark", theme !== "light");
}

function consoleThemeButton(pipWindow) {
  return h("button", {
    class: "qv-console-theme-btn", type: "button", title: "Toggle console theme",
    onclick: () => {
      const next = pipWindow.document.body.classList.contains("light") ? "dark" : "light";
      pipWindow.document.body.classList.toggle("light", next === "light");
      pipWindow.document.body.classList.toggle("dark", next !== "light");
      store.set(KEY_CONSOLE_THEME, next);
    },
  }, icon(["M20 14a8 8 0 01-10-10 8 8 0 1010 10z"], 13));
}

/** Last word of a contact's full name -- "contact surname" per the spec's
 * compact row, since a 380px pane has no room for a full name next to a
 * case number, priority chip and age. */
function surname(contactName) {
  const parts = String(contactName || "").trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1] : "";
}

function openCaseFromConsole(caseNumber) {
  // The PiP window's content runs in the same script realm as the tab that
  // opened it -- no cross-window messaging needed, unlike requestPipFocus()
  // above (which exists because a *different* tab can't reach into this
  // one at all). window here is always the opening tab's window.
  window.focus();
  navigate("/case/" + encodeURIComponent(caseNumber));
}

function queueRow(c) {
  const urgent = fmt.priorityClass(c.priority) === "p1" || c.isEscalated;
  const age = c.createdDate ? fmt.ageDays(c.createdDate).days + "d" : "—";
  return h("div", {
    class: `qv-console-queue-row ${urgent ? "is-urgent" : ""}`,
    role: "button", tabindex: "0",
    onclick: () => openCaseFromConsole(c.caseNumber),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCaseFromConsole(c.caseNumber); } },
  },
    h("span", { class: "mono qv-console-queue-case", text: c.caseNumber }),
    h("span", { class: `chip ${fmt.priorityClass(c.priority)}`, text: c.priority || "—" }),
    h("span", { class: "qv-console-queue-contact", text: surname(c.contactName) }),
    h("span", { class: "dim mono qv-console-queue-age", text: age }));
}

/**
 * The queue pane's body: needs-reply cases in full, everything else
 * collapsed behind one expandable summary line (a second, inner collapse
 * independent of the pane's own head-collapse). `showAllRef` is a one-item
 * array used as a mutable box so this closes over the *same* boolean across
 * repeated calls -- both the 15s local re-render and a real data refresh
 * call this function again and neither should reset the operator's choice
 * to expand "everything else".
 */
function renderQueueBody(pane, snap, showAllRef) {
  if (!snap.loaded) {
    mount(pane.body, h("p", { class: "dim", text: "Loading…" }));
    return;
  }
  if (snap.error) {
    mount(pane.body, h("p", { class: "dim", text: "Could not load the queue." }));
    return;
  }
  const needReply = snap.needReply;
  const rest = snap.cases.filter((c) => !needReply.includes(c));

  const restSummary = rest.length
    ? h("div", {
        class: "qv-console-queue-rest-toggle", role: "button", tabindex: "0",
        onclick: () => { showAllRef[0] = !showAllRef[0]; renderQueueBody(pane, snap, showAllRef); },
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            showAllRef[0] = !showAllRef[0];
            renderQueueBody(pane, snap, showAllRef);
          }
        },
      }, `— ${rest.length} more`)
    : null;

  mount(pane.body,
    needReply.length ? needReply.map(queueRow) : h("p", { class: "dim", text: "Nothing needs a reply right now." }),
    restSummary,
    showAllRef[0] ? rest.map(queueRow) : null);
}

function queuePaneMeta(snap) {
  if (!snap.loaded) return "…";
  if (snap.error) return "error";
  return `${snap.needReply.length} need reply · ${snap.waitingOnCustomerCount} waiting on customer`;
}

const TICKER_POLL_MS = 60_000;

/** The always-visible header line -- shown whether or not the pane is
 * collapsed, same as the phone pane's position summary, so a collapsed
 * ticker still reads as one quiet line per the spec's own mockup. */
function tickerMetaText(quote) {
  if (!quote) return "no quote yet";
  const sign = quote.change >= 0 ? "+" : "";
  return quote.price.toFixed(2) + "  " + sign + quote.changePercent.toFixed(2) + "%" + (quote.marketOpen ? "" : " · closed");
}

/** Expanded detail -- deliberately thin: no chart, no history, no alerts,
 * per the spec's own "this is a glance, not a trading tool." */
function tickerBody(quote) {
  if (!quote) return h("p", { class: "dim", text: "No quote yet." });
  const up = quote.change >= 0;
  const sign = up ? "+" : "";
  return h("div", { class: "qv-console-ticker-detail" },
    h("span", { class: `mono ${up ? "qv-console-ticker-up" : "qv-console-ticker-down"}`,
      text: sign + quote.change.toFixed(2) + " (" + sign + quote.changePercent.toFixed(2) + "%)" }),
    h("span", { class: "dim", text: "prev close " + quote.previousClose.toFixed(2) }),
    !quote.marketOpen ? h("span", { class: "dim", text: "market closed" }) : null);
}

/**
 * Polls /api/ticker every 60s while the console is open -- cheap on the
 * client; the server-side cache and market-hours gate (src/ticker.ts) are
 * what actually control upstream traffic, so there's no leader-election
 * gating needed here the way the Salesforce watch poll needs it. The pane
 * stays hidden ({enabled:false}) until a key is actually configured, per
 * the spec's "no key, no pane, no error."
 */
function startTickerPoll(pane, cleanups) {
  let timer = null;
  let stopped = false;

  async function tick() {
    try {
      const data = await api.ticker();
      pane.root.hidden = !data.enabled;
      if (data.enabled) {
        pane.setMeta(tickerMetaText(data.quote));
        mount(pane.body, tickerBody(data.quote));
      }
    } catch {
      // Transient network hiccup -- the next tick tries again. The pane
      // stays in whatever state it was already in rather than flashing to
      // hidden on one bad request.
    }
    if (!stopped) timer = setTimeout(tick, TICKER_POLL_MS);
  }

  tick();
  cleanups.push(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });
}

/**
 * Builds the console's fixed pane skeleton once and wires each pane's
 * subscription into it. `cleanups` collects unsubscribe/stop functions the
 * pagehide handler runs on close -- each pane pushes its own cleanup into
 * the same array rather than this function growing a bespoke teardown path
 * per pane.
 */
function buildConsole(host, pipWindow, cleanups) {
  host.classList.add("qv-console");

  // Collapsed by default (per spec) -- hidden entirely, not just collapsed,
  // until the first /api/ticker response confirms the feature is actually
  // configured. "No key, no pane, no error" means no visible placeholder
  // either while that first response is in flight.
  const tickerPane = consolePane("ticker", "RBRK", { defaultCollapsed: true });
  tickerPane.root.hidden = true;
  const phonePane = consolePane("phone", "PHONE");
  const queuePane = consolePane("queue", "QUEUE");
  mount(host, consoleThemeButton(pipWindow), tickerPane.root, phonePane.root, queuePane.root);

  startTickerPoll(tickerPane, cleanups);

  const unsubPhone = phoneMonitor.subscribe((state) => {
    phonePane.setMeta(phoneMetaText(state));
    pipContent(phonePane.body, state, pipWindow);
  });
  cleanups.push(unsubPhone);

  // The "everything else" disclosure's state must survive both a real data
  // refresh and the 15s no-network re-render below -- a plain closure
  // variable captured by both would work too, but a one-item array makes
  // the "this is a shared mutable box, not a fresh copy" intent explicit.
  const showAllRef = [false];
  const unsubQueue = consoleQueue.subscribe((snap) => {
    queuePane.setMeta(queuePaneMeta(snap));
    renderQueueBody(queuePane, snap, showAllRef);
  });
  cleanups.push(unsubQueue);
  consoleQueue.refresh();

  // Free local re-render: ages and the "Nd" countdown-style figures move
  // even though the underlying data hasn't -- no network call, per the
  // spec's own "the UI re-render at 15 seconds is free" framing. A real
  // data refresh (initial load, or a watch-poll-detected change below) goes
  // through consoleQueue.refresh() instead, which is a separate, explicit
  // call.
  const queueTicker = setInterval(() => renderQueueBody(queuePane, consoleQueue.getSnapshot(), showAllRef), 15000);
  cleanups.push(() => clearInterval(queueTicker));

  startWatchPoll(cleanups);
}

/** How often the watch poll hits /api/console/watch-poll -- read once per
 * console open, not re-checked mid-session (same "takes effect on the next
 * cycle" trade-off syncIntervalMinutes already has). */
async function watchPollIntervalMs() {
  try {
    const res = await api.settings();
    const s = Number(res.settings && res.settings.watchPollIntervalSeconds);
    return (Number.isFinite(s) && s > 0 ? s : DEFAULT_WATCH_POLL_INTERVAL_S) * 1000;
  } catch {
    return DEFAULT_WATCH_POLL_INTERVAL_S * 1000;
  }
}

/**
 * Leader-gated, self-rescheduling (same idiom as phoneMonitor.js's poll() --
 * a setTimeout loop, not setInterval, so a slow request can't overlap the
 * next tick), started only while the console is open. The server is the
 * authoritative gate on the coverage window (withinActiveWindow()) -- it
 * no-ops outside it without logging a call or touching Salesforce, so this
 * doesn't duplicate that timezone math on the client. A three-tabs-open
 * scenario naturally produces one poll, not three: only the leader tab
 * (the one owning the console, per announceOwnership()'s
 * setLeaderOverride()) ever calls the endpoint.
 */
function startWatchPoll(cleanups) {
  let timer = null;
  let stopped = false;

  (async () => {
    const intervalMs = await watchPollIntervalMs();
    if (stopped) return; // console closed before settings even finished loading

    const tick = async () => {
      if (tabSync.isLeader()) {
        try {
          const result = await api.consoleWatchPoll();
          if (result && result.changed) consoleQueue.refresh();
        } catch {
          // Transient network hiccup -- the next tick tries again, same as
          // every other poll in this app.
        }
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    timer = setTimeout(tick, intervalMs);
  })();

  cleanups.push(() => {
    stopped = true;
    if (timer) clearTimeout(timer);
  });
}

/**
 * `openPip()` must be called from a user gesture (a button click), never
 * from page load.
 */
export async function openPip() {
  if (isPipOpenLocally()) { documentPictureInPicture.window.focus(); return; }
  if (pipOwnerTabId != null) { requestPipFocus(); return; } // defensive -- the UI shouldn't offer "Pop out" when another tab owns one

  const size = store.get(KEY_SIZE, DEFAULT_SIZE);
  let pipWindow;
  try {
    pipWindow = await documentPictureInPicture.requestWindow(size);
  } catch (err) {
    // Without this, a rejected requestWindow() (stale user-gesture, the
    // site permission toggled off, a stored size the browser won't accept,
    // etc.) is an unhandled promise rejection -- invisible to the operator,
    // who just sees the click do nothing. Surfacing it is the whole fix;
    // what it actually says decides what (if anything) needs fixing next.
    toast(`Could not open the shift console: ${err && err.message ? err.message : err}`, "err");
    return;
  }
  await cloneStylesheets(pipWindow.document);
  pipWindow.document.body.className = document.body.className; // app theme/density travel with it
  applyConsoleTheme(pipWindow); // then the console's own theme preference wins

  const host = pipWindow.document.body;
  const cleanups = [];
  buildConsole(host, pipWindow, cleanups);

  announceOwnership(true);
  store.set(KEY_PIP_WAS_OPEN, true);

  pipWindow.addEventListener("pagehide", () => {
    for (const unsubscribe of cleanups) unsubscribe();
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
 * Pop-out control: shows the best available tier and never renders a
 * button that does nothing. Moved here from phone.js (v8 follow-on) so the
 * dock can offer the exact same trigger the /phone page does -- previously
 * the dock only ever showed a *conditional* "Restore pop-out" banner (only
 * after a pop-out had been opened once and then lost), with no way to
 * start one for the first time without visiting /phone. When another tab
 * already owns the pop-out, this offers "Focus pop-out" instead of trying
 * (and failing) to open a second one -- Chrome allows only one PiP window
 * at a time regardless of tab.
 */
export function popoutRow(state) {
  if (!state.enabled) return null;
  const t = tier();

  if (t === "pip") {
    if (isPipOpen() && !isPipOwnerLocal()) {
      return h("div", { class: "phn-toggle-row" },
        button("Focus pop-out", { small: true, onclick: () => requestPipFocus() }),
        h("span", { class: "dim", text: "Open in another tab." }));
    }
    return h("div", { class: "phn-toggle-row" },
      button("Pop out", { small: true, onclick: () => openPip() }),
      h("span", { class: "dim", text: "Opens an always-on-top window." }));
  }

  const why = t === "insecure-context"
    ? "Always-on-top needs QView on https or localhost."
    : "Always-on-top needs a newer Chrome.";
  return h("div", { class: "phn-toggle-row" },
    button("Pop out (window)", { small: true, onclick: () => openPopupFallback() }),
    h("span", { class: "dim", text: why }));
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
 * The phone pane's content -- a glance surface, not a page. Reuses
 * `STATUS_TONE`/`.phn-*` CSS verbatim (via the cloned stylesheet above)
 * rather than a second colour vocabulary, so the board, the page and the
 * console never disagree about what amber means. Moved here from phone.js
 * in v6 phase 3 (see agentsAheadOf's comment above); in v9 part 3 this now
 * paints into its own pane container instead of the whole PiP body (see
 * buildConsole()) -- the markup and data logic below are unchanged.
 *
 * v8 follow-on: deliberately thinner than the dock/page here on purpose --
 * no queued-caller counts, no Connect launcher. Both stay on the dock and
 * /phone; this is a request specifically for the floating window, which is
 * meant to be glanced at, not acted from.
 */
export function pipContent(host, state) {
  const board = state.board;
  const mine = board && board.ok ? board.agents.find((a) => a.name === state.myName) : null;
  const ringing = mine && (mine.statusClass === "ringing" || mine.statusClass === "accepting_call");
  host.ownerDocument.body.classList.toggle("phn-ringing", !!ringing);

  if (!state.enabled) {
    mount(host, h("div", { class: "phn-pip" }, h("p", { class: "dim", text: "Phone monitor is off." })));
    return;
  }
  if (!board || !board.ok) {
    mount(host, h("div", { class: "phn-pip" }, h("p", { class: "dim", text: (board && board.reason) || "Cannot read the board." })));
    return;
  }
  if (!mine) {
    mount(host, h("div", { class: "phn-pip" }, h("p", { class: "dim", text: "\"" + state.myName + "\" is not on the board right now." })));
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
    ahead.length
      ? h("div", { class: "phn-pip-ahead" },
          h("p", { class: "eyebrow", text: "Ahead of me" }),
          ahead.map((a) => h("div", { class: "phn-pip-ahead-row" },
            h("span", { text: a.name }),
            h("span", { class: "dim mono", text: a.duration }))))
      : null,
    board.stale ? h("p", { class: "dim", text: "Stale — the board did not respond just now." }) : null));
}
