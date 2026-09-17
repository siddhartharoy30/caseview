/**
 * RSC support access — shared between the queue page and case detail
 * (docs/PLAN_V8.md). Follows the same "feature logic shared via lib/" shape
 * as lib/iqs.js: two pages need the identical button-state logic and the
 * identical panel, so both live here rather than being duplicated or having
 * one page reach into the other's closures.
 */

import { h, mount } from "./dom.js";
import { dialog, button } from "./ui.js";
import * as fmt from "./fmt.js";
import * as rscHelper from "./rscHelper.js";
import { api } from "./api.js";
import { copyTiered } from "./copyTiered.js";

/*
 * Keyed by account (the resolved rsc_url), not by case number: the 2-minute
 * cooldown is per pacman account, and the same account can be viewed via
 * several different cases, or from both the queue and case detail. Module
 * scope on purpose, so a token generated from one surface correctly disables
 * the other for the same account -- the authoritative cooldown lives in the
 * RSC helper process itself; this is only the client's own optimistic mirror
 * of it, so a button doesn't look enabled for an account it just generated a
 * token for a moment ago.
 */
const rscCooldowns = new Map();
const RSC_COOLDOWN_MS = 120_000;

function rscCooldownRemainingMs(account) {
  const at = rscCooldowns.get(account);
  if (!at) return 0;
  return Math.max(0, at + RSC_COOLDOWN_MS - Date.now());
}

