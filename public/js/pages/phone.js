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
import * as phonePip from "../lib/phonePip.js";
import { connectButton } from "../lib/connectLauncher.js";

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

/**
 * The same same-line/same-region pool `positionOf()` builds server-side,
 * sliced to whoever sits before me in the board's own order -- not a second
 * implementation of the filter that could disagree with the position count
 * itself, just reading the same decorated `board.agents` the board route
 * already sends (each non-federal agent carries its own `region`).
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
 * Reuses `STATUS_TONE`/`.phn-*` CSS verbatim (via the cloned stylesheet in
 * phonePip.js) rather than a second colour vocabulary, so the board, the
 * page and the pop-out never disagree about what amber means.
 */
function pipContent(host, state) {
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

/** Pop-out control: shows the best available tier and never renders a
 * button that does nothing. Tier 3 (the dock) is always available
 * regardless of what this shows, so this only ever offers tiers 1 and 2. */
function popoutRow(state) {
  if (!state.enabled) return null;
  const t = phonePip.tier();

  if (t === "pip") {
    return h("div", { class: "phn-toggle-row" },
      button("Pop out", {
        small: true,
        onclick: () => phonePip.openPip(pipContent),
      }),
      h("span", { class: "dim", text: "Opens an always-on-top window." }));
  }

  const why = t === "insecure-context"
    ? "Always-on-top needs QView on https or localhost."
    : "Always-on-top needs a newer Chrome.";
  return h("div", { class: "phn-toggle-row" },
    button("Pop out (window)", { small: true, onclick: () => phonePip.openPopupFallback() }),
    h("span", { class: "dim", text: why }));
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
      connectButton(state),
      h("div", { class: "phn-toggle-row" },
        h("label", { class: "checkline" },
          h("input", { type: "checkbox", checked: state.enabled, onchange: (e) => phoneMonitor.setEnabled(e.target.checked) }),
          h("span", { text: "I'm on the phone queue" })),
        h("span", { class: "dim", text: "Polls the board every 10s while this is on, from anywhere in QView. Off means zero requests." })),
      popoutRow(state),
      statusCard(state),
      boardTable(state));
  }

  mount(host, page(pageHead("Phone Queue"), bodyHost));

  const unsubscribe = phoneMonitor.subscribe(paint);
  return () => unsubscribe();
}
