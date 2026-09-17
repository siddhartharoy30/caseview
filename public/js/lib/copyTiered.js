/**
 * Three-tier clipboard copy, never a silent failure (docs/PLAN_V8.md's Phase
 * 3). Lifted out of lib/rsc.js (where it was module-private) so lib/cdm.js
 * can reuse it too, each passing its own helper's `pbcopy` and its own DOM
 * hooks.
 *
 * Does NOT reuse lib/dom.js's copy()/ui.js's copyToast() -- that helper's
 * clipboard-API-then-execCommand fallback would mask exactly the tier
 * boundary this needs to report distinctly (a real Clipboard API rejection
 * has to visibly fall through to the Mac-side pbcopy tier, not be silently
 * absorbed by a same-tab execCommand fallback that usually still "succeeds").
 */

import { toast } from "./ui.js";

/**
 * @param {string} text
 * @param {{statusEl: Element, detailsEl: Element, inputEl: Element, pbcopy: (text: string) => Promise<boolean>, prefix?: string}} opts
 *   `prefix` names what was copied ("Token", "Command") in the status text;
 *   defaults to "Token" to match the original RSC-only behaviour.
 */
export async function copyTiered(text, { statusEl, detailsEl, inputEl, pbcopy, prefix = "Token" }) {
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = `${prefix} copied to clipboard`;
    statusEl.className = "rsc-copy-status ok";
    return;
  } catch { /* fall through */ }

  if (await pbcopy(text)) {
    statusEl.textContent = `${prefix} copied to clipboard (via helper)`;
    statusEl.className = "rsc-copy-status ok";
    return;
  }

  statusEl.textContent = `Automatic copy failed — ${prefix.toLowerCase()} is shown below, selected for you.`;
  statusEl.className = "rsc-copy-status warn";
  if (detailsEl) detailsEl.open = true;
  if (inputEl) {
    inputEl.focus();
    inputEl.select();
  }
  toast("Automatic copy did not work — paste from the field below.", "warn", { sticky: true });
}
