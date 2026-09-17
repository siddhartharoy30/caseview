/**
 * CDM UI access — shared between the queue page and case detail, the CDM
 * sibling to lib/rsc.js (docs/PLAN_V8_CDM.md). Unlike RSC, this drives a
 * whole helper-side session (tunnel + tokened UI), not a single token
 * generation, so the panel here polls a session's state rather than holding
 * everything in one response.
 *
 * Deliberately no dock/monitor singleton: a session lives in the CDM helper
 * process regardless of whether any panel is open, so reopening a case
 * re-hydrates from cdmHelper.listSessions() -- there's nothing here that
 * needs to keep running in the background the way the phone queue does.
 */

import { h, mount } from "./dom.js";
import { dialog, button, copyToast } from "./ui.js";
import * as fmt from "./fmt.js";
import * as cdmHelper from "./cdmHelper.js";
import { api } from "./api.js";
import { copyTiered } from "./copyTiered.js";

const POLL_MS = 2000;

// Mirrors src/cdmVersion.ts's uiPathFor() -- kept here too so "Open UI" can
// open the URL directly in the operator's own browser tab (window.open)
// instead of routing through the helper's isolated-Chrome-window launch.
// Trade-off, stated plainly: __Secur-rubrik-token is scoped by host, not
// port, so two CDM sessions to *different* clusters open concurrently in
// this same browser will collide on that cookie. Fine for the common case
// of one session at a time; worth remembering if a second one is ever open.
const UI_PATHS = { crystal: "/web/bin/index.html#/welcome_support", luna: "/web/v2/#/support_access_login" };

/** Gate is "cluster UUID present" -- Platform__c must NOT gate this (three
 * Polaris-platform cases in the live data have populated clusters). */
export function computeCdmState(c) {
  if (!c.clusterUuid && !c.cluster2Uuid) return { kind: "no-cluster", title: "No CDM cluster on this case" };
  if (!cdmHelper.lastKnownHealthy()) {
    return { kind: "helper-offline", title: "CDM helper not running on your Mac — see docs/CDM_HELPER.md" };
  }
  return { kind: "ready", title: "Open a CDM tunnel and the cluster UI" };
}

/** 0, 1, or 2 entries -- two-cluster cases are rare but real (one in the
 * live sample: 01308000). */
export function clustersFor(c) {
  const out = [];
  if (c.clusterUuid) out.push({ uuid: c.clusterUuid, tag: c.clusterTag, version: c.clusterVersion });
  if (c.cluster2Uuid) out.push({ uuid: c.cluster2Uuid, tag: c.cluster2Tag, version: c.cluster2Version });
  return out;
}

