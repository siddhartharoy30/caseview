/**
 * Bits every page needs: the standard page header, the headline tile, and a
 * placeholder used by pages whose feature phase has not landed yet. The
 * placeholder is deliberately honest — it states what is missing rather than
 * showing invented data.
 */

import { h, mount } from "../lib/dom.js";
import { emptyState } from "../lib/ui.js";

export function pageHead(title, subtitle, actions) {
  return h("div", { class: "page-head" },
    h("div", {},
      h("h1", { class: "page-title", text: title }),
      subtitle ? h("div", { class: "page-sub", text: subtitle }) : null),
    actions ? h("div", { class: "page-actions" }, actions) : null);
}

export function page(...children) {
  return h("div", { class: "page" }, children);
}

/**
 * One headline number.
 *
 * The href is what separates a tile from a label: a tile that links
 * reproduces exactly the population it counted, and one that does not is a
 * number the reader has to take on faith. Omit the href only when the Queue
 * genuinely cannot express that population, and say so in the sub line.
 */
export function tile({ label, value, sub, href, tone = "", hint }) {
  const inner = [
    h("div", { class: "tile-label" }, label, hint ? h("span", { class: "tile-hint", title: hint }, "?") : null),
    h("div", { class: "tile-value " + tone }, value),
    sub ? h("div", { class: "tile-sub" }, sub) : null,
  ];
  return href
    ? h("a", { class: "tile link", href }, inner)
    : h("div", { class: "tile" }, inner);
}

export function notBuiltYet(host, title, message) {
  mount(host, page(
    pageHead(title),
    emptyState({ title: title + " is not built yet", message, iconName: "clock" }),
  ));
}
