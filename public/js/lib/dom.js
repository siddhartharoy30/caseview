/**
 * Tiny DOM helpers.
 *
 * No framework: `h()` builds elements, `html` interpolates escaped strings, and
 * everything else is plain DOM. Anything that touches case data goes through
 * `esc()` — customer text lands in this UI verbatim and must never be parsed
 * as markup.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template that escapes every interpolation. Arrays are joined. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out += (Array.isArray(v) ? v.join("") : v === null || v === undefined ? "" : String(v)) + strings[i + 1];
  }
  return out;
}

/** Marks a pre-built HTML string as safe to embed inside html``. */
export const raw = (s) => s;

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "html") el.innerHTML = value;
    else if (key === "text") el.textContent = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Replaces a container's children in one shot. */
export function mount(container, ...nodes) {
  container.replaceChildren(...nodes.flat(Infinity).filter(Boolean));
  return container;
}

export function frag(nodes) {
  const f = document.createDocumentFragment();
  for (const n of nodes) if (n) f.append(n);
  return f;
}

/** Event delegation: one listener on the container, matched by selector. */
export function on(root, event, selector, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}

export function debounce(fn, ms = 220) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Inline icon from a path spec. Kept as data so pages never paste raw SVG. */
export function icon(paths, size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of [].concat(paths)) {
    const node = document.createElementNS(SVG_NS, d.startsWith("circle:") ? "circle" : "path");
    if (d.startsWith("circle:")) {
      const [cx, cy, r] = d.slice(7).split(",");
      node.setAttribute("cx", cx);
      node.setAttribute("cy", cy);
      node.setAttribute("r", r);
    } else {
      node.setAttribute("d", d);
    }
    svg.append(node);
  }
  return svg;
}

export async function copy(text, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    return label;
  } catch {
    // Clipboard API needs a secure context; this box is plain HTTP internally.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return label;
  }
}