function fmtElapsed(startedAt) {
  const total = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Opens the CDM access dialog for case `c`. Mirrors openRscPanel's shape
 * (one long-lived panelBody, re-mounted per state) but the state machine is
 * longer: picker (if 2 clusters) → confirm → connecting (polled) → open →
 * stopped/error, plus a UI chooser when neither Salesforce version source
 * parses (docs/PLAN_V8_CDM.md's Crystal/Luna decision).
 */
export function openCdmPanel(c, opts = {}) {
  const clusters = clustersFor(c);
  const caseNumber = c.caseNumber;
  const caseVersionRaw = c.caseVersionRaw;

  let session = null;
  let pollHandle = null;
  let tickHandle = null;
  const panelBody = h("div", { class: "rsc-panel-body cdm-panel-body" });

  const d = dialog({ title: `CDM access · ${caseNumber}`, width: "460px", body: () => panelBody });
  d.onClose(() => {
    if (pollHandle) clearTimeout(pollHandle);
    if (tickHandle) clearInterval(tickHandle);
    opts.onClose?.();
  });

  function renderPicker() {
    mount(panelBody,
      h("p", { class: "rsc-hint" }, "This case has two clusters. Choose which one to access."),
      h("div", { class: "rsc-picker" }, clusters.map((cl) =>
        h("button", { class: "rsc-picker-row cdm-picker-row", type: "button", onclick: () => renderConfirm(cl) },
          h("div", { class: "rsc-picker-email", text: cl.tag || cl.uuid }),
          h("div", { class: "rsc-picker-meta mono", text: cl.uuid }),
          h("div", { class: "rsc-picker-meta", text: cl.version ? `Version ${cl.version}` : "Version unknown" })))));
  }

  function renderConfirm(cluster) {
    mount(panelBody,
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "Cluster"),
        h("span", { class: "rsc-value" }, cluster.tag || "(no tag)")),
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "UUID"),
        h("span", { class: "rsc-value mono" }, cluster.uuid)),
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "Version"),
        h("span", { class: "rsc-value" }, cluster.version || "unknown")),
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "Ticket"),
        h("span", { class: "rsc-value mono" }, caseNumber)),
      h("p", { class: "rsc-hint" },
        "This opens a real support tunnel and claims access against this case in the Teleport audit trail. Not automatic — confirm to proceed."),
      h("div", { class: "rsc-actions" },
        button("Open tunnel", { small: true, onclick: () => start(cluster) }),
        clusters.length > 1 ? button("Back", { small: true, onclick: renderPicker }) : null));
  }

  function renderConnecting(stateLabel) {
    mount(panelBody, h("div", { class: "rsc-loading" }, stateLabel));
  }

  function renderError(err) {
    mount(panelBody,
      h("div", { class: "rsc-error" }, err.message),
      h("div", { class: "rsc-actions" },
        button("Close", { small: true, onclick: () => d.close() })));
  }

  function manualCommandBlock() {
    const cmdEl = h("code", { class: "cdm-mono-line", text: `portal_client connect` });
    return h("details", { class: "cdm-manual" },
      h("summary", {}, "Manual token (always available)"),
      h("p", { class: "rsc-hint" },
        "If automatic token generation isn't available yet, open the bastion shell yourself and run the cluster's spray-token script (see internal docs), then paste the result below."),
      h("div", { class: "cdm-cmd-row" }, cmdEl,
        button("Copy", { small: true, onclick: () => copyToast("portal_client connect", "Command copied") })),
      h("div", { class: "cdm-token-paste-row" },
        h("input", { type: "text", class: "cdm-token-input", placeholder: "Paste the spray token here" }),
        button("Use token", {
          small: true,
          onclick: async (e) => {
            const input = e.target.closest(".cdm-token-paste-row").querySelector(".cdm-token-input");
            if (!input.value) return;
            const ok = await cdmHelper.manualToken(session.id, input.value);
            input.value = "";
            const statusEl = panelBody.querySelector("[data-cdm-copy-status]");
            if (statusEl) {
              statusEl.textContent = ok ? "Token copied to clipboard" : "Could not copy — try again";
              statusEl.className = ok ? "rsc-copy-status ok" : "rsc-copy-status warn";
            }
          },
        })));
  }

  function renderOpen() {
    const flavorKnown = !!session.uiFlavor;
    mount(panelBody,
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "Cluster"),
        h("span", { class: "rsc-value" }, session.clusterTag || session.clusterUuid)),
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "Local port"),
        h("span", { class: "rsc-value mono" }, String(session.localPort))),
      h("div", { class: "rsc-row" },
        h("span", { class: "rsc-label" }, "Token"),
        h("span", { class: "rsc-value", text: session.tokenStatus === "auto" ? "Generated automatically" : session.tokenStatus === "manual" ? "Pasted manually" : "Not generated yet" })),
      h("div", { class: "rsc-countdown-row" },
        h("span", { class: "rsc-copy-status", "data-cdm-copy-status": "" }, ""),
        h("span", { class: "cd cdm-elapsed mono" }, fmtElapsed(session.startedAt))),
      !flavorKnown
        ? h("div", { class: "cdm-flavor-chooser" },
            h("p", { class: "rsc-hint" }, "Version unknown — pick the CDM UI to open."),
            h("div", { class: "rsc-actions" },
              button("Crystal (pre-9.4)", { small: true, onclick: () => openUi("crystal") }),
              button("Luna (9.4+)", { small: true, onclick: () => openUi("luna") })))
        : null,
      h("div", { class: "rsc-actions" },
        flavorKnown ? button("Open UI", { small: true, onclick: () => openUi() }) : null,
        button("Generate token", { small: true, onclick: generateToken }),
        button("Stop session", { small: true, kind: "danger", onclick: stop })),
      // Separate from the compact copy-status span above -- a denial's
      // diagnostic detail (OS user, username tried, the script's own
      // stderr, the validation HTTP status) is long, plain text, and needs
      // room to wrap, not a spot meant for a one-line "Copied!" message.
      h("p", { class: "rsc-hint", "data-cdm-token-detail": "" }, ""),
      manualCommandBlock());

    const el = panelBody.querySelector(".cdm-elapsed");
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(() => {
      if (!el.isConnected) {
        clearInterval(tickHandle);
        return;
      }
      el.textContent = fmtElapsed(session.startedAt);
    }, 1000);
  }

  function renderStopped() {
    mount(panelBody,
      h("div", { class: "rsc-expired" }, `Session closed after ${fmtElapsed(session.startedAt)}.`),
      h("div", { class: "rsc-actions" }, button("Close", { small: true, onclick: () => d.close() })));
  }

  // Opens in the operator's own browser (a plain window.open -- most
  // browsers give this a new tab, not a new window, by default) rather than
  // the helper's isolated Chrome profile. See UI_PATHS's comment for the
  // cookie trade-off that decision makes.
  function openUi(flavor) {
    const chosen = flavor === "crystal" || flavor === "luna" ? flavor : session.uiFlavor;
    if (!chosen) return;
    const url = `https://127.0.0.1:${session.localPort}${UI_PATHS[chosen]}`;
    session.uiFlavor = chosen;
    session.uiUrl = url;
    window.open(url, "_blank", "noopener");
  }

  async function generateToken() {
    const statusEl = panelBody.querySelector("[data-cdm-copy-status]");
    const detailEl = panelBody.querySelector("[data-cdm-token-detail]");
    if (statusEl) {
      statusEl.textContent = "Trying automatic generation…";
      statusEl.className = "rsc-copy-status";
    }
    if (detailEl) detailEl.textContent = "";
    try {
      const body = await cdmHelper.generateToken(session.id);
      session = body.session;
      if (statusEl) {
        statusEl.textContent = `Token copied to clipboard (${body.via})`;
        statusEl.className = "rsc-copy-status ok";
      }
    } catch (err) {
      // A denial here is expected on many clusters (docs/PLAN_V8_CDM.md) --
      // the manual box below always works regardless. The full diagnostic
      // (OS user, username tried, the script's own stderr, validation HTTP
      // status -- never the token) goes in the detail paragraph, which has
      // room for it; the compact status stays a one-line summary.
      if (statusEl) {
        statusEl.textContent = "Automatic generation denied — see detail below";
        statusEl.className = "rsc-copy-status warn";
      }
      if (detailEl) detailEl.textContent = err.message || "Automatic generation was denied — use the manual box below.";
    }
  }

  async function stop() {
    if (tickHandle) clearInterval(tickHandle);
    if (pollHandle) clearTimeout(pollHandle);
    renderConnecting("Stopping…");
    try {
      session = await cdmHelper.stopSession(session.id);
    } catch (err) {
      renderError(err);
      return;
    }
    api.cdmAuditClose({ id: session.id }).catch(() => {});
    opts.onClose?.();
    renderStopped();
  }

  const STATE_LABEL = {
    starting: "Starting…",
    claiming: "Checking the tunnel and claiming access…",
    connecting: "Opening the tunnel…",
  };

  async function poll() {
    try {
      session = await cdmHelper.getSession(session.id);
    } catch (err) {
      renderError(err);
      return;
    }
    if (session.state === "open") {
      api.cdmAudit({
        id: session.id, caseNumber, clusterUuid: session.clusterUuid,
        clusterTag: session.clusterTag, localPort: session.localPort,
      }).catch(() => {});
      renderOpen();
      return;
    }
    if (session.state === "error") {
      renderError(session.error || { message: "The tunnel failed to start." });
      return;
    }
    renderConnecting(STATE_LABEL[session.state] || "Working…");
    pollHandle = setTimeout(poll, POLL_MS);
  }

  async function start(cluster) {
    renderConnecting("Starting…");
    try {
      session = await cdmHelper.startSession(caseNumber, cluster.uuid, cluster.tag, cluster.version, caseVersionRaw);
    } catch (err) {
      renderError(err);
      return;
    }
    poll();
  }

  if (clusters.length === 0) {
    renderError({ message: "No CDM cluster on this case." });
  } else if (clusters.length > 1) {
    renderPicker();
  } else {
    renderConfirm(clusters[0]);
  }
}
