/**
 * Phone queue monitor page -- v4 phase 6, collapsed to a subscriber in v5
 * phase 3.
 *
 * All state, polling and alerting now live in `lib/phoneMonitor.js`, started
 * once at boot (see app.js) and independent of whether this page is ever
 * mounted -- the whole point of a phone alert is that I am *not* looking at
 * QView. This page (and, from phase 4b/4d on, the docked panel and the
 * pop-out) is a pure `subscribe()` callback: it renders whatever the
 * singleton hands it and never fetches or alerts on its own, which is the
 * concrete mechanism behind "one poll, one alert" once more than one surface
 * exists at a time.
 */

import { h, mount } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { toast, toastError } from "../lib/ui.js";
import { banner, emptyState, button, dialog, field, select } from "../lib/ui.js";
import { page, pageHead, cardHead, eyebrow } from "./_shared.js";
import * as phoneMonitor from "../lib/phoneMonitor.js";
import { statusTone } from "../lib/phoneMonitor.js";

/** v5 phase 2: any non-federal row is clickable, so a wrong classification
 * can always be corrected later, not just an unclassified one. */
function openClassifyDialog(name, currentRegion) {
  const sel = select(
    [{ value: "india", label: "India" }, { value: "us", label: "US" }, { value: "unknown", label: "Unclassified" }],
    currentRegion || "unknown",
    () => {},
  );
  const d = dialog({
    title: "Classify " + name,
    body: h("div", {}, field("Region", sel)),
    actions: (close) => [
      h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
      h("button", { class: "btn primary", onclick: () => close(sel.value) }, "Save"),
    ],
  });
  d.onClose(async (region) => {
    if (!region) return;
    try {
      await api.savePhoneRoster({ name, region });
      toast(name + " classified as " + (region === "unknown" ? "unclassified" : region === "us" ? "US" : "India"));
      phoneMonitor.refreshNow();
    } catch (err) {
      toastError(err);
    }
  });
}

function statusCard(state) {
  const board = state.board;
  const mine = board && board.ok ? board.agents.find((a) => a.name === state.myName) : null;

  if (!state.enabled) {
    return h("div", { class: "card phn-status-card" },
      h("div", { class: "card-body" },
        emptyState({
          title: "Phone monitor is off",
          message: "Turn it on to see your live position in the AMER phone queue.",
          iconName: "clock",
        })));
  }
  if (!board || !board.ok) {
    return h("div", { class: "card phn-status-card" },
      h("div", { class: "card-body" },
        banner("warn", (board && board.reason) || "Cannot read the board.")));
  }
  if (!mine) {
    return h("div", { class: "card phn-status-card" },
      h("div", { class: "card-body" },
        banner("info", "\"" + state.myName + "\" is not on the board right now — off shift, or the name doesn't match how it renders there.")));
  }

  const r = state.position;
  const pos = r ? r.position : null;
  return h("div", { class: "card phn-status-card" },
    h("div", { class: "card-body" },
      board.stale ? banner("warn", "Showing the last successful read — the board did not respond just now.") : null,
      r && r.uncertain
        ? banner("warn",
            r.unclassified.length + " unclassified — " + r.unclassified.join(", ") + " — position may be wrong",
            button("Classify", { small: true, onclick: () => openClassifyDialog(r.unclassified[0]) }))
        : null,
      h("div", { class: "phn-status-grid" },
        h("div", { class: "phn-position" },
          eyebrow("Position in queue"),
          h("div", { class: `phn-position-num ${pos != null && pos <= state.threshold ? "is-urgent" : ""}`, text: pos != null ? "#" + pos : "—" }),
          r ? h("div", { class: "dim", text: "of " + r.poolSize + " in " + r.poolLabel }) : null,
          h("div", { class: "dim", text: r
            ? (r.ahead === 0 ? "Ahead of you: nobody" : "Ahead of you: " + r.ahead)
            : "Not counted (Federal line, or off the board)" })),
        h("div", { class: "phn-fact" },
          eyebrow("My status"),
          h("div", {}, h("span", { class: `chip ${statusTone(mine.statusClass)}`, text: mine.statusText }), h("span", { class: "dim", text: "  " + mine.duration })),
          mine.federal ? h("div", { class: "chip neutral", text: "Federal line" }) : null),
        h("div", { class: "phn-fact" },
          eyebrow("Queued callers"),
          h("div", { class: "mono", text: board.queuedAgents + " AMER · " + board.queuedFederal + " Federal" })))));
}

function boardTable(state) {
  const board = state.board;
  if (!board || !board.ok || !board.agents.length) return null;
  return h("div", { class: "card" },
    cardHead(eyebrow("Board"), h("div", { class: "spacer" }), h("span", { class: "dim mono", text: "as of " + (board.asOf || "—") })),
    h("div", { class: "card-body" },
      h("table", { class: "tbl phn-board" },
        h("thead", {}, h("tr", {},
          h("th", { text: "Agent" }),
          h("th", { text: "Line" }),
          h("th", { text: "Status" }),
          h("th", { class: "right", text: "Duration" }))),
        h("tbody", {}, board.agents.map((a) => h("tr", {
          class: `row ${a.name === state.myName ? "phn-me-row" : ""}`,
        },
          h("td", { text: a.name }),
          h("td", {},
            a.federal
              ? h("span", { class: "chip neutral", text: "Federal" })
              : h("span", {
                  class: `chip is-clickable ${a.region === "unknown" ? "warn" : "neutral"}`,
                  onclick: () => openClassifyDialog(a.name, a.region),
                  text: "AMER · " + (a.region === "unknown" ? "Unclassified" : a.region === "us" ? "US" : "India"),
                })),
          h("td", {}, h("span", { class: `chip ${statusTone(a.statusClass)}`, text: a.statusText })),
          h("td", { class: "right mono", text: a.duration })))))));
}

export function render(ctx, host, shell) {
  const bodyHost = h("div", {});

  function paint(state) {
    mount(bodyHost,
      h("div", { class: "phn-toggle-row" },
        h("label", { class: "checkline" },
          h("input", { type: "checkbox", checked: state.enabled, onchange: (e) => phoneMonitor.setEnabled(e.target.checked) }),
          h("span", { text: "I'm on the phone queue" })),
        h("span", { class: "dim", text: "Polls the board every 10s while this is on, from anywhere in QView. Off means zero requests." })),
      statusCard(state),
      boardTable(state));
  }

  mount(host, page(pageHead("Phone Queue"), bodyHost));

  const unsubscribe = phoneMonitor.subscribe(paint);
  return () => unsubscribe();
}
