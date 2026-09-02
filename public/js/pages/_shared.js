/**
 * Bits every page needs: the standard page header, and a placeholder used by
 * pages whose feature phase has not landed yet. The placeholder is deliberately
 * honest — it states what is missing rather than showing invented data.
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

export function notBuiltYet(host, title, message) {
  mount(host, page(
    pageHead(title),
    emptyState({ title: title + " is not built yet", message, iconName: "clock" }),
  ));
}
