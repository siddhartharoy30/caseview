/**
 * Triage — the first hour of the day.
 *
 * One question: is anyone waiting on a first reply from me, and how long have
 * they got. Everything else on this page is secondary to that.
 *
 * Four decisions worth knowing before reading the code:
 *
 * 1. The primary band is exactly what the sidebar badge counts —
 *    `is_closed = 0 AND first_response_at IS NULL`. Not approximately: exactly.
 *    A badge saying 3 over a page showing 5 destroys trust in both, and once a
 *    number here is doubted the page stops being usable during a shift.
 *
 * 2. The countdown is the initial-response SLA, not a commitment deadline. It
 *    runs from case creation to creation + the priority window (P1 30m, P2 2h,
 *    P3 4h, P4 8h), and the server already computes it per case. On a case with
 *    no first response, "time since it arrived" is precisely the right clock,
 *    so nothing here re-derives it.
 *
 * 3. "Newly assigned" is a second band, and the badge deliberately does not
 *    count it. The cache has no assignment timestamp — every case in it is
 *    mine, so there is nothing recording when it became mine — and case
 *    creation is the closest honest proxy. Inventing an assignment time to
 *    make the band look authoritative would be worse than saying so.
 *
 * 4. Empty is the goal. The spec asks for the empty state to read as a success,
 *    not as an absence, and it does.
 */

import { $$, h, mount } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as store from "../lib/store.js";
import * as fmt from "../lib/fmt.js";
import { banner, button, skeletonCards, emptyState, copyBtn } from "../lib/ui.js";
import { pageHead, page } from "./_shared.js";
import { setQuery } from "../router.js";

/* ------------------------------------------------------------------ config */

const KEY_PREFS = "triage.prefs";

/** Once a second, because a P1 has a thirty-minute window and minutes matter. */
const TICK_MS = 1000;

const ICON_REFRESH = ["M20 11a8 8 0 10-2.3 5.7", "M20 5v6h-6"];

/** Windows offered for the newly-assigned band. Hours. */
const NEW_WINDOWS = [
  { id: 24, label: "24h" },
  { id: 48, label: "48h" },
  { id: 72, label: "3d" },
  { id: 168, label: "7d" },
];

/* -------------------------------------------------------------------- util */

/**
 * The server hands back `remainingSeconds` measured at the moment of the
 * request. Turning it into an absolute deadline once, at load, lets the
 * countdown tick in the browser without re-asking the server every second.
 */
function deadlineOf(c, loadedAt) {
  if (!c.sla || typeof c.sla.remainingSeconds !== "number") return null;
  return loadedAt + c.sla.remainingSeconds * 1000;
}

function urgencyTone(msLeft, windowMinutes) {
  if (msLeft === null) return "";
  if (msLeft < 0) return "red";
  // Inside the last quarter of the window is where a reply stops being optional.
  const windowMs = (windowMinutes || 240) * 60000;
  return msLeft <= windowMs * 0.25 ? "amber" : "";
}

function windowLabel(hours) {
  const w = NEW_WINDOWS.find((x) => x.id === hours);
  return w ? w.label : hours + "h";
}

/* ------------------------------------------------------------------ pieces */

function slaCell(c, deadline, now) {
  if (deadline === null) {
    return h("div", { class: "tri-clock" },
      h("div", { class: "tri-left dim", text: "—" }),
      h("div", { class: "tri-target", text: "no SLA window for this priority" }));
  }
  const left = deadline - now;
  const tone = urgencyTone(left, c.sla.windowMinutes);
  return h("div", { class: "tri-clock" },
    h("div", {
      class: "tri-left " + tone,
      "data-deadline": String(deadline),
      "data-window": String(c.sla.windowMinutes || 0),
      text: fmt.countdown(deadline, now),
    }),
    h("div", { class: "tri-target" },
      left < 0 ? "past the " : "left of the ",
      h("span", { text: fmt.duration((c.sla.windowMinutes || 0) / 60) }),
      " target"));
}

