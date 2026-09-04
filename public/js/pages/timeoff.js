/**
 * Time Off — Phase 6's coverage calendar.
 *
 * The premise: a missed follow-up deadline is a hard failure (see
 * commitments.js), and going unreachable does not pause any of them. This
 * page is the pre-flight — declare a range, see what falls due inside it,
 * fix or hand off what you can before you actually leave.
 *
 * It surfaces. It does not act. Renegotiating, dismissing, or telling anyone
 * is out of scope here on purpose — later phases own the status-transition
 * watcher and the Slack post, and giving this page that job under this gate
 * would be the same trap Phase 1 declined to walk into with detectKeyword()'s
 * own thresholds. Every commitment below still links straight to its case.
 *
 * Only `active` and `breached` commitments count. `met`, `superseded` and
 * `dismissed` are resolved; `unparsed` has no due date to fall inside a
 * range at all.
 */

import { h, mount, debounce } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as fmt from "../lib/fmt.js";
import { toast, banner, button, field, emptyState, skeletonRows, confirmDialog } from "../lib/ui.js";
import { pageHead, page } from "./_shared.js";

const todayKey = () => fmt.dayKey(new Date());

/** Inclusive day count between two YYYY-MM-DD strings. */
function rangeDays(startDate, endDate) {
  const start = Date.parse(startDate + "T00:00:00Z");
  const end = Date.parse(endDate + "T00:00:00Z");
  return Math.round((end - start) / 86400000) + 1;
}

function rangeStatus(range) {
  const today = todayKey();
  if (range.endDate < today) return "past";
  if (range.startDate <= today) return "current";
  return "upcoming";
}

const STATUS_META = {
  current:  { label: "Now",      tone: "p2" },
  upcoming: { label: "Upcoming", tone: "ok" },
  past:     { label: "Past",     tone: "neutral" },
};

function commitmentRow(cm) {
  return h("a", {
    class: "to-cm-row",
    href: `/case/${encodeURIComponent(cm.caseNumber)}`,
    title: cm.rawText || "",
  },
    h("span", { class: `chip ${cm.state === "breached" ? "p0" : "p2"}`, text: cm.state === "breached" ? "Breached" : "Active" }),
    h("span", { class: "mono to-cm-num", text: cm.caseNumber }),
    h("span", { class: "to-cm-subject", text: cm.subject || "(no subject)" }),
    h("span", { class: "dim to-cm-due", text: cm.dueAt ? fmt.dateTimeShort(cm.dueAt) : "no date" }));
}

/** Shared by the ad-hoc preview (unsaved range) and every saved range's card. */
function paintPreview(host, { loading, commitments }) {
  if (loading) {
    mount(host, h("div", { class: "hint", text: "Checking commitments…" }));
    return;
  }
  if (commitments === null) {
    mount(host, null);
    return;
  }
  if (!commitments.length) {
    mount(host, h("div", { class: "hint to-clear", text: "Nothing due in this window." }));
    return;
  }
  mount(host,
    h("div", {
      class: "hint",
      style: { marginBottom: "6px" },
      text: `${commitments.length} commitment${commitments.length === 1 ? "" : "s"} due while you're out:`,
    }),
    h("div", { class: "to-cm-list" }, commitments.map(commitmentRow)));
}

