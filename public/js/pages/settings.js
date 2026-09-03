/**
 * Settings — the page that says what this thing is actually doing.
 *
 * Mostly a form over /api/settings, which stores any key present in
 * SETTING_DEFAULTS and silently ignores the rest. Four decisions worth
 * recording, because each one is a place where the obvious build would have
 * shipped a control that looks like it works and does not:
 *
 *   1. Theme and density are browser state, not server state. app.js reads
 *      localStorage and toggles a body class; the server's theme row is never
 *      consulted by anything. So the controls here drive the same localStorage
 *      keys app.js reads, mirror them to the server so the two do not drift,
 *      and the section says where the value actually lives.
 *
 *   2. Numeric settings save on blur, not behind one Save button. Eight fields
 *      under a single button makes it ambiguous which of them took; each field
 *      here validates its own range, reports its own result, and rejects a
 *      value the server would have accepted as a string and then behaved
 *      strangely on — a sync interval of 0 would spin.
 *
 *   3. Notification preferences are read back out of lib/notify.js rather than
 *      kept here, because the poller re-reads them every tick. Toggling one is
 *      immediate and needs no restart and no wiring between the two modules.
 *
 *   4. Rebuilding the cache is the only destructive control in the app. It
 *      sits last, styled as such, behind a confirmation that names the row
 *      counts it is about to delete and says which rows survive.
 *
 * The webhook is off by default, refuses anything that is not https, and by
 * default sends case numbers and event kinds only. Its sub-toggle — the one
 * that lets customer-written subjects leave this machine — is separate,
 * off, and labelled as what it is.
 */

import { h, mount } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as store from "../lib/store.js";
import {
  banner,
  button,
  confirmDialog,
  emptyState,
  skeletonCards,
  toast,
  toastError,
} from "../lib/ui.js";
import * as fmt from "../lib/fmt.js";
import { pageHead, page } from "./_shared.js";
import * as notify from "../lib/notify.js";

/* ------------------------------------------------------------------ config */

const ICON_REFRESH = ["M20 11a8 8 0 10-2.3 5.7", "M20 5v6h-6"];

/**
 * Ranges live here rather than on the server because the server treats every
 * setting as an opaque string on purpose. A bad value should be caught where
 * somebody can read the reason, not absorbed into the table and rediscovered
 * later as odd behaviour.
 */
const SCHEDULE_FIELDS = [
  {
    key: "syncIntervalMinutes",
    label: "Sync interval",
    unit: "minutes",
    min: 1,
    max: 240,
    hint: "How often Salesforce is polled, inside the window below.",
  },
  {
    key: "activeWindowStart",
    label: "Window opens",
    unit: "hour, New York",
    min: 0,
    max: 23,
    hint: "Nothing syncs before this hour.",
  },
  {
    key: "activeWindowEnd",
    label: "Window closes",
    unit: "hour, New York",
    min: 1,
    max: 24,
    hint: "Set 0 and 24 to sync around the clock.",
  },
];

const THRESHOLD_FIELDS = [
  {
    key: "staleDays",
    label: "Stale after",
    unit: "days",
    min: 1,
    max: 60,
    hint: "An open case with no movement for this long is flagged stale in the Queue.",
  },
  {
    key: "atRiskHours",
    label: "Commitment at risk within",
    unit: "hours",
    min: 1,
    max: 168,
    hint: "How close a deadline gets before the Commitments badge starts counting it.",
  },
  {
    key: "escalationUpdateHours",
    label: "Escalation update cadence",
    unit: "hours",
    min: 1,
    max: 336,
    hint: "How long an escalation may go without an outbound update before Escalations calls it overdue.",
  },
  {
    key: "closedCaseWindowDays",
    label: "Keep closed cases",
    unit: "days",
    min: 7,
    max: 730,
    hint: "How far back closed cases are retained. The scorecard cannot look further back than this.",
  },
];

const CACHE_ROWS = [
  ["cases", "Cases"],
  ["openCases", "Open"],
  ["comments", "Comments"],
  ["commitments", "Commitments"],
  ["artifacts", "Artifacts"],
  ["events", "Events"],
];

/* -------------------------------------------------------------------- bits */

