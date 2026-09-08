/**
 * Phone queue monitor -- v4 phase 6.
 *
 * The server (`src/phone.ts`) owns the fetch discipline entirely: no request
 * from this page means no request to the board at all, and it enforces its
 * own 10s minimum interval regardless of how eagerly this page polls. This
 * page just asks every 10s while mounted and the master toggle is on, and
 * renders whatever comes back -- including the `stale`/`ok:false` cases,
 * which are answers, not failures.
 *
 * Position among non-federal agents matches Case Desk's own logic exactly
 * (see the POSITION DISCOVERY note in src/phone.ts) -- verified against
 * Case Desk's live /api/phone-queue response during phase 6 development,
 * not guessed.
 */

import { h, mount } from "../lib/dom.js";
import { api } from "../lib/api.js";
import { toast } from "../lib/ui.js";
import { banner, emptyState, button } from "../lib/ui.js";
import { page, pageHead, cardHead, eyebrow } from "./_shared.js";

const POLL_MS = 10000;
const ALERT_THRESHOLD_DEFAULT = 3;
const AUTO_OFF_OFFLINE_MS = 5 * 60 * 1000;

const RINGING_STATUSES = new Set(["ringing", "accepting_call"]);

/** Matches the source board's own colour vocabulary (app.css .phn-* rules)
 * rather than inventing a second one that could disagree with the board an
 * agent is also glancing at directly. */
const STATUS_TONE = {
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

function statusTone(cls) { return STATUS_TONE[cls] || "neutral"; }

export function render(ctx, host, shell) {
  const state = {
    loading: true,
    error: null,
    board: null,
    myName: null,
    myPosition: null,
    enabled: false,
    threshold: ALERT_THRESHOLD_DEFAULT,
    lastNotifiedPosition: null,
    offlineSince: null,
  };

  const bodyHost = h("div", {});
  let timer = null;
  let disposed = false;

  async function loadSettings() {
    try {
      const res = await api.settings();
      const s = (res && res.settings) || {};
      state.enabled = s.phoneMonitorEnabled === "true";
      state.threshold = Number(s.phoneAlertThreshold) || ALERT_THRESHOLD_DEFAULT;
    } catch { /* defaults stand */ }
  }

  async function setEnabled(next) {
    state.enabled = next;
    paint();
    await api.saveSettings({ phoneMonitorEnabled: String(next) }).catch(() => {});
    if (next) poll(); else stopPolling();
  }

  function maybeAlert() {
    const board = state.board;
    if (!board || !board.ok || !state.enabled) return;
    const pos = state.myPosition;
    const mine = board.agents.find((a) => a.name === state.myName);

    // Auto-off after 5 minutes reading "offline" -- so it does not nag after
    // a shift ends and the tab is left open.
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
    }

    if (pos == null || pos > state.threshold) { state.lastNotifiedPosition = pos; return; }
    if (pos === state.lastNotifiedPosition) return; // once per transition, not per poll
    state.lastNotifiedPosition = pos;

    if (pos <= 1) toast("You're next for the phone queue", "err", { sticky: true });
    else if (pos <= 2) toast("You're " + pos + " for the phone queue", "warn");
    else toast("You're " + pos + " for the phone queue", "");
  }

  async function poll() {
    if (disposed || !state.enabled) return;
    try {
      const res = await api.phoneBoard();
      if (disposed) return;
      state.board = res;
      state.myName = res.myName;
      state.myPosition = res.myPosition;
      state.error = null;
      maybeAlert();
    } catch (err) {
      if (disposed) return;
      state.error = err.message || "Could not reach the phone monitor.";
    }
    state.loading = false;
    paint();
    if (state.enabled && !disposed) timer = setTimeout(poll, POLL_MS);
  }

  function stopPolling() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function statusCard() {
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

    const pos = state.myPosition;
    return h("div", { class: "card phn-status-card" },
      h("div", { class: "card-body" },
        board.stale ? banner("warn", "Showing the last successful read — the board did not respond just now.") : null,
        h("div", { class: "phn-status-grid" },
          h("div", { class: "phn-position" },
            eyebrow("Position in queue"),
            h("div", { class: `phn-position-num ${pos != null && pos <= state.threshold ? "is-urgent" : ""}`, text: pos != null ? "#" + pos : "—" }),
            h("div", { class: "dim", text: pos != null
              ? (pos === 1 ? "You're next for the next call" : pos + (pos === 2 ? "nd" : pos === 3 ? "rd" : "th") + " for the next call")
              : "Not counted (Federal line, or off the board)" })),
          h("div", { class: "phn-fact" },
            eyebrow("My status"),
            h("div", {}, h("span", { class: `chip ${statusTone(mine.statusClass)}`, text: mine.statusText }), h("span", { class: "dim", text: "  " + mine.duration })),
            mine.federal ? h("div", { class: "chip neutral", text: "Federal line" }) : null),
          h("div", { class: "phn-fact" },
            eyebrow("Ahead of me"),
            h("div", { class: "mono", text: pos != null ? String(pos - 1) : "—" })),
          h("div", { class: "phn-fact" },
            eyebrow("Queued callers"),
            h("div", { class: "mono", text: board.queuedAgents + " AMER · " + board.queuedFederal + " Federal" })))));
  }

  function boardTable() {
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
            h("td", {}, a.federal ? h("span", { class: "chip neutral", text: "Federal" }) : h("span", { class: "dim", text: "AMER" })),
            h("td", {}, h("span", { class: `chip ${statusTone(a.statusClass)}`, text: a.statusText })),
            h("td", { class: "right mono", text: a.duration })))))));
  }

  function paint() {
    mount(bodyHost,
      h("div", { class: "phn-toggle-row" },
        h("label", { class: "checkline" },
          h("input", { type: "checkbox", checked: state.enabled, onchange: (e) => setEnabled(e.target.checked) }),
          h("span", { text: "I'm on the phone queue" })),
        h("span", { class: "dim", text: "Polls the board every 10s while this is on and the page is open. Off means zero requests." })),
      statusCard(),
      boardTable());
  }

  mount(host, page(pageHead("Phone Queue"), bodyHost));

  loadSettings().then(() => {
    if (state.enabled) { poll(); return; }
    state.loading = false;
    paint();
  });

  return () => { disposed = true; stopPolling(); };
}