export function render(ctx, host, shell) {
  const state = { ranges: null, loading: true, error: null };
  let disposed = false;

  const bodyHost = h("div", {});

  async function load() {
    state.loading = true;
    paint();
    try {
      const { ranges } = await api.timeOff();
      if (disposed) return;
      state.ranges = ranges;
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    state.loading = false;
    paint();
  }

  /* ------------------------------------------------------- add-range form */

  const startInput = h("input", { class: "input", type: "date", value: todayKey() });
  const endInput = h("input", { class: "input", type: "date", value: todayKey() });
  const noteInput = h("input", { class: "input", type: "text", placeholder: "PTO, conference, out sick…" });
  const previewHost = h("div", { class: "to-preview" });

  const requestPreview = debounce(async () => {
    const start = startInput.value, end = endInput.value;
    if (!start || !end || end < start) {
      paintPreview(previewHost, { loading: false, commitments: null });
      return;
    }
    paintPreview(previewHost, { loading: true, commitments: null });
    try {
      const { commitments } = await api.commitmentsInRange(start, end);
      if (disposed) return;
      paintPreview(previewHost, { loading: false, commitments });
    } catch {
      if (disposed) return;
      paintPreview(previewHost, { loading: false, commitments: null });
    }
  }, 350);

  startInput.oninput = () => {
    if (endInput.value < startInput.value) endInput.value = startInput.value;
    requestPreview();
  };
  endInput.oninput = requestPreview;

  const saveBtn = button("Save range", {
    kind: "primary", small: true,
    onclick: async () => {
      if (endInput.value < startInput.value) { toast("End date is before the start date", "error"); return; }
      saveBtn.disabled = true;
      try {
        await api.addTimeOff({ startDate: startInput.value, endDate: endInput.value, note: noteInput.value });
        noteInput.value = "";
        toast("Time off saved", "ok");
        load();
      } catch (err) {
        toast(err.message || "Could not save", "error");
      }
      saveBtn.disabled = false;
    },
  });

  const addCard = h("div", { class: "card to-add-card" },
    h("div", { class: "art-head" }, h("span", { class: "art-title", text: "Declare time off" })),
    h("div", { class: "hint", style: { marginBottom: "10px" } },
      "Pick a range to see what's due while you're out, before you save it. This only surfaces commitments — nothing here posts anywhere or notifies anyone."),
    h("div", { class: "to-fields" },
      field("Start", startInput),
      field("End", endInput),
      field("Note (optional)", noteInput)),
    previewHost,
    h("div", { class: "to-add-actions" }, saveBtn));

  requestPreview();

  /* -------------------------------------------------------- saved ranges */

  function rangeCard(range) {
    const status = rangeStatus(range);
    const meta = STATUS_META[status];
    const days = rangeDays(range.startDate, range.endDate);
    const rangePreview = h("div", { class: "to-preview" });

    if (status !== "past") {
      paintPreview(rangePreview, { loading: true, commitments: null });
      api.commitmentsInRange(range.startDate, range.endDate)
        .then(({ commitments }) => { if (!disposed) paintPreview(rangePreview, { loading: false, commitments }); })
        .catch(() => { if (!disposed) paintPreview(rangePreview, { loading: false, commitments: null }); });
    }

    return h("div", { class: `card to-range-card is-${status}` },
      h("div", { class: "art-head" },
        h("span", { class: `chip ${meta.tone}`, text: meta.label }),
        h("span", { class: "to-range-dates", text: `${fmt.dateOnly(range.startDate)} → ${fmt.dateOnly(range.endDate)}` }),
        h("span", { class: "dim", text: `${days} day${days === 1 ? "" : "s"}` }),
        h("div", { class: "spacer" }),
        range.note ? h("span", { class: "dim to-range-note", text: range.note }) : null,
        button("Remove", {
          small: true, kind: "danger",
          onclick: async () => {
            const ok = await confirmDialog({
              title: "Remove this time off range?",
              message: `${fmt.dateOnly(range.startDate)} through ${fmt.dateOnly(range.endDate)}${range.note ? ` — ${range.note}` : ""}`,
              confirmLabel: "Remove", danger: true,
            });
            if (!ok) return;
            await api.deleteTimeOff(range.id);
            toast("Removed", "ok");
            load();
          },
        })),
      status !== "past" ? rangePreview : null);
  }

  function paint() {
    if (state.loading) {
      mount(bodyHost, addCard, skeletonRows(3, [90, 160, 200, 60]));
      return;
    }
    if (state.error) {
      mount(bodyHost, addCard,
        banner("error", state.error.message || "Could not load time off",
          button("Retry", { small: true, onclick: () => load() })));
      return;
    }

    const ranges = (state.ranges || []).slice().sort((a, b) => {
      const order = { current: 0, upcoming: 1, past: 2 };
      const d = order[rangeStatus(a)] - order[rangeStatus(b)];
      return d !== 0 ? d : a.startDate.localeCompare(b.startDate);
    });

    mount(bodyHost,
      addCard,
      h("div", { class: "to-sec-head" },
        h("span", { class: "art-title", text: "Declared ranges" }),
        h("span", { class: "cd-tab-count mono", text: String(ranges.length) })),
      ranges.length
        ? h("div", { class: "to-list" }, ranges.map(rangeCard))
        : emptyState({
            title: "No time off declared yet",
            message: "Add a range above to see what's due while you're away, before you go.",
            iconName: "inbox",
          }));
  }

  mount(host, page(
    pageHead("Time Off", "What's due while you're away, surfaced before you leave."),
    bodyHost));

  paint();
  load();

  return () => { disposed = true; };
}
