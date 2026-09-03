/**
 * Commitments — every follow-up deadline I have promised a customer.
 *
 * The premise from the spec, and the reason this page exists at all: a missed
 * follow-up deadline is a hard failure, and only one deadline may be live on a
 * case at a time. Salesforce tracks neither. So the parser reads promises out of
 * the case history into the local cache, and this page is where they are
 * triaged, renegotiated and closed out.
 *
 * Three decisions worth knowing before reading the code:
 *
 * 1. Bands, not a table. A deadline is only ever asking one question — how much
 *    working time is left — and sorting a flat list by date buries that answer
 *    in a column. Breached first, then at risk, then today. Met collapses,
 *    because 611 of the 725 rows in this cache are met and none of them need
 *    looking at.
 *
 * 2. Countdowns are business hours, not wall clock. Friday 5 PM to Monday 10 AM
 *    is one working hour, and a page that renders it as "66h" is lying about how
 *    much room is left. `lib/bizhours.js` does the arithmetic, in the browser, so
 *    the number moves while you watch it.
 *
 * 3. Closed cases are hidden by default. 89 of the 90 breaches here are on cases
 *    that shipped months ago; opening on those would make the page noise. The
 *    count of what is hidden is always on screen, and one click shows it.
 *
 * Writes go through the same endpoints the case page uses. Nothing here talks to
 * Salesforce — the deadline record is ours, not theirs.
 */

import { $$, h, mount, debounce } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as store from "../lib/store.js";
import * as fmt from "../lib/fmt.js";
import {
  toast, toastError, dialog, confirmDialog, banner, button, field,
  skeletonRows, emptyState, copyBtn,
} from "../lib/ui.js";
import { htmlToText, oneLine, textNodes } from "../lib/text.js";
import * as bh from "../lib/bizhours.js";
import { pageHead, page } from "./_shared.js";
import { navigate, setQuery } from "../router.js";

/* ------------------------------------------------------------------ config */

const KEY_PREFS = "commitments.prefs";

/** Met is long and uninteresting; show a page of it and let the rest be asked for. */
const MET_PAGE = 25;

const PREVIEW_CHARS = 260;

const TICK_MS = 30000;

const ICON_ADD = ["M12 5v14", "M5 12h14"];
const ICON_REFRESH = ["M20 11a8 8 0 10-2.3 5.7", "M20 5v6h-6"];

/**
 * Band order is the order of the working day: what has already failed, what is
 * about to, what is due, what is coming, what could not be read, what is done.
 */
const BANDS = [
  {
    id: "breached",
    title: "Breached",
    tone: "p0",
    note: "The deadline passed and no reply went out in time. These are the failures — close them out or renegotiate so the record is honest.",
  },
  {
    id: "atrisk",
    title: "At risk",
    tone: "p2",
    note: null, // filled in with the at-risk window, which is a server setting
  },
  {
    id: "today",
    title: "Due today",
    tone: "p3",
    note: null,
  },
  {
    id: "upcoming",
    title: "Upcoming",
    tone: "neutral",
    note: null,
  },
  {
    id: "nodate",
    title: "Needs a date",
    tone: "purple",
    note: "A promise was found in the case history but no deadline could be read out of it. Set the date the customer was actually given, or dismiss it if it was not a commitment.",
  },
  {
    id: "met",
    title: "Met",
    tone: "ok",
    note: null,
  },
  {
    id: "history",
    title: "History",
    tone: "neutral",
    note: "Renegotiated and dismissed commitments, kept so the record shows when a deadline moved and whether it moved before it expired.",
  },
];

const STATE_TONE = {
  active: "",
  met: "ok",
  breached: "p0",
  unparsed: "purple",
  superseded: "neutral",
  dismissed: "neutral",
};

/**
 * ?state= accepts what the rest of the app already links with, plus the band
 * ids themselves. The sidebar risk badge sends "at-risk"; a link copied off
 * this page sends "atrisk". Both have to land in the same place, or one of
 * them is a dead link that looks like it worked.
 */
const BAND_ALIAS = {
  breached: "breached", overdue: "breached",
  "at-risk": "atrisk", atrisk: "atrisk", risk: "atrisk",
  today: "today", "due-today": "today",
  upcoming: "upcoming",
  nodate: "nodate", unparsed: "nodate", "needs-date": "nodate",
  met: "met",
  history: "history", superseded: "history", dismissed: "history",
};

