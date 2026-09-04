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

  /* ============================================================== coverage */

  /**
   * Phase 7: who covers a case while I'm out.
   *
   * Delivery is a Slack Incoming Webhook, not a bot -- one channel per URL,
   * no OAuth. So "choose which channel" is a short list with one marked
   * active, not a single field: adding the real team channel later is "add
   * a row and switch the active one," and any channel can be tested
   * whether or not it's the one live coverage would actually use.
   *
   * Dry run starts on and stays on until switched off here explicitly --
   * this section always shows which state it's in, in a color a glance
   * catches, because "silently posting for real" is the one failure mode
   * worth over-communicating against.
   */

  const covState = {
    channels: null, activeChannelId: null,
    dryRun: true, triggerStatuses: "",
    posts: null,
    loading: true, error: null,
  };

  const coverageHost = h("div", {});
  const backtestHost = h("div", {});

  async function loadCoverage() {
    covState.loading = true;
    paintCoverage();
    try {
      const [chRes, settingsRes, postsRes] = await Promise.all([
        api.coverageChannels(),
        api.settings(),
        api.coveragePosts(),
      ]);
      if (disposed) return;
      covState.channels = chRes.channels;
      covState.activeChannelId = chRes.activeChannelId;
      covState.dryRun = (settingsRes.settings.coverageDryRun ?? "true") !== "false";
      covState.triggerStatuses = settingsRes.settings.coverageTriggerStatuses || "";
      covState.posts = postsRes.posts;
      covState.error = null;
    } catch (err) {
      covState.error = err;
    }
    covState.loading = false;
    paintCoverage();
  }

  function maskWebhook(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname.slice(0, 24) + "…";
    } catch {
      return url.slice(0, 40) + "…";
    }
  }

  function channelRow(ch) {
    const isActive = ch.id === covState.activeChannelId;

    const testBtn = button("Send test", {
      small: true,
      onclick: async () => {
        testBtn.disabled = true;
        testBtn.textContent = "Sending…";
        try {
          const res = await api.testCoverageChannel(ch.id);
          toast(res.ok ? `Test message sent to "${ch.label}"` : (res.error || "Failed to send"), res.ok ? "ok" : "error");
        } catch (err) {
          toast(err.message || "Could not send test message", "error");
        }
        testBtn.disabled = false;
        testBtn.textContent = "Send test";
      },
    });

    return h("div", { class: `cov-channel-row${isActive ? " is-active" : ""}` },
      h("span", { class: `chip ${isActive ? "ok" : "neutral"}`, text: isActive ? "Active" : "Inactive" }),
      h("span", { class: "cov-channel-label", text: ch.label }),
      h("code", { class: "cov-channel-url dim", text: maskWebhook(ch.webhookUrl) }),
      h("div", { class: "spacer" }),
      testBtn,
      !isActive ? button("Make active", {
        small: true, kind: "primary",
        onclick: async () => {
          try {
            await api.activateCoverageChannel(ch.id);
            toast(`"${ch.label}" is now the active coverage channel`, "ok");
            loadCoverage();
          } catch (err) {
            toast(err.message || "Could not activate", "error");
          }
        },
      }) : null,
      button("Remove", {
        small: true, kind: "danger",
        onclick: async () => {
          const ok = await confirmDialog({
            title: "Remove this channel?", message: ch.label, confirmLabel: "Remove", danger: true,
          });
          if (!ok) return;
          await api.deleteCoverageChannel(ch.id);
          toast("Removed", "ok");
          loadCoverage();
        },
      }));
  }

  const newChannelLabel = h("input", { class: "input", type: "text", placeholder: "e.g. Test channel (personal)" });
  const newChannelUrl = h("input", { class: "input", type: "url", placeholder: "https://hooks.slack.com/services/…" });

  const addChannelBtn = button("Add channel", {
    small: true, kind: "primary",
    onclick: async () => {
      const label = newChannelLabel.value.trim();
      const url = newChannelUrl.value.trim();
      if (!label || !url) { toast("A label and a webhook URL are both required", "error"); return; }
      if (!/^https:\/\//i.test(url)) { toast("Webhook URL must start with https://", "error"); return; }
      addChannelBtn.disabled = true;
      try {
        await api.addCoverageChannel(label, url);
        newChannelLabel.value = ""; newChannelUrl.value = "";
        toast("Channel added", "ok");
        loadCoverage();
      } catch (err) {
        toast(err.message || "Could not add channel", "error");
      }
      addChannelBtn.disabled = false;
    },
  });

  const dryRunInput = h("input", { type: "checkbox" });
  const triggerStatusesInput = h("input", { class: "input", type: "text" });

  const saveTriggerBtn = button("Save", {
    small: true, kind: "primary",
    onclick: async () => {
      saveTriggerBtn.disabled = true;
      try {
        await api.saveSettings({
          coverageDryRun: String(dryRunInput.checked),
          coverageTriggerStatuses: triggerStatusesInput.value,
        });
        toast("Coverage settings saved", "ok");
        loadCoverage();
      } catch (err) {
        toast(err.message || "Could not save", "error");
      }
      saveTriggerBtn.disabled = false;
    },
  });

  const backtestBtn = button("Run 30-day backtest", {
    small: true,
    onclick: async () => {
      backtestBtn.disabled = true;
      backtestBtn.textContent = "Checking Salesforce history…";
      mount(backtestHost, h("div", { class: "hint", text: "Querying real Status history — this hits Salesforce, give it a moment." }));
      try {
        const result = await api.coverageBacktest();
        mount(backtestHost,
          h("div", { class: "hint" },
            `${result.wouldHaveFired} of ${result.transitionsChecked} status changes in the last 30 days would have fired a coverage post, given the current trigger list and your declared time off.`),
          result.sample.length
            ? h("div", { class: "to-cm-list" }, result.sample.map((s) =>
                h("a", { class: "to-cm-row", href: `/case/${encodeURIComponent(s.caseNumber)}` },
                  h("span", { class: "mono to-cm-num", text: s.caseNumber }),
                  h("span", { class: "to-cm-subject", text: `→ ${s.status}` }),
                  h("span", { class: "dim to-cm-due", text: fmt.dateTimeShort(s.at) }))))
            : null);
      } catch (err) {
        mount(backtestHost, banner("error", err.message || "Backtest failed"));
      }
      backtestBtn.disabled = false;
      backtestBtn.textContent = "Run 30-day backtest";
    },
  });

  const POST_STATUS_META = {
    dry_run:   { label: "Dry run",  tone: "neutral" },
    pending:   { label: "Pending",  tone: "p2" },
    sent:      { label: "Sent",     tone: "ok" },
    failed:    { label: "Failed",   tone: "p0" },
    discarded: { label: "Discarded", tone: "neutral" },
  };

  /** Read-only row for anything that isn't waiting on a decision. */
  function historyPostRow(p) {
    const meta = POST_STATUS_META[p.status];
    return h("div", { class: "cov-post" },
      h("div", { class: "cov-post-head" },
        h("span", { class: `chip ${meta.tone}`, text: meta.label }),
        h("a", { class: "mono", href: `/case/${encodeURIComponent(p.caseNumber)}`, text: p.caseNumber }),
        h("span", { class: "dim", text: `→ ${p.triggerStatus}` }),
        h("div", { class: "spacer" }),
        h("span", { class: "dim", text: fmt.dateTimeShort(p.createdAt) })),
      h("pre", { class: "cov-post-body", text: p.body }),
      p.error ? h("div", { class: "hint", style: { color: "var(--red)" }, text: p.error }) : null);
  }

  /**
   * Pending or failed: the two states a human still has to act on. Every
   * post starts in the same textarea whether it will be sent verbatim or
   * edited first -- the same "stage, review, act" shape the Draft tab uses.
   */
  function queuePostRow(p) {
    const meta = POST_STATUS_META[p.status];
    const area = h("textarea", { class: "input cov-queue-area" });
    area.value = p.body;

    const sendBtn = button(p.status === "failed" ? "Retry send" : "Send", {
      small: true, kind: "primary",
      onclick: async () => {
        sendBtn.disabled = true; discardBtn.disabled = true;
        sendBtn.textContent = "Sending…";
        try {
          const edited = area.value.trim() !== p.body.trim() ? area.value : undefined;
          const res = await api.sendCoveragePost(p.id, edited);
          if (res.ok) {
            toast(`Sent to Slack for ${p.caseNumber}`, "ok");
            loadCoverage();
          } else {
            toast(res.error || "Send failed", "error");
            sendBtn.disabled = false; discardBtn.disabled = false;
            sendBtn.textContent = p.status === "failed" ? "Retry send" : "Send";
          }
        } catch (err) {
          toast(err.message || "Send failed", "error");
          sendBtn.disabled = false; discardBtn.disabled = false;
          sendBtn.textContent = p.status === "failed" ? "Retry send" : "Send";
        }
      },
    });
    const discardBtn = button("Discard", {
      small: true, kind: "danger",
      onclick: async () => {
        const ok = await confirmDialog({
          title: "Discard this coverage post?",
          message: `${p.caseNumber} → ${p.triggerStatus}. This does not undo the status change, only the Slack post.`,
          confirmLabel: "Discard", danger: true,
        });
        if (!ok) return;
        await api.discardCoveragePost(p.id);
        toast("Discarded", "ok");
        loadCoverage();
      },
    });

    return h("div", { class: `cov-post cov-post-queued t-${meta.tone}` },
      h("div", { class: "cov-post-head" },
        h("span", { class: `chip ${meta.tone}`, text: meta.label }),
        h("a", { class: "mono", href: `/case/${encodeURIComponent(p.caseNumber)}`, text: p.caseNumber }),
        h("span", { class: "dim", text: `→ ${p.triggerStatus}` }),
        h("div", { class: "spacer" }),
        h("span", { class: "dim", text: fmt.dateTimeShort(p.createdAt) })),
      p.error ? h("div", { class: "hint", style: { color: "var(--red)", marginBottom: "6px" }, text: p.error }) : null,
      area,
      h("div", { class: "cov-queue-actions" }, sendBtn, discardBtn));
  }

  function paintCoverage() {
    if (covState.loading) {
      mount(coverageHost,
        h("div", { class: "to-sec-head" }, h("span", { class: "art-title", text: "Coverage" })),
        skeletonRows(3, [140, 200, 100]));
      return;
    }
    if (covState.error) {
      mount(coverageHost,
        h("div", { class: "to-sec-head" }, h("span", { class: "art-title", text: "Coverage" })),
        banner("error", covState.error.message || "Could not load coverage settings",
          button("Retry", { small: true, onclick: () => loadCoverage() })));
      return;
    }

    dryRunInput.checked = covState.dryRun;
    triggerStatusesInput.value = covState.triggerStatuses;

    mount(coverageHost,
      h("div", { class: "to-sec-head" }, h("span", { class: "art-title", text: "Coverage" })),

      covState.dryRun
        ? banner("info", "Dry run is on — coverage posts are composed and recorded, but nothing is sent to Slack, and none are offered for sending.")
        : banner("warn", "Dry run is off. A matching status change during declared time off will compose a post and place it in the queue below — nothing sends until you click Send on it."),

      h("div", { class: "card cov-card" },
        h("div", { class: "art-head" }, h("span", { class: "art-title", text: "Channels" })),
        h("div", { class: "hint", style: { marginBottom: "10px" } },
          "One channel is active at a time — that's where a real, non-dry-run post goes. Any channel can be tested regardless of which one is active."),
        covState.channels.length
          ? h("div", { class: "cov-channels" }, covState.channels.map(channelRow))
          : h("div", { class: "hint" }, "No channel added yet."),
        h("div", { class: "cov-add-channel" }, newChannelLabel, newChannelUrl, addChannelBtn)),

      h("div", { class: "card cov-card" },
        h("div", { class: "art-head" }, h("span", { class: "art-title", text: "Trigger" })),
        h("label", { class: "checkline" }, dryRunInput,
          h("span", { text: "Dry run (recommended until you've tested a channel)" })),
        field("Trigger statuses (comma-separated)", triggerStatusesInput,
          "A status transition into one of these, while time off is active, is what composes a coverage post."),
        saveTriggerBtn),

      h("div", { class: "card cov-card" },
        h("div", { class: "art-head" },
          h("span", { class: "art-title", text: "30-day backtest" }),
          h("div", { class: "spacer" }),
          backtestBtn),
        h("div", { class: "hint", style: { marginBottom: "8px" } },
          "Checks real Salesforce Status history against the trigger list above and your declared time off — not a simulation."),
        backtestHost),

      (() => {
        const queue = covState.posts.filter((p) => p.status === "pending" || p.status === "failed");
        const history = covState.posts.filter((p) => p.status !== "pending" && p.status !== "failed");
        return h("div", {},
          h("div", { class: "card cov-card" },
            h("div", { class: "art-head" },
              h("span", { class: "art-title", text: "Approval queue" }),
              h("span", { class: "cd-tab-count mono", text: String(queue.length) })),
            h("div", { class: "hint", style: { marginBottom: "10px" } },
              "Nothing here sends itself. Edit the text if you want, then Send or Discard each one."),
            queue.length
              ? h("div", { class: "cov-posts" }, queue.map(queuePostRow))
              : h("div", { class: "hint" }, "Nothing waiting on you right now.")),

          h("div", { class: "card cov-card" },
            h("div", { class: "art-head" },
              h("span", { class: "art-title", text: "History" }),
              h("span", { class: "cd-tab-count mono", text: String(history.length) })),
            history.length
              ? h("div", { class: "cov-posts" }, history.map(historyPostRow))
              : h("div", { class: "hint" }, "Nothing recorded yet.")));
      })());
  }

  mount(host, page(
    pageHead("Time Off", "What's due while you're away, surfaced before you leave."),
    bodyHost,
    coverageHost));

  paint();
  load();
  loadCoverage();

  return () => { disposed = true; };
}
