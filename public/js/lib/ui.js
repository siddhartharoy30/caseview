/**
 * Shared UI pieces: toasts, dialogs, skeletons, empty states, banners.
 *
 * Loading is always a skeleton that holds the layout, never a spinner that
 * replaces it — the page should not jump once data arrives.
 */

import { copy, h, icon, mount } from "./dom.js";

/* ------------------------------------------------------------------ toasts */

export function toast(message, kind = "") {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = h("div", { class: "toast " + kind, text: message });
  host.append(el);
  setTimeout(() => {
    el.style.transition = "opacity 200ms";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 220);
  }, kind === "err" ? 4200 : 2200);
}

export const toastError = (err) =>
  toast(typeof err === "string" ? err : err?.message || "Something went wrong", "err");

/* ----------------------------------------------------------------- dialogs */

/**
 * Opens a modal. `render(close)` returns the body; `actions(close)` returns
 * footer buttons. Escape and backdrop click both close.
 */
export function dialog({ title, body, actions, width }) {
  const overlay = h("div", { class: "overlay" });
  const close = (result) => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    if (typeof overlay._onClose === "function") overlay._onClose(result);
  };

  const box = h("div", { class: "dialog", style: width ? { maxWidth: width } : null },
    h("div", { class: "dialog-head" }, title,
      h("button", {
        class: "icon-btn", style: { marginLeft: "auto" }, title: "Close",
        onclick: () => close(null),
      }, icon(["M6 6l12 12", "M18 6L6 18"], 16))),
    h("div", { class: "dialog-body" }, typeof body === "function" ? body(close) : body),
  );

  const footer = typeof actions === "function" ? actions(close) : actions;
  if (footer) box.append(h("div", { class: "dialog-foot" }, footer));

  overlay.append(box);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });

  function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); close(null); }
  }
  document.addEventListener("keydown", onKey);

  document.body.append(overlay);
  const focusable = box.querySelector("input, textarea, select, button.primary");
  if (focusable) focusable.focus();

  return {
    close,
    onClose: (fn) => { overlay._onClose = fn; },
    node: box,
  };
}

/** Confirmation for anything that changes state. Returns a promise. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const d = dialog({
      title,
      body: h("div", { style: { fontSize: "13px", lineHeight: "1.6", color: "var(--text-2)" } }, message),
      actions: (close) => [
        h("button", { class: "btn", onclick: () => close(false) }, "Cancel"),
        h("button", {
          class: "btn " + (danger ? "danger" : "primary"),
          onclick: () => close(true),
        }, confirmLabel),
      ],
    });
    d.onClose((result) => resolve(!!result));
  });
}

/* --------------------------------------------------------------- skeletons */

export function skeletonRows(count = 10, widths = [70, 90, 150, 260, 80, 60, 110]) {
  return h("div", {},
    Array.from({ length: count }, () =>
      h("div", { class: "skel-row" },
        widths.map((w) => h("div", { class: "skel", style: { width: w + "px" } })))));
}

export function skeletonCards(count = 6, height = "104px") {
  return h("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
      gap: "14px",
    },
  }, Array.from({ length: count }, () =>
    h("div", { class: "skel", style: { height, borderRadius: "14px" } })));
}

export function skeletonInto(container, node) {
  mount(container, node);
  return container;
}

/* ------------------------------------------------------------ empty states */

const EMPTY_ICONS = {
  inbox: ["M3 13h5l2 3h4l2-3h5", "M5 6h14l2 7v5a1 1 0 01-1 1H4a1 1 0 01-1-1v-5z"],
  check: ["circle:12,12,9", "M8.5 12.5l2.5 2.5 4.5-5"],
  search: ["circle:11,11,7", "M20 20l-3.5-3.5"],
  clock: ["circle:12,12,9", "M12 7v5l3 2"],
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17.5v.01"],
};

/**
 * `kind: "success"` is used deliberately for an empty Triage queue — nothing
 * waiting on a first response is an achievement, and the page should say so.
 */
export function emptyState({ title, message, iconName = "inbox", kind = "", action }) {
  const svg = icon(EMPTY_ICONS[iconName] || EMPTY_ICONS.inbox, 44);
  svg.classList.add("empty-icon");
  return h("div", { class: "empty " + kind },
    svg,
    h("h3", { text: title }),
    h("p", { text: message }),
    action ? h("div", { style: { marginTop: "16px" } }, action) : null);
}

/* ----------------------------------------------------------------- banners */

export function banner(kind, message, action) {
  return h("div", { class: "banner " + kind },
    icon(kind === "error" ? EMPTY_ICONS.alert : kind === "warn" ? EMPTY_ICONS.clock : EMPTY_ICONS.check, 16),
    h("span", { text: message }),
    action ? h("span", { class: "banner-act" }, action) : null);
}

/* ------------------------------------------------------------------ inputs */

export function field(label, control, hint) {
  return h("div", { class: "field" },
    h("label", { text: label }),
    control,
    hint ? h("div", { class: "hint", text: hint, style: { marginTop: "4px" } }) : null);
}

export function select(options, value, onchange) {
  const el = h("select", { class: "input", onchange: (e) => onchange(e.target.value) },
    options.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label)));
  return el;
}

export function button(label, opts = {}) {
  const { onclick, kind = "", iconPaths, title, small } = opts;
  return h("button", {
    class: `btn ${kind} ${small ? "sm" : ""}`.trim(),
    onclick,
    title: title || null,
  }, iconPaths ? icon(iconPaths, small ? 13 : 15) : null, label);
}

/* -------------------------------------------------------------------- copy */

const ICON_COPY = ["M9 9h10v10H9z", "M5 15V5h10"];

/**
 * copy() resolves to its label and says nothing on screen. A clipboard write
 * with no feedback is indistinguishable from a broken button, so every caller
 * wants the toast — which makes it the helper's job, not the caller's.
 */
export function copyToast(text, label) {
  copy(text, label)
    .then((m) => toast(m, "ok"))
    .catch(() => toast("Could not copy", "err"));
}

/** The small inline copy affordance used beside IDs, values and quoted text. */
export const copyBtn = (text, label, title) =>
  h("button", {
    class: "copybtn",
    type: "button",
    title: title || "Copy",
    onclick: (e) => { e.stopPropagation(); copyToast(text, label); },
  }, icon(ICON_COPY, 13));
