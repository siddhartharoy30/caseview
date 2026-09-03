/**
 * Customer-authored text, made safe to display.
 *
 * Everything in this file exists because comment bodies come out of Salesforce
 * as HTML that a customer typed. None of it goes near innerHTML: HTML is
 * flattened to plain text, and plain text is turned into real DOM text nodes.
 * That is the whole contract, and it is why these helpers live in one place
 * rather than being copied into each page that renders a comment.
 *
 * Extracted from the case detail page in phase 4 so the Commitments page — and
 * Search after it — sanitize identically rather than nearly identically.
 */

import { h } from "./dom.js";

/* -------------------------------------------------- HTML body → plain text */

/**
 * Only these names count as markup.
 *
 * That distinction matters: real comment bodies contain angle-bracketed URLs
 * and addresses — <https://support.rubrik.com/...> and <support@rubrik.com> —
 * and a blanket /<[^>]*>/ strip eats them, quietly deleting the exact link the
 * customer sent. The \b after the alternation is what stops <support@...> from
 * matching the "sup" in this list.
 */
const TAG_NAMES = [
  "a", "b", "blockquote", "body", "br", "caption", "center", "code", "col",
  "colgroup", "dd", "div", "dl", "dt", "em", "font", "h[1-6]", "head", "hr",
  "html", "i", "img", "label", "li", "meta", "ol", "p", "pre", "s", "small",
  "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "title", "tr", "u", "ul", "o:p", "v:\\w+", "w:\\w+",
].join("|");

const TAG_RE = new RegExp(`<\\s*/?\\s*(?:${TAG_NAMES})\\b[^>]*>`, "gi");

const ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", bull: "\u2022",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0",
  middot: "\u00b7", laquo: "\u00ab", raquo: "\u00bb",
};

export function decodeEntities(input) {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/** Salesforce HTML in, readable plain text out. Never parsed into the DOM. */
export function htmlToText(input) {
  if (!input) return "";
  let s = String(input).replace(/\r\n?/g, "\n");
  s = s.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\s*hr\s*\/?\s*>/gi, "\n\u2014\u2014\u2014\n");
  s = s.replace(/<\s*li\b[^>]*>/gi, "\n\u2022 ");
  s = s.replace(/<\s*\/\s*(?:p|div|tr|li|ul|ol|table|h[1-6]|blockquote|pre|dd|dt)\s*>/gi, "\n");
  s = s.replace(TAG_RE, "");
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, " ");
  s = s.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Email replies carry the whole prior thread underneath them. Splitting at the
 * quote marker keeps the new content open while the history stays one click
 * away — which is not the same as truncating it, because the control below says
 * exactly how much is down there.
 */
const QUOTE_RE = /^[ \t>]*(?:On\s.{4,160}\bwrote:\s*$|-{2,}\s*Original Message\s*-*\s*$|_{5,}\s*$|-{3,}\s*Forwarded message\s*-*\s*$|From:\s*\S)/i;

export function splitQuoted(text) {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (!QUOTE_RE.test(lines[i])) continue;
    const head = lines.slice(0, i).join("\n").trimEnd();
    const tail = lines.slice(i).join("\n").trim();
    if (head.length >= 40 && tail.length > 0) return { body: head, quoted: tail };
    return { body: text, quoted: "" };
  }
  return { body: text, quoted: "" };
}

/* ------------------------------------------------------- text → safe nodes */

const URL_RE = /\bhttps?:\/\/[^\s<>()[\]"']+/gi;

export function highlightInto(target, text, needle) {
  if (!needle) { target.append(document.createTextNode(text)); return; }
  const hay = text.toLowerCase();
  const find = needle.toLowerCase();
  let at = 0;
  for (;;) {
    const idx = hay.indexOf(find, at);
    if (idx === -1) break;
    if (idx > at) target.append(document.createTextNode(text.slice(at, idx)));
    target.append(h("mark", { text: text.slice(idx, idx + find.length) }));
    at = idx + find.length;
  }
  if (at < text.length) target.append(document.createTextNode(text.slice(at)));
}

/**
 * Text in, nodes out. URLs become real anchors so a KB link inside a comment is
 * one click away rather than something to select and paste, and the search term
 * is marked wherever it lands.
 */
export function textNodes(text, needle, className = "tl-text") {
  const out = h("div", { class: className });
  let at = 0;
  URL_RE.lastIndex = 0;
  for (let m; (m = URL_RE.exec(text)); ) {
    if (m.index > at) highlightInto(out, text.slice(at, m.index), needle);
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    const a = h("a", { class: "tl-link", href: url, target: "_blank", rel: "noopener noreferrer" });
    highlightInto(a, url, needle);
    out.append(a);
    at = m.index + url.length;
    URL_RE.lastIndex = at;
  }
  if (at < text.length) highlightInto(out, text.slice(at), needle);
  return out;
}

/**
 * A one-line preview of a longer body, for a list row.
 *
 * Collapses the newlines a commitment sentence often carries so it sits on one
 * line, and cuts on a word boundary rather than mid-word.
 */
export function oneLine(text, max = 160) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + "\u2026";
}