function section(title, subtitle, ...children) {
  return h("section", { class: "set-card card" },
    h("header", { class: "set-head" },
      h("h2", { class: "set-title", text: title }),
      subtitle ? h("p", { class: "set-sub", text: subtitle }) : null),
    h("div", { class: "set-body" }, children));
}

function row(label, value, opts) {
  const o = opts || {};
  const empty = value === null || value === undefined || value === "";
  return h("div", { class: "set-row" },
    h("span", { class: "set-row-label", text: label }),
    h("span", { class: "set-row-value" + (o.mono ? " mono" : "") },
      empty ? h("span", { class: "dim", text: "—" }) : value));
}

/** A checkbox that owns its own save, so each one can report its own result. */
function toggle(label, checked, hint, onchange) {
  const input = h("input", { type: "checkbox", checked: !!checked });
  input.addEventListener("change", () => onchange(input.checked, input));
  return h("label", { class: "set-toggle" },
    input,
    h("span", { class: "set-toggle-text" },
      h("span", { class: "set-toggle-label", text: label }),
      hint ? h("span", { class: "set-toggle-hint", text: hint }) : null));
}

function segmented(options, current, onpick) {
  return h("div", { class: "seg" }, options.map((o) =>
    h("button", {
      class: "seg-btn" + (o.id === current ? " on" : ""),
      type: "button",
      text: o.label,
      onclick: () => onpick(o.id),
    })));
}

/* ------------------------------------------------------------------ render */