/* ------------------------------------------------------------------ derive */

/**
 * Which band a commitment belongs in, right now.
 *
 * An `active` row whose deadline has already passed lands in Breached even
 * though the server still calls it active: reconciliation runs on the sync
 * interval, and a deadline does not stop being missed while it waits for a poll.
 */
function bandOf(cm, now, atRiskHours) {
  if (cm.state === "superseded" || cm.state === "dismissed") return "history";
  if (cm.state === "met") return "met";
  if (cm.state === "unparsed") return "nodate";
  if (cm.state === "breached") return "breached";
  if (!cm.dueAt) return "nodate";

  const r = bh.remaining(cm.dueAt, now);
  if (!r) return "nodate";
  if (r.overdue) return "breached";
  if (r.businessMs <= atRiskHours * 3600000) return "atrisk";
  if (bh.isSameNyDay(r.due, now)) return "today";
  return "upcoming";
}

function countdownClass(cm, now, atRiskHours) {
  if (cm.state !== "active" || !cm.dueAt) return "cd dim";
  const r = bh.remaining(cm.dueAt, now);
  if (!r) return "cd dim";
  if (r.overdue) return "cd red";
  if (r.businessMs <= atRiskHours * 3600000) return "cd amber";
  return "cd";
}

function countdownText(cm, now) {
  if (!cm.dueAt) return "no date";
  const r = bh.remaining(cm.dueAt, now);
  if (!r) return "no date";
  if (cm.state !== "active") return fmt.relative(cm.dueAt);
  return bh.formatBusinessDuration(r.businessMs);
}

/** 6 PM New York on the calendar day of `at`. */
const atEndOfDay = (at) => {
  const p = bh.zoned(at);
  return bh.fromWallClock(p.year, p.month, p.day, bh.DAY_END_HOUR, 0, 0);
};

const CANONICAL_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: bh.TZ, weekday: "long", month: "long", day: "2-digit", year: "numeric",
});

/**
 * The phrasing the spec calls canonical, generated from a picked date.
 *
 * This is offered as a starting point for a manual commitment for one reason
 * beyond consistency: the server-side parser recognises this shape, so a
 * commitment written this way stays parseable if the same sentence is later
 * pasted into an actual case comment. "EST" is kept verbatim year-round because
 * that is what the phrasing says and what the parser matches — the stored
 * instant is correct regardless, since the date goes through New York wall
 * clock either way.
 */