function caseCard(c, { deadline, now, urgent }) {
  const chips = h("div", { class: "tri-chips" },
    h("span", { class: "chip " + fmt.priorityClass(c.priority), text: c.priority || "—" }),
    c.isEscalated ? h("span", { class: "chip p1", text: "ESCALATED" }) : null,
    c.needsMyReply ? h("span", { class: "chip p2", text: "REPLY" }) : null,
    h("span", { class: "chip neutral", text: c.origin || "Unknown origin" }),
    c.productArea ? h("span", { class: "chip neutral", text: c.productArea }) : null);

  const age = fmt.ageDays(c.createdDate, now);
  const href = "/case/" + encodeURIComponent(c.caseNumber);

  return h("article", { class: "tri-card" + (urgent ? " urgent" : "") },
    h("div", { class: "tri-main" },
      h("div", { class: "tri-line1" },
        h("a", { class: "mono tri-num", href, text: c.caseNumber }),
        copyBtn(c.caseNumber, "Case number", "Copy case number"),
        h("span", { class: "tri-account", text: c.account || "—" }),
        c.contactName ? h("span", { class: "dim", text: " · " + c.contactName }) : null),
      h("a", { class: "tri-subject", href, title: c.subject || "", text: c.subject || "(no subject)" }),
      chips,
      h("div", { class: "tri-meta" },
        h("span", { title: fmt.dateTime(c.createdDate) },
          "Opened ",
          h("strong", { text: fmt.dateTimeShort(c.createdDate) }),
          h("span", { class: "dim", text: " (" + fmt.relative(c.createdDate, now) + ")" })),
        age.days !== null ? h("span", { class: age.band, text: age.days + "d old" }) : null,
        c.status ? h("span", { class: "dim", text: c.status }) : null,
        c.nextAction
          ? h("span", { class: "tri-next", title: c.nextAction.reason || "" },
              h("strong", { text: c.nextAction.label }))
          : null)),
    slaCell(c, deadline, now));
}

function bandBlock({ id, title, note, count, tone }, body) {
  return h("section", { class: "tri-band", "data-band": id },
    h("header", { class: "tri-band-head" },
      h("h2", {},
        h("span", { class: "band-dot " + (tone || "") }),
        title,
        h("span", { class: "band-count", text: String(count) })),
      note ? h("p", { class: "tri-band-note", text: note }) : null),
    body);
}

/* ------------------------------------------------------------------ render */