export function mmss(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The five states the RSC button/badge can be in (docs/PLAN_V8.md). Federal
 * gating is enforced by the caller, not just displayed: a federal/FedRAMP
 * case's `kind` is never "ready", so no caller should wire an onclick to
 * openRscPanel for one.
 */
export function computeRscState(c) {
  if (!c.rscUrl) return { kind: "no-instance", title: "No RSC instance on this case" };
  if (c.usFederal || c.isFedramp) {
    return {
      kind: "federal",
      title: c.federalSupportAccess
        ? `Federal/FedRAMP account — support access: ${c.federalSupportAccess}`
        : "Federal/FedRAMP account — support access goes through a separate process, not prod pacman",
    };
  }
  const remaining = rscCooldownRemainingMs(c.rscUrl);
  if (remaining > 0) {
    return { kind: "cooldown", title: `A token you generated is still live. ${Math.ceil(remaining / 1000)}s remaining.` };
  }
  if (!rscHelper.lastKnownHealthy()) {
    return { kind: "helper-offline", title: "RSC helper not running on your Mac — see docs/RSC_HELPER.md" };
  }
  return { kind: "ready", title: "Generate a support access token" };
}

/**
 * Opens the support-access dialog for case `c`. `opts.onClose`, if given, is
 * called once the panel closes (success, error, or dismissed) so the caller
 * can refresh its own view -- e.g. the queue re-painting a row's badge once
 * the cooldown this generation just started becomes visible.
 */
export function openRscPanel(c, opts = {}) {
  const account = c.rscUrl;
  const caseNumber = c.caseNumber;
  // Opened synchronously from the click itself, before the async generate()
  // call -- opening after an await gets popup-blocked (spec 2.3).
  const loginTab = window.open("", "_blank");

  let grants = null;
  let tickHandle = null;
  const panelBody = h("div", { class: "rsc-panel-body" });

  const d = dialog({
    title: `Support access · ${account.replace(/^https?:\/\//, "")}`,
    width: "440px",
    body: () => panelBody,
  });
  d.onClose(() => {
    if (tickHandle) clearInterval(tickHandle);
    // Clear tokens from JS state, not just the DOM, the moment the panel closes.
    if (grants) for (const g of grants) g.token = "";
    opts.onClose?.();
  });

  function renderLoading() {
    mount(panelBody, h("div", { class: "rsc-loading" }, "Requesting a token…"));
  }

  function renderError(err) {
    if (loginTab && !loginTab.closed) loginTab.close();
    mount(panelBody,
      h("div", { class: "rsc-error" }, err.message),
      h("div", { class: "rsc-actions" }, button("Close", { small: true, onclick: () => d.close() })));
  }

  function renderPicker() {
    mount(panelBody,
      h("p", { class: "rsc-hint" }, "More than one grant is active for this account. Choose who to impersonate."),
      h("div", { class: "rsc-picker" }, grants.map((g) =>
        h("button", { class: "rsc-picker-row", type: "button", onclick: () => pick(g) },
          h("div", { class: "rsc-picker-email", text: g.userEmail }),
          h("div", { class: "rsc-picker-meta", text: `${g.domain} · expires ${fmt.dateShort(g.expiredAt)}` })))));
  }

  function pick(grant) {
    // Never hold more than the chosen grant's token in memory.
    for (const g of grants) if (g !== grant) g.token = "";
    renderGrant(grant);
    copyTiered(grant.token, {
      statusEl: panelBody.querySelector("[data-rsc-copy-status]"),
      detailsEl: panelBody.querySelector("[data-rsc-details]"),
      inputEl: panelBody.querySelector("[data-rsc-token-input]"),
      pbcopy: rscHelper.pbcopy,
    });
    if (loginTab && !loginTab.closed) loginTab.location = grant.url;
    api.rscAudit({ account, caseNumber, userEmail: grant.userEmail }).catch(() => {});
  }

  function renderGrant(grant) {
    mount(panelBody,
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "Impersonating"),
        h("span", { class: "rsc-value" }, `${grant.userEmail} (${grant.domain})`)),
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "Grant expires"),
        h("span", { class: "rsc-value" }, fmt.dateOnly(grant.expiredAt))),
      h("div", { class: "rsc-countdown-row" },
        h("span", { class: "rsc-copy-status", "data-rsc-copy-status": "" }, "Copying…"),
        h("span", { class: "cd rsc-countdown mono" }, mmss(grant.expiresAt - Date.now()))),
      h("div", { class: "rsc-actions" },
        button("Open login page", { small: true, onclick: () => window.open(grant.url, "_blank", "noopener") }),
        button("Copy token again", {
          small: true,
          onclick: () => copyTiered(grant.token, {
            statusEl: panelBody.querySelector("[data-rsc-copy-status]"),
            detailsEl: panelBody.querySelector("[data-rsc-details]"),
            inputEl: panelBody.querySelector("[data-rsc-token-input]"),
            pbcopy: rscHelper.pbcopy,
          }),
        })),
      h("details", { "data-rsc-details": "" },
        h("summary", {}, "Show token"),
        h("textarea", {
          "data-rsc-token-input": "", readonly: true, rows: 3, class: "rsc-token-text mono", text: grant.token,
        })),
      h("p", { class: "rsc-hint" }, "Paste the token at the login screen. Sessions last up to 4 hours."));

    const countdownEl = panelBody.querySelector(".rsc-countdown");
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(() => {
      if (!countdownEl.isConnected) { clearInterval(tickHandle); return; }
      const remaining = grant.expiresAt - Date.now();
      if (remaining <= 0) { clearInterval(tickHandle); renderExpired(); return; }
      countdownEl.textContent = mmss(remaining);
      countdownEl.classList.toggle("red", remaining < 30000);
    }, 1000);
  }

  function renderExpired() {
    // The countdown hitting zero means the token is dead, not just visually.
    if (grants) for (const g of grants) g.token = "";
    const remainingCooldownMs = rscCooldownRemainingMs(account);
    mount(panelBody,
      h("div", { class: "rsc-expired" }, "This token has expired."),
      h("div", { class: "rsc-actions" },
        button("Generate again", {
          small: true,
          disabled: remainingCooldownMs > 0,
          title: remainingCooldownMs > 0 ? `Wait ${Math.ceil(remainingCooldownMs / 1000)}s` : "",
          onclick: () => start(),
        })));
  }

  async function start() {
    renderLoading();
    try {
      grants = await rscHelper.generate(caseNumber, account);
    } catch (err) {
      renderError(err);
      return;
    }
    rscCooldowns.set(account, Date.now());
    if (grants.length > 1) renderPicker();
    else pick(grants[0]);
  }

  start();
}