function canonicalSentence(due) {
  const at = typeof due === "number" ? due : new Date(due).getTime();
  const p = bh.zoned(at);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const time = `${h12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
  const date = CANONICAL_DATE.format(new Date(at));
  return bh.isSameNyDay(at)
    ? `I will follow up with you by ${time} EST today, ${date}.`
    : `I will follow up with you by ${time} EST on ${date}.`;
}

/* ------------------------------------------------------------------- forms */

/**
 * The shared editor for a deadline: a datetime-local pinned to New York, the
 * four shortcuts that cover almost every real commitment, and the text.
 *
 * The shortcuts exist because "+2 business days" on a Friday afternoon is the
 * case people get wrong by hand — it is Tuesday, and typing a date is how you
 * end up promising a Sunday.
 */
function commitmentForm({ caseNumber, dueAt, text, note, lockCase, autoText }) {
  const caseInput = h("input", {
    class: "input", placeholder: "01234567", value: caseNumber || "",
    disabled: lockCase ? "" : null,
  });

  const dueInput = h("input", {
    class: "input", type: "datetime-local",
    value: bh.toLocalInput(dueAt || bh.defaultDueAt()),
  });

  const textInput = h("textarea", {
    class: "input", rows: "3",
    placeholder: "What was promised, in the words the customer will read it in.",
  });
  textInput.value = text || "";

  const noteInput = h("input", {
    class: "input", placeholder: "Why, or what it is blocked on (optional)",
    value: note || "",
  });

  // Only auto-fill while the text is untouched. Overwriting something typed
  // would be worse than leaving the field blank.
  let textTouched = !!text;
  textInput.addEventListener("input", () => { textTouched = true; });

  const syncText = () => {
    if (!autoText || textTouched) return;
    const d = bh.fromLocalInput(dueInput.value);
    if (d) textInput.value = canonicalSentence(d.getTime());
  };

  const setDue = (date) => { dueInput.value = bh.toLocalInput(date); syncText(); };
  dueInput.addEventListener("change", syncText);
  syncText();

  const quick = (label, fn) =>
    h("button", { class: "btn sm", type: "button", onclick: () => setDue(fn()) }, label);

  const shortcuts = h("div", { class: "cmp-quick" },
    quick("End of today", () => bh.defaultDueAt()),
    quick("+4 business hours", () => bh.addBusinessHours(Date.now(), 4)),
    quick("+1 business day", () => atEndOfDay(bh.addBusinessDays(Date.now(), 1))),
    quick("+2 business days", () => atEndOfDay(bh.addBusinessDays(Date.now(), 2))));

  const preview = h("div", { class: "hint cmp-preview" });
  const paintPreview = () => {
    const d = bh.fromLocalInput(dueInput.value);
    if (!d) { preview.textContent = "No deadline set — this will be filed under “Needs a date”."; return; }
    const r = bh.remaining(d.getTime());
    preview.textContent = r.overdue
      ? `${fmt.dateTime(d.toISOString())} — already past, ${bh.formatBusinessDuration(-r.businessMs)} of business time ago.`
      : `${fmt.dateTime(d.toISOString())} — ${bh.formatBusinessDuration(r.businessMs)} of business time from now${r.outOfHours ? ", outside the 9–6 shift" : ""}.`;
  };
  dueInput.addEventListener("input", paintPreview);
  dueInput.addEventListener("change", paintPreview);
  paintPreview();

  const node = h("div", { class: "cmp-form" },
    caseNumber !== undefined ? field("Case number", caseInput) : null,
    field("Due", h("div", {}, dueInput, shortcuts, preview)),
    field("Commitment text", textInput,
      autoText ? "Pre-filled with the canonical phrasing so the parser recognises it later. Edit freely." : null),
    field("Note", noteInput));

  return {
    node,
    values: () => {
      const d = bh.fromLocalInput(dueInput.value);
      return {
        caseNumber: caseInput.value.trim(),
        dueAt: d ? d.toISOString() : null,
        text: textInput.value.trim(),
        note: noteInput.value.trim(),
      };
    },
  };
}

/* ------------------------------------------------------------------ render */

export function render(ctx, host, shell) {
  const q = ctx.query || {};
  const prefs = store.get(KEY_PREFS, {});

  const state = {
    rows: [],
    duplicates: [],
    atRiskHours: 4,
    loading: true,
    error: null,
    // The URL wins when it says anything, so a shared link reproduces the view.
    // A bare /commitments falls back to however the page was last left.
    closed: "closed" in q ? q.closed === "1" : !!prefs.closed,
    history: "history" in q ? q.history === "1" : !!prefs.history,
    find: q.q || "",
    // Arriving from a badge elsewhere in the app means one band is the whole
    // reason for the visit. Deliberately not persisted to prefs: it describes
    // this trip, not how the page should open next time.
    focus: BAND_ALIAS[String(q.state || "").toLowerCase()] || null,
    metOpen: false,
    bands: new Map(),
  };

  const bodyHost = h("div", {});
  const bannerHost = h("div", {});
  let ticker = null;

  const savePrefs = () =>
    store.set(KEY_PREFS, { closed: state.closed, history: state.history });

  /* ----------------------------------------------------------------- data */

  async function load({ quiet } = {}) {
    if (!quiet) { state.loading = true; paint(); }
    try {
      const data = await api.commitments();
      state.rows = (data.commitments || []).map((cm) => ({
        ...cm,
        // Flattened once, not once per keystroke: find runs over this.
        plain: htmlToText(cm.rawText),
      }));
      state.duplicates = data.duplicates || [];
      state.atRiskHours = Number(data.atRiskHours) || 4;
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    state.loading = false;
    paint();
  }

  /** Every write funnels through here so the page and the sidebar agree after it. */
  async function mutate(fn, okMessage) {
    try {
      await fn();
      if (okMessage) toast(okMessage, "ok");
      await load({ quiet: true });
      shell.refreshCounts();
    } catch (err) {
      toastError(err);
    }
  }

  /* -------------------------------------------------------------- actions */

  function openAdd(prefill) {
    const form = commitmentForm({
      caseNumber: prefill?.caseNumber ?? "",
      dueAt: bh.defaultDueAt(),
      autoText: true,
    });
    const d = dialog({
      title: "New commitment",
      width: "560px",
      body: form.node,
      actions: (close) => [
        h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
        h("button", {
          class: "btn primary",
          onclick: () => {
            const v = form.values();
            if (!v.caseNumber) return toast("A case number is required", "err");
            if (!v.text) return toast("Say what was promised", "err");
            close(v);
          },
        }, "Add commitment"),
      ],
    });
    d.onClose((v) => {
      if (!v) return;
      mutate(() => api.addCommitment({
        caseNumber: v.caseNumber, dueAt: v.dueAt, text: v.text, note: v.note || undefined,
      }), "Commitment added");
    });
  }

  function openEdit(cm) {
    const form = commitmentForm({
      dueAt: cm.dueAt ? new Date(cm.dueAt) : bh.defaultDueAt(),
      text: cm.plain,
      note: cm.note || "",
    });
    const d = dialog({
      title: `Edit commitment on ${cm.caseNumber}`,
      width: "560px",
      body: form.node,
      actions: (close) => [
        h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
        h("button", { class: "btn primary", onclick: () => close(form.values()) }, "Save"),
      ],
    });
    d.onClose((v) => {
      if (!v) return;
      mutate(() => api.patchCommitment(cm.id, {
        dueAt: v.dueAt,
        rawText: v.text,
        note: v.note,
        // Giving an unparsed commitment a date is what makes it a live one.
        state: cm.state === "unparsed" && v.dueAt ? "active" : undefined,
      }), "Commitment updated");
    });
  }

  /**
   * Renegotiate: supersede rather than overwrite.
   *
   * The note is pre-filled with whether the move happened before or after the
   * original deadline, because that is the whole difference between telling a
   * customer early and apologising late — and a history that does not record it
   * is not a record.
   */
  function openRenegotiate(cm) {
    const r = cm.dueAt ? bh.remaining(cm.dueAt) : null;
    const prefix = !r
      ? "Renegotiated (no original deadline was set)."
      : r.overdue
        ? `Renegotiated ${bh.formatBusinessDuration(-r.businessMs)} of business time AFTER the original deadline had already passed.`
        : `Renegotiated ${bh.formatBusinessDuration(r.businessMs)} of business time before the original deadline.`;

    const form = commitmentForm({
      dueAt: cm.dueAt ? atEndOfDay(bh.addBusinessDays(Date.now(), 1)) : bh.defaultDueAt(),
      note: prefix,
      autoText: true,
    });

    const d = dialog({
      title: `Renegotiate ${cm.caseNumber}`,
      width: "560px",
      body: h("div", {},
        h("div", { class: "cmp-old" },
          h("div", { class: "cmp-old-label", text: "Current deadline" }),
          h("div", {},
            cm.dueAt ? fmt.dateTime(cm.dueAt) : "none",
            r ? h("span", { class: "rel", text: `  ·  ${r.overdue ? "breached" : "in " + bh.formatBusinessDuration(r.businessMs)}` }) : null),
          h("div", { class: "cmp-old-text", text: oneLine(cm.plain, 200) })),
        form.node),
      actions: (close) => [
        h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
        h("button", {
          class: "btn primary",
          onclick: () => {
            const v = form.values();
            if (!v.dueAt) return toast("A renegotiated commitment needs a new date", "err");
            close(v);
          },
        }, "Supersede with new date"),
      ],
    });
    d.onClose((v) => {
      if (!v) return;
      mutate(() => api.patchCommitment(cm.id, {
        renegotiate: true, dueAt: v.dueAt, rawText: v.text || undefined, note: v.note || undefined,
      }), "Superseded — the old deadline is kept in history");
    });
  }

  async function markMet(cm) {
    await mutate(() => api.patchCommitment(cm.id, { state: "met" }), "Marked met");
  }

  async function dismiss(cm) {
    const ok = await confirmDialog({
      title: "Dismiss commitment",
      message: "This drops it out of the deadline count without recording that it was met. Use it for text the parser read as a promise that never was one.",
      confirmLabel: "Dismiss",
      danger: true,
    });
    if (ok) mutate(() => api.patchCommitment(cm.id, { state: "dismissed" }), "Dismissed");
  }

  async function reopen(cm) {
    await mutate(() => api.patchCommitment(cm.id, { state: "active" }), "Back on the clock");
  }

  const openCase = (cm) => navigate(`/case/${encodeURIComponent(cm.caseNumber)}?tab=commitments`);

  /* ---------------------------------------------------------------- cards */

  function card(cm, now) {
    const tone = STATE_TONE[cm.state] ?? "neutral";
    const isHistory = cm.state === "superseded" || cm.state === "dismissed";

    const head = h("div", { class: "cm-top" },
      h("span", { class: `chip ${tone}`, text: cm.state }),
      h("div", { class: "due-cell" },
        h("span", {
          class: countdownClass(cm, now, state.atRiskHours),
          dataset: cm.state === "active" && cm.dueAt ? { countdown: cm.dueAt } : {},
          text: countdownText(cm, now),
        }),
        h("span", { class: "abs", text: cm.dueAt ? fmt.dateTime(cm.dueAt) : "no deadline" })),
      h("div", { class: "spacer" }),
      cm.priority ? h("span", { class: `chip ${fmt.priorityClass(cm.priority)}`, text: cm.priority }) : null,
      cm.isClosed ? h("span", { class: "chip neutral", text: cm.status || "closed" }) : null,
      h("a", {
        class: "cmp-case mono", href: `/case/${encodeURIComponent(cm.caseNumber)}?tab=commitments`,
        text: cm.caseNumber,
        onclick: (e) => { e.preventDefault(); openCase(cm); },
      }));

    const meta = h("div", { class: "cmp-meta" },
      cm.subject ? h("span", { class: "cmp-subject", text: cm.subject }) : null,
      cm.account ? h("span", { class: "cname", text: cm.account }) : null,
      cm.source === "manual" ? h("span", { class: "chip neutral", text: "manual" }) : null,
      cm.state === "met" && !cm.metAt
        ? h("span", { class: "rel", text: "marked met by hand" })
        : cm.metAt ? h("span", { class: "rel", text: `met ${fmt.dateTime(cm.metAt)}` }) : null,
      cm.supersededBy ? h("span", { class: "rel", text: "superseded by a later deadline" }) : null);

    const acts = h("div", { class: "cmp-acts" },
      !isHistory && cm.state !== "met"
        ? h("button", { class: "linkbtn", type: "button", text: "renegotiate", onclick: () => openRenegotiate(cm) })
        : null,
      !isHistory && cm.state !== "met"
        ? h("button", { class: "linkbtn", type: "button", text: "mark met", onclick: () => markMet(cm) })
        : null,
      !isHistory
        ? h("button", { class: "linkbtn", type: "button", text: "edit", onclick: () => openEdit(cm) })
        : null,
      !isHistory
        ? h("button", { class: "linkbtn", type: "button", text: "dismiss", onclick: () => dismiss(cm) })
        : null,
      cm.state === "dismissed"
        ? h("button", { class: "linkbtn", type: "button", text: "reopen", onclick: () => reopen(cm) })
        : null,
      h("button", { class: "linkbtn", type: "button", text: "open case", onclick: () => openCase(cm) }),
      h("div", { class: "spacer" }),
      copyBtn(cm.plain, "Commitment text copied"));

    return h("div", { class: `card cm-card cmp-card st-${cm.state}` },
      head,
      meta,
      cm.plain ? textNodes(oneLine(cm.plain, PREVIEW_CHARS), state.find.trim(), "cm-raw") : null,
      cm.note ? h("div", { class: "cm-note", text: cm.note }) : null,
      acts);
  }

  function bandSection(def, rows, now) {
    if (!rows.length) return null;

    const capped = def.id === "met" && !state.metOpen && rows.length > MET_PAGE;
    const shown = capped ? rows.slice(0, MET_PAGE) : rows;

    const note = def.id === "atrisk"
      ? `Inside the ${state.atRiskHours}-hour at-risk window. Business hours — a deadline four hours away on Friday at 5 PM is Monday lunchtime, and it still needs answering now.`
      : def.note;

    return h("section", { class: `cmp-band band-${def.id}` },
      h("div", { class: "cmp-band-head" },
        h("span", { class: `cmp-dot ${def.tone}` }),
        h("h2", { class: "cmp-band-title", text: def.title }),
        h("span", { class: "cmp-band-count", text: String(rows.length) })),
      note ? h("div", { class: "cmp-band-note", text: note }) : null,
      h("div", { class: "cm-list" }, shown.map((cm) => card(cm, now))),
      capped
        ? h("div", { class: "cmp-more" },
            button(`Show the other ${rows.length - MET_PAGE}`, {
              small: true, onclick: () => { state.metOpen = true; paint(); },
            }))
        : null);
  }

  /* -------------------------------------------------------------- toolbar */

  function toolbar(counts) {
    const findInput = h("input", {
      class: "input queue-find", type: "search", placeholder: "Find in commitments, subjects, accounts…",
      value: state.find,
    });
    findInput.addEventListener("input", debounce(() => {
      state.find = findInput.value;
      setQuery({ q: state.find || null });
      paint({ keepFocus: "find" });
    }, 160));

    const toggle = (label, on, fn) =>
      h("button", { class: `btn sm ${on ? "primary" : ""}`.trim(), type: "button", text: label, onclick: fn });

    return h("div", { class: "toolbar" },
      h("div", { class: "toolbar-row" },
        findInput,
        h("div", { class: "spacer" }),
        counts.closedHidden || state.closed
          ? toggle(
              state.closed ? "Hiding nothing — closed cases shown" : `Show ${counts.closedHidden} on closed cases`,
              state.closed,
              () => {
                state.closed = !state.closed;
                setQuery({ closed: state.closed ? "1" : null });
                savePrefs();
                paint();
              })
          : null,
        counts.historyHidden || state.history
          ? toggle(
              state.history ? "History shown" : `Show history (${counts.historyHidden})`,
              state.history,
              () => {
                state.history = !state.history;
                setQuery({ history: state.history ? "1" : null });
                savePrefs();
                paint();
              })
          : null));
  }

  /* ---------------------------------------------------------------- paint */

  function paint(opts = {}) {
    const now = Date.now();

    if (state.loading) {
      mount(bodyHost, h("div", { class: "cmp-bands" }, skeletonRows(8, [90, 120, 320, 80])));
      mount(bannerHost);
      return;
    }

    if (state.error) {
      mount(bannerHost);
      mount(bodyHost, emptyState({
        title: "Could not load commitments",
        message: state.error.message || "The server did not answer.",
        iconName: "alert",
        action: button("Try again", { kind: "primary", onclick: () => load() }),
      }));
      return;
    }

    /* --- banners: the two things that must never be scrolled past --------- */

    const dupes = state.duplicates || [];
    const unparsed = state.rows.filter(
      (cm) => cm.state === "unparsed" && (state.closed || !cm.isClosed));

    mount(bannerHost,
      dupes.length
        ? banner("error",
            dupes.length === 1
              ? `Case ${dupes[0]} has more than one live deadline. Only one commitment may be active at a time — renegotiate or close the others out.`
              : `${dupes.length} cases have more than one live deadline at once: ${dupes.slice(0, 6).join(", ")}${dupes.length > 6 ? "…" : ""}. Only one commitment may be active per case.`,
            button("Filter to them", {
              small: true,
              onclick: () => {
                state.find = dupes.length === 1 ? dupes[0] : "";
                if (dupes.length > 1) toast("Open each case from the Breached and Upcoming bands below");
                setQuery({ q: state.find || null });
                paint();
              },
            }))
        : null,
      unparsed.length
        ? banner("warn",
            `${unparsed.length} promise${unparsed.length === 1 ? "" : "s"} could not be turned into a deadline. They are counted, not dropped — set a date or dismiss them.`)
        : null);

    /* --- filtering -------------------------------------------------------- */

    const needle = state.find.trim().toLowerCase();
    let closedHidden = 0;
    let historyHidden = 0;

    // Focusing History has to imply showing it, or the deep link lands on a
    // page that is empty for a reason it never explains.
    const showHistory = state.history || state.focus === "history";

    const rows = state.rows.filter((cm) => {
      const band = bandOf(cm, now, state.atRiskHours);
      if (cm.isClosed && !state.closed) { closedHidden++; return false; }
      if (band === "history" && !showHistory) { historyHidden++; return false; }
      if (!needle) return true;
      return [cm.caseNumber, cm.subject, cm.account, cm.plain, cm.note]
        .join(" ").toLowerCase().includes(needle);
    });

    /* --- banding ---------------------------------------------------------- */

    const grouped = new Map(BANDS.map((b) => [b.id, []]));
    state.bands = new Map();
    for (const cm of rows) {
      const id = bandOf(cm, now, state.atRiskHours);
      state.bands.set(cm.id, id);
      grouped.get(id).push(cm);
    }
    // Within a band, soonest first; the undated sink to the bottom.
    for (const list of grouped.values()) {
      list.sort((a, b) => {
        const av = a.dueAt ? Date.parse(a.dueAt) : Infinity;
        const bv = b.dueAt ? Date.parse(b.dueAt) : Infinity;
        return av - bv;
      });
    }
    // Met reads best newest-first: it is a record, not a queue.
    grouped.get("met").reverse();
    grouped.get("history").reverse();

    const visible = state.focus ? BANDS.filter((b) => b.id === state.focus) : BANDS;
    const sections = visible.map((def) => bandSection(def, grouped.get(def.id), now)).filter(Boolean);

    const clearFocus = () => {
      state.focus = null;
      setQuery({ state: null });
      paint();
    };

    mount(bodyHost,
      toolbar({ closedHidden, historyHidden }),
      state.focus && sections.length
        ? banner(
            state.focus === "breached" || state.focus === "atrisk" ? "warn" : "info",
            `Showing only ${BANDS.find((b) => b.id === state.focus).title.toLowerCase()}` +
              ` — ${grouped.get(state.focus).length} of ${rows.length} shown.`,
            button("Show every band", { small: true, onclick: clearFocus }))
        : null,
      sections.length
        ? h("div", { class: "cmp-bands" }, sections)
        : emptyState(
            state.focus
              ? {
                  title: `Nothing ${BANDS.find((b) => b.id === state.focus).title.toLowerCase()}`,
                  message: "That band is empty right now. The other bands may not be.",
                  iconName: "check",
                  kind: "success",
                  action: button("Show every band", { onclick: clearFocus }),
                }
              : needle
              ? {
                  title: "Nothing matches that",
                  message: `No commitment mentions “${state.find.trim()}”. Clear the filter to see the rest.`,
                  iconName: "search",
                  action: button("Clear", {
                    onclick: () => { state.find = ""; setQuery({ q: null }); paint(); },
                  }),
                }
              : {
                  title: "No open commitments",
                  message: "Nothing is promised and outstanding right now. That is the state this page is trying to keep you in.",
                  iconName: "check",
                  kind: "success",
                  action: button("Add one", { iconPaths: ICON_ADD, onclick: () => openAdd() }),
                }));

    if (opts.keepFocus === "find") {
      const el = bodyHost.querySelector(".queue-find");
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
  }

  /* --------------------------------------------------------------- ticker */

  /**
   * Every 30 seconds: re-render the countdown text in place, and re-paint the
   * whole page only if something actually crossed a band boundary. Repainting
   * unconditionally would steal focus from the find box once a minute.
   */
  function tick() {
    const now = Date.now();
    for (const el of $$("[data-countdown]", bodyHost)) {
      const r = bh.remaining(el.dataset.countdown, now);
      if (!r) continue;
      el.textContent = bh.formatBusinessDuration(r.businessMs);
      el.classList.toggle("red", r.overdue);
      el.classList.toggle("amber", !r.overdue && r.businessMs <= state.atRiskHours * 3600000);
    }
    for (const cm of state.rows) {
      if (cm.state !== "active" || !cm.dueAt) continue;
      const was = state.bands.get(cm.id);
      if (was && bandOf(cm, now, state.atRiskHours) !== was) { paint(); return; }
    }
  }

  /* ----------------------------------------------------------------- boot */

  mount(host, page(
    pageHead(
      "Commitments",
      "Follow-up deadlines promised to customers, counted in business hours.",
      [
        button("Add", { kind: "primary", iconPaths: ICON_ADD, small: true, onclick: () => openAdd() }),
        button("Refresh", { small: true, iconPaths: ICON_REFRESH, onclick: () => load() }),
      ]),
    bannerHost,
    bodyHost));

  paint();
  load();
  ticker = setInterval(tick, TICK_MS);

  shell.setPageKeys((e) => {
    if (e.key === "a") { openAdd(); return true; }
    if (e.key === "c") {
      state.closed = !state.closed;
      setQuery({ closed: state.closed ? "1" : null });
      savePrefs(); paint();
      return true;
    }
    if (e.key === "h") {
      state.history = !state.history;
      setQuery({ history: state.history ? "1" : null });
      savePrefs(); paint();
      return true;
    }
    return false;
  });

  return () => {
    if (ticker) clearInterval(ticker);
    shell.setPageKeys(null);
  };
}