export function render(ctx, host, shell) {
  const q = ctx.query || {};
  const prefs = store.get(KEY_PREFS, {});

  const state = {
    rows: [],
    loading: true,
    error: null,
    loadedAt: Date.now(),
    // The URL wins so a link reproduces the view; otherwise the last setting.
    newWindow: Number(q.window) || Number(prefs.newWindow) || 24,
    showNew: "new" in q ? q.new !== "0" : prefs.showNew !== false,
    sync: null,
  };

  const bodyHost = h("div", {});
  const bannerHost = h("div", {});
  let ticker = null;

  const savePrefs = () =>
    store.set(KEY_PREFS, { newWindow: state.newWindow, showNew: state.showNew });

  /* ----------------------------------------------------------------- data */

  async function load({ quiet } = {}) {
    if (!quiet) { state.loading = true; paint(); }
    try {
      const data = await api.cases({ status: "open" });
      state.rows = data.cases || [];
      state.sync = data.sync || null;
      state.loadedAt = Date.now();
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    state.loading = false;
    paint();
  }

  /* -------------------------------------------------------------- toolbar */

  function toolbar(counts) {
    const seg = h("div", { class: "seg" },
      NEW_WINDOWS.map((w) =>
        h("button", {
          class: "seg-btn" + (state.newWindow === w.id ? " on" : ""),
          type: "button",
          onclick: () => {
            state.newWindow = w.id;
            setQuery({ window: w.id === 24 ? null : String(w.id) });
            savePrefs();
            paint();
          },
        }, w.label)));

    return h("div", { class: "toolbar" },
      h("div", { class: "toolbar-row" },
        h("span", { class: "tb-label", text: "Newly assigned window" }),
        seg,
        h("label", { class: "checkline" },
          h("input", {
            type: "checkbox",
            checked: state.showNew,
            onchange: (e) => {
              state.showNew = e.target.checked;
              setQuery({ new: state.showNew ? null : "0" });
              savePrefs();
              paint();
            },
          }),
          h("span", { text: "Show newly assigned" })),
        h("span", { class: "spacer" }),
        h("span", { class: "result-line" },
          counts.awaiting === 0
            ? "Nothing awaiting a first response"
            : counts.awaiting + " awaiting a first response",
          h("span", { class: "dim", text: " · " + counts.open + " open in total" }))));
  }

  /* ---------------------------------------------------------------- paint */

  function paint() {
    if (state.loading) {
      mount(bodyHost, skeletonCards(3, "128px"));
      return;
    }
    if (state.error) {
      mount(bodyHost, emptyState({
        title: "Could not load the queue",
        message: state.error.message || "The server did not answer.",
        iconName: "alert",
        kind: "error",
        action: button("Try again", { kind: "primary", onclick: () => load() }),
      }));
      return;
    }

    const now = Date.now();
    const open = state.rows;

    // Band one, and the only one the badge counts.
    const awaiting = open
      .filter((c) => !c.firstResponseAt)
      .map((c) => ({ c, deadline: deadlineOf(c, state.loadedAt) }));

    // Most overdue first, then closest to breaching. One monotonic axis, so the
    // row at the top is always the one to do next.
    awaiting.sort((a, b) => {
      const av = a.deadline === null ? Infinity : a.deadline;
      const bv = b.deadline === null ? Infinity : b.deadline;
      return av - bv;
    });

    const cutoff = now - state.newWindow * 3600000;
    const fresh = open
      .filter((c) => c.firstResponseAt && Date.parse(c.createdDate) >= cutoff)
      .sort((a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate));

    const breached = awaiting.filter((x) => x.deadline !== null && x.deadline < now).length;

    mount(bannerHost,
      breached
        ? banner("error",
            breached === 1
              ? "One case is past its initial-response target and still has no reply on it."
              : breached + " cases are past their initial-response target and still have no reply on them.")
        : null,
      state.sync && state.sync.lastError
        ? banner("warn", "The last sync failed, so this may not be the newest state of the queue. Settings has the detail.")
        : null);

    const blocks = [];

    blocks.push(bandBlock(
      {
        id: "awaiting",
        title: "Awaiting first response",
        tone: breached ? "p0" : "p2",
        count: awaiting.length,
        note: "Open cases with nothing sent back yet. This is what the sidebar badge counts, and the countdown is the initial-response target for the case priority.",
      },
      awaiting.length
        ? h("div", { class: "tri-list" },
            awaiting.map((x) => caseCard(x.c, {
              deadline: x.deadline,
              now,
              urgent: x.deadline !== null && x.deadline < now,
            })))
        : emptyState({
            title: "Nobody is waiting on a first reply",
            message: "Every open case has had a response go out. This is the state the page exists to keep you in — by mid-morning it should look exactly like this.",
            iconName: "check",
            kind: "success",
          })));

    if (state.showNew) {
      blocks.push(bandBlock(
        {
          id: "new",
          title: "Newly assigned",
          tone: "neutral",
          count: fresh.length,
          note: "Cases opened in the last " + windowLabel(state.newWindow) +
            " that have already had a first response. The sidebar badge does not count these — the cache holds only my cases, so there is no record of when one became mine, and creation time is the closest honest stand-in for assignment.",
        },
        fresh.length
          ? h("div", { class: "tri-list" },
              fresh.map((c) => caseCard(c, {
                deadline: deadlineOf(c, state.loadedAt),
                now,
                urgent: false,
              })))
          : emptyState({
              title: "Nothing new in this window",
              message: "No case opened in the selected window. Widen it above if you are looking further back.",
              iconName: "inbox",
            })));
    }

    mount(bodyHost,
      toolbar({ awaiting: awaiting.length, open: open.length }),
      h("div", { class: "tri-bands" }, blocks));
  }

  /* --------------------------------------------------------------- ticker */

  /**
   * Re-render only the countdown text, once a second. Repainting the page would
   * throw away scroll position and the checkbox focus for no gain — nothing
   * else on a triage row changes between loads.
   */
  function tick() {
    const now = Date.now();
    for (const el of $$("[data-deadline]", bodyHost)) {
      const deadline = Number(el.dataset.deadline);
      const left = deadline - now;
      el.textContent = fmt.countdown(deadline, now);
      const tone = urgencyTone(left, Number(el.dataset.window));
      el.classList.toggle("red", tone === "red");
      el.classList.toggle("amber", tone === "amber");
      const card = el.closest(".tri-card");
      if (card) card.classList.toggle("urgent", left < 0);
    }
  }

  /* ----------------------------------------------------------------- boot */

  mount(host, page(
    pageHead(
      "Triage",
      "Who is waiting on a first reply, and how long they have got.",
      [button("Refresh", { small: true, iconPaths: ICON_REFRESH, onclick: () => load() })]),
    bannerHost,
    bodyHost));

  paint();
  load();
  ticker = setInterval(tick, TICK_MS);

  shell.setPageKeys((e) => {
    if (e.key === "n") {
      state.showNew = !state.showNew;
      setQuery({ new: state.showNew ? null : "0" });
      savePrefs();
      paint();
      return true;
    }
    return false;
  });

  return () => {
    if (ticker) clearInterval(ticker);
    shell.setPageKeys(null);
  };
}