export function render(_ctx, host, shell) {
  const state = { data: null, loading: true, error: null };
  const bodyHost = h("div", {});
  let disposed = false;

  /* ----------------------------------------------------------------- data */

  async function load() {
    state.loading = true;
    paint();
    try {
      const data = await api.settings();
      if (disposed) return;
      state.data = data;
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    if (disposed) return;
    state.loading = false;
    paint();
  }

  function settingOf(key) {
    const s = (state.data && state.data.settings) || {};
    const d = (state.data && state.data.defaults) || {};
    return s[key] !== undefined ? s[key] : d[key];
  }

  const boolOf = (key) => String(settingOf(key)) === "true";

  /**
   * One save path for everything. The server echoes the whole settings map
   * back, and we keep that rather than what was typed, so the page always
   * shows stored state instead of intended state.
   */
  async function save(patch, okMessage) {
    try {
      const res = await api.saveSettings(patch);
      if (disposed) return false;
      if (state.data && res && res.settings) state.data.settings = res.settings;
      if (okMessage) toast(okMessage);
      return true;
    } catch (err) {
      toastError(err);
      paint();
      return false;
    }
  }

  /* -------------------------------------------------------------- numerics */

  function numericField(spec) {
    const err = h("div", { class: "set-err", hidden: true });
    const input = h("input", {
      class: "input set-num",
      type: "number",
      value: String(settingOf(spec.key) ?? ""),
      min: String(spec.min),
      max: String(spec.max),
      step: "1",
    });

    async function commit() {
      const raw = input.value.trim();
      const n = Number(raw);
      const bad = !raw || !Number.isInteger(n) || n < spec.min || n > spec.max;
      if (bad) {
        err.textContent = "Whole number between " + spec.min + " and " + spec.max + ".";
        err.hidden = false;
        input.classList.add("bad");
        return;
      }
      err.hidden = true;
      input.classList.remove("bad");
      if (String(n) === String(settingOf(spec.key))) return; // nothing moved
      if (await save({ [spec.key]: String(n) }, spec.label + " saved")) input.value = String(n);
    }

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });

    return h("div", { class: "set-field" },
      h("label", { class: "set-field-label" },
        h("span", { text: spec.label }),
        h("span", { class: "set-unit", text: spec.unit })),
      input,
      h("p", { class: "set-field-hint", text: spec.hint }),
      err);
  }

  /* ------------------------------------------------------------- sections */

  function connectionSection() {
    const sf = (state.data && state.data.salesforce) || {};
    const sync = (state.data && state.data.sync) || {};
    const errors = Number(sync.errorCount || 0);

    const status = sync.running
      ? h("span", { class: "chip p3", text: "syncing now" })
      : errors > 3
        ? h("span", { class: "chip p1", text: "failing" })
        : errors > 0
          ? h("span", { class: "chip p2", text: errors + " recent " + (errors === 1 ? "failure" : "failures") })
          : h("span", { class: "chip ok", text: "healthy" });

    return section(
      "Salesforce connection",
      "Read-only. Nothing in QView writes back to Salesforce.",
      h("div", { class: "set-rows" },
        row("Instance", sf.instanceHost ? h("code", { class: "mono", text: sf.instanceHost }) : null),
        row("API version", sf.apiVersion, { mono: true }),
        row("Syncing as", sf.ownerName),
        row("Email bodies", sf.emailsUnavailable
          ? h("span", { class: "chip p2", text: "not permitted" })
          : h("span", { class: "chip ok", text: "readable" })),
        row("Status", status),
        row("Last success", sync.lastSuccess
          ? h("span", {},
              h("span", { text: fmt.dateTime(sync.lastSuccess) }),
              h("span", { class: "dim", text: " · " + fmt.relative(sync.lastSuccess) }))
          : null),
        row("Last attempt", sync.lastAttempt ? fmt.dateTimeShort(sync.lastAttempt) : null),
        row("Last run", sync.lastDurationMs != null ? Math.round(sync.lastDurationMs) + " ms" : null, { mono: true }),
        row("Watermark", sync.watermark ? fmt.dateTime(Date.parse(sync.watermark)) : null),
        sync.lastError
          ? row("Last error", h("span", { class: "set-error-text", text: sync.lastError }))
          : null),

      h("div", { class: "set-actions" },
        button("Sync now", {
          kind: "primary",
          small: true,
          iconPaths: ICON_REFRESH,
          onclick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await shell.manualSync();
              setTimeout(() => { if (!disposed) load(); }, 2500);
            } finally {
              btn.disabled = false;
            }
          },
        })));
  }

  function scheduleSection() {
    return section(
      "Sync schedule",
      "Every page reads the local cache, never Salesforce directly. These numbers decide how fresh that cache is.",
      h("div", { class: "set-grid" }, SCHEDULE_FIELDS.map(numericField)),
      toggle(
        "Weekdays only",
        boolOf("activeWindowWeekdaysOnly"),
        "Skip weekends. Commitment deadlines still fire on the next sync after them.",
        async (checked, el) => {
          el.disabled = true;
          await save({ activeWindowWeekdaysOnly: String(checked) },
            checked ? "Weekends off" : "Weekends on");
          el.disabled = false;
          shell.refreshSync();
        },
      ));
  }

  function thresholdSection() {
    return section(
      "Thresholds",
      "What the sidebar badges count and what the Queue, Commitments and Escalations pages call urgent.",
      h("div", { class: "set-grid" }, THRESHOLD_FIELDS.map(numericField)),
      h("p", { class: "set-field-hint",
        text: "Changes apply on the next badge refresh, within a minute." }));
  }

  function notificationSection() {
    const perm = notify.permission();
    const prefs = notify.prefs();
    const live = prefs.enabled && perm === "granted";

    const permChip =
      perm === "granted"     ? h("span", { class: "chip ok",      text: "allowed" })
      : perm === "denied"    ? h("span", { class: "chip p1",      text: "blocked" })
      : perm === "unsupported" ? h("span", { class: "chip neutral", text: "unsupported" })
      : h("span", { class: "chip p2", text: "not asked yet" });

    const controls = [
      h("div", { class: "set-inline" },
        h("span", { class: "set-inline-label", text: "Browser permission" }),
        permChip,
        h("span", { class: "spacer" }),
        perm === "default"
          ? button("Allow", {
              small: true,
              kind: "primary",
              onclick: async () => {
                const result = await notify.requestPermission();
                if (result === "granted") {
                  notify.setPrefs({ enabled: true });
                  save({ notificationsEnabled: "true" });
                }
                paint();
              },
            })
          : null,
        perm === "granted"
          ? button("Send a test", {
              small: true,
              onclick: () => {
                if (notify.testNotification()) toast("Test notification sent");
                else toast("The browser refused to show it", "err");
              },
            })
          : null),
    ];

    if (perm === "denied") {
      controls.push(banner("warn",
        "This site is blocked from showing notifications. Nothing here can re-ask — it has to be changed in the browser's own site permissions."));
    }

    controls.push(toggle(
      "Show desktop notifications",
      live,
      perm === "granted"
        ? "Polled once a minute. Events from before this tab opened are not replayed as popups, and more than three at once collapse into one summary."
        : "Needs browser permission first.",
      (checked, el) => {
        if (checked && perm !== "granted") {
          el.checked = false;
          toast("Grant browser permission first", "err");
          return;
        }
        notify.setPrefs({ enabled: checked });
        save({ notificationsEnabled: String(checked) });
        paint();
      },
    ));

    if (live) {
      controls.push(h("div", { class: "set-subgroup" },
        h("p", { class: "set-subgroup-label", text: "Interrupt me for" }),
        notify.KINDS.map((k) => toggle(
          k.label,
          prefs.kinds[k.id] !== false,
          null,
          (checked) => {
            const kinds = Object.assign({}, notify.prefs().kinds);
            kinds[k.id] = checked;
            notify.setPrefs({ kinds });
          },
        ))));
    }

    return section(
      "Notifications",
      "Four things are worth an interruption: a new case, a customer reply, a commitment about to come due, and one already missed.",
      controls);
  }

  function webhookSection() {
    const enabled = boolOf("webhookEnabled");
    const urlInput = h("input", {
      class: "input",
      type: "url",
      placeholder: "https://hooks.slack.com/services/…",
      value: settingOf("webhookUrl") || "",
      autocomplete: "off",
      spellcheck: "false",
    });

    const children = [
      banner("info",
        "The only thing in QView that sends anything off this machine. Off by default, https only, and unless the second toggle is on it sends a case number and an event kind — never a subject or a message body."),
      toggle("Send events to a webhook", enabled,
        "Slack-compatible: a JSON body with a text field, so anything that accepts a Slack incoming webhook accepts this.",
        async (checked, el) => {
          el.disabled = true;
          await save({ webhookEnabled: String(checked) });
          el.disabled = false;
          paint();
        }),
    ];

    if (enabled) {
      children.push(
        h("div", { class: "set-field" },
          h("label", { class: "set-field-label" }, h("span", { text: "Webhook URL" })),
          h("div", { class: "set-url" },
            urlInput,
            button("Save", {
              small: true,
              onclick: async () => {
                const url = urlInput.value.trim();
                if (url && !/^https:\/\//i.test(url)) {
                  toast("The URL must start with https://", "err");
                  return;
                }
                await save({ webhookUrl: url }, url ? "Webhook URL saved" : "Webhook URL cleared");
              },
            }),
            button("Send test", {
              small: true,
              onclick: async (e) => {
                const btn = e.currentTarget;
                const url = urlInput.value.trim();
                if (!/^https:\/\//i.test(url)) {
                  toast("The URL must start with https://", "err");
                  return;
                }
                btn.disabled = true;
                try {
                  const res = await api.testWebhook(url);
                  toast(res && res.ok ? "Test message delivered" : "The destination rejected it",
                    res && res.ok ? "" : "err");
                } catch (err) {
                  toastError(err);
                } finally {
                  btn.disabled = false;
                }
              },
            })),
          h("p", { class: "set-field-hint",
            text: "The test body is a fixed string with no case data in it, so a mistyped URL leaks nothing. Real events are retried three times, then given up on." })),

        toggle("Include case subjects in the message", boolOf("webhookIncludeSubject"),
          "Off means the destination sees a case number and what happened. On means customer-written text leaves this machine.",
          async (checked, el) => {
            el.disabled = true;
            await save({ webhookIncludeSubject: String(checked) },
              checked ? "Subjects will be included" : "Subjects will not be sent");
            el.disabled = false;
          }));
    }

    return section("Webhook", "Optional, and off unless you switch it on.", children);
  }

  function appearanceSection() {
    const theme = store.get("theme", "dark");
    const density = store.get("density", "default");

    return section(
      "Appearance",
      "Stored in this browser rather than on the server, so it follows the machine and not the account.",
      h("div", { class: "set-inline" },
        h("span", { class: "set-inline-label", text: "Theme" }),
        h("span", { class: "spacer" }),
        segmented([{ id: "dark", label: "Dark" }, { id: "light", label: "Light" }], theme, (id) => {
          store.set("theme", id);
          document.body.classList.toggle("light", id === "light");
          document.body.classList.toggle("dark", id !== "light");
          save({ theme: id }); // mirrored so the two stores cannot disagree
          paint();
        })),
      h("div", { class: "set-inline" },
        h("span", { class: "set-inline-label", text: "Density" }),
        h("span", { class: "spacer" }),
        segmented(
          [{ id: "compact", label: "Compact" }, { id: "default", label: "Default" }, { id: "roomy", label: "Roomy" }],
          density,
          (id) => {
            store.set("density", id);
            shell.applyDensity(id);
            paint();
          })));
  }

  function cacheSection() {
    const cache = (state.data && state.data.cache) || {};
    const sync = (state.data && state.data.sync) || {};

    const counts = CACHE_ROWS
      .filter(([k]) => cache[k] !== undefined)
      .map(([k, label]) => h("div", { class: "set-count" },
        h("span", { class: "set-count-n mono", text: fmt.num(cache[k]) }),
        h("span", { class: "set-count-label", text: label })));

    return section(
      "Local cache",
      "Everything the app shows is read from here. Salesforce is touched only by the sync.",
      h("div", { class: "set-counts" }, counts),
      h("div", { class: "set-rows" },
        row("Salesforce API calls this run", fmt.num(sync.apiCalls || 0), { mono: true }),
        row("Consecutive failures", Number(sync.errorCount || 0) > 0
          ? h("span", { class: "chip p1", text: String(sync.errorCount) })
          : h("span", { class: "chip ok", text: "0" }))),

      h("div", { class: "set-danger" },
        h("p", { class: "set-danger-note",
          text: "Rebuilding empties the cache and pulls everything back from Salesforce. Commitments you added by hand and scorecard numbers you entered by hand both survive it; commitments parsed out of case text are re-derived. It takes a minute or two, and the app is thin until it finishes." }),
        button("Rebuild cache", {
          kind: "danger",
          small: true,
          onclick: async (e) => {
            const ok = await confirmDialog({
              title: "Rebuild the cache?",
              message: "This deletes " + fmt.num(cache.cases || 0) + " cached cases, "
                + fmt.num(cache.comments || 0) + " comments and " + fmt.num(cache.artifacts || 0)
                + " artifacts, then resyncs from Salesforce. Your own commitments and manual metrics are kept.",
              confirmLabel: "Rebuild",
              danger: true,
            });
            if (!ok) return;
            const btn = e.currentTarget;
            btn.disabled = true;
            toast("Rebuilding — this can take a minute");
            try {
              const res = await api.rebuildCache();
              toast(res && res.ok ? "Cache rebuilt" : "Rebuild finished with errors",
                res && res.ok ? "" : "err");
            } catch (err) {
              toastError(err);
            } finally {
              if (!disposed) {
                btn.disabled = false;
                await load();
                shell.refreshCounts();
                shell.refreshSync();
              }
            }
          },
        })));
  }

  /* ---------------------------------------------------------------- paint */

  function paint() {
    if (state.loading) {
      mount(bodyHost, skeletonCards(4, "190px"));
      return;
    }
    if (state.error) {
      mount(bodyHost, emptyState({
        title: "Could not load settings",
        message: state.error.message || "The server did not answer.",
        iconName: "alert",
        kind: "error",
        action: button("Try again", { kind: "primary", onclick: () => load() }),
      }));
      return;
    }

    mount(bodyHost, h("div", { class: "set-list" },
      connectionSection(),
      scheduleSection(),
      thresholdSection(),
      notificationSection(),
      webhookSection(),
      appearanceSection(),
      cacheSection()));
  }

  /* ----------------------------------------------------------------- boot */

  mount(host, page(
    pageHead(
      "Settings",
      "How often this syncs, what it treats as urgent, and what it is allowed to tell you about.",
      [button("Reload", { small: true, iconPaths: ICON_REFRESH, onclick: () => load() })]),
    bodyHost));

  paint();
  load();

  return () => { disposed = true; };
}
