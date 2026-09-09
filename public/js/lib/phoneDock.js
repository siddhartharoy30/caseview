/**
 * Docked phone-queue mini-panel -- v5 phase 4b (build order's "tier 3").
 *
 * A compact panel pinned to a corner of QView, subscribing to the same
 * `phoneMonitor` singleton every other surface uses (the page, and from
 * phase 4d, the Document PiP pop-out) -- no fetch or alert logic of its own,
 * per the "one poll, one alert" constraint. Worth building on its own merit,
 * not just as a fallback for browsers without Document PiP: it means the
 * position stays visible while working the Queue or a case, which the page
 * alone can't do.
 *
 * Modeled on `tzstrip.js`'s shape: a fixed top-level DOM slot in index.html,
 * a module-level `init...()` called once from app.js's boot(), so it
 * survives every route change untouched.
 */

import { h, mount } from "./dom.js";
import * as store from "./store.js";
import * as phoneMonitor from "./phoneMonitor.js";
import { statusTone } from "./phoneMonitor.js";
import { connectButton } from "./connectLauncher.js";

const KEY_COLLAPSED = "phoneDock.collapsed";

export function initPhoneDock() {
  const container = document.getElementById("phoneDock");
  if (!container) return;

  let collapsed = store.get(KEY_COLLAPSED, false);

  function setCollapsed(next) {
    collapsed = next;
    store.set(KEY_COLLAPSED, next);
    paint(phoneMonitor.getState());
  }

  function body(state) {
    const board = state.board;
    const mine = board && board.ok ? board.agents.find((a) => a.name === state.myName) : null;
    const r = state.position;
    const pos = r ? r.position : null;
    const urgent = pos != null && pos <= state.threshold;

    if (!board || !board.ok) {
      return h("div", { class: "phn-dock-body" },
        h("p", { class: "dim", text: (board && board.reason) || "Cannot read the board." }));
    }
    if (!mine) {
      return h("div", { class: "phn-dock-body" },
        h("p", { class: "dim", text: "Not on the board right now." }));
    }

    return h("div", { class: "phn-dock-body" },
      h("div", { class: `phn-dock-pos ${urgent ? "is-urgent" : ""}`, text: pos != null ? "#" + pos : "—" }),
      r ? h("div", { class: "dim", text: "of " + r.poolSize + " in " + r.poolLabel }) : null,
      h("div", { class: "phn-dock-status" },
        h("span", { class: `chip ${statusTone(mine.statusClass)}`, text: mine.statusText }),
        h("span", { class: "dim", text: "  " + mine.duration })),
      h("div", { class: "dim mono", text: board.queuedAgents + " AMER · " + board.queuedFederal + " Federal" }),
      board.stale ? h("div", { class: "dim", text: "Stale — last good read" }) : null);
  }

  function paint(state) {
    // Unconditional on state.enabled (v6 phase 1) -- the dock's Connect
    // launcher is reachable whether or not the monitor is on. state.loading
    // starts true and flips false exactly once, in phoneMonitor's post-auth
    // init(), so this still hides the dock on the login screen without
    // depending on the toggle.
    container.hidden = state.loading;
    mount(container,
      h("div", { class: "phn-dock-head" },
        h("span", { class: "eyebrow", text: "Phone queue" }),
        h("div", { class: "spacer" }),
        h("button", {
          class: "icon-btn sm", type: "button", title: collapsed ? "Expand" : "Collapse",
          onclick: () => setCollapsed(!collapsed),
        }, collapsed ? "+" : "–")),
      connectButton(state, { compact: true }),
      collapsed || !state.enabled ? null : body(state));
  }

  phoneMonitor.subscribe(paint);
}
