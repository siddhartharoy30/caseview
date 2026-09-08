/**
 * Amazon Connect launcher -- v5 phase 5.
 *
 * A button that gets into the CCP softphone without walking the Okta
 * dashboard by hand. Three tiers: the CCP URL directly (works when the SSO
 * session is live), the Okta app deep link (always initiates SSO, but its
 * trailing link-index can drift if an admin reorders the app catalogue),
 * and the Okta dashboard (always works, one extra click) -- settings, not
 * constants, since a catalogue reorder shouldn't need a code change.
 *
 * QView cannot see anything about the CCP window once it opens -- it's
 * cross-origin, so there is no session-status API to read and no `resize`
 * listener to attach (unlike the Document PiP window in phonePip.js, which
 * *is* same-origin). The one honest signal available is second-hand: the
 * phone board's own status for me. `connectButton()` surfaces that as a
 * hint, never as a claim about the Connect session itself.
 */

import { h } from "./dom.js";
import { api } from "./api.js";

let ccpWindowRef = null;

export async function openConnect() {
  if (ccpWindowRef && !ccpWindowRef.closed) { ccpWindowRef.focus(); return; }
  const res = await api.settings().catch(() => null);
  const url = (res && res.settings && res.settings.ccpUrl) || "";
  if (!url) return;
  // The CCP softphone is a small fixed-shape window; 400x600 matches it.
  // Cross-origin, so (unlike the PiP window) there is no way to read back
  // and persist whatever size the user leaves it at.
  ccpWindowRef = window.open(url, "qview-ccp", "width=400,height=600");
}

export async function openOktaApp() {
  const res = await api.settings().catch(() => null);
  const url = (res && res.settings && res.settings.oktaAppUrl) || "";
  if (url) window.open(url, "_blank", "noopener");
}

export async function openOktaDashboard() {
  const res = await api.settings().catch(() => null);
  const url = (res && res.settings && res.settings.oktaDashboardUrl) || "";
  if (url) window.open(url, "_blank", "noopener");
}

/** One implementation, shared verbatim by the phone page, the docked panel
 * and the Document PiP pop-out. `state` is a phoneMonitor state object. */
export function connectButton(state) {
  const board = state.board;
  const mine = board && board.ok ? board.agents.find((a) => a.name === state.myName) : null;

  return h("div", { class: "phn-connect" },
    h("button", { class: "btn primary sm", type: "button", onclick: () => openConnect() }, "Open Amazon Connect"),
    mine && mine.statusClass === "offline"
      ? h("span", { class: "dim", text: "  Board shows you offline" })
      : null,
    h("div", { class: "phn-connect-fallback" },
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); openOktaApp(); }, text: "Sign in through Okta" }),
      h("span", { class: "dim", text: "  ·  " }),
      h("a", { href: "#", onclick: (e) => { e.preventDefault(); openOktaDashboard(); }, text: "Okta dashboard" })));
}
