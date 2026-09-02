/**
 * History-based router.
 *
 * Real URLs, not hashes: the server serves the shell for every route, so
 * /case/00123456 survives a hard refresh, back/forward work, and a filtered
 * queue like /?priority=P1&account=Evolent is a link I can paste to a
 * colleague. Filter state belongs in the query string for exactly that reason.
 */

const routes = [];
let notFound = null;
let current = null;
let onNavigate = null;

/** `pattern` is a literal path with optional `:param` segments. */
export function route(pattern, handler) {
  const names = [];
  const regex = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => {
          if (!seg.startsWith(":")) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          names.push(seg.slice(1));
          return "([^/]+)";
        })
        .join("/") +
      "/?$",
  );
  routes.push({ pattern, regex, names, handler });
}

export function setNotFound(handler) { notFound = handler; }
export function onRouteChange(fn) { onNavigate = fn; }

function match(pathname) {
  for (const r of routes) {
    const m = pathname.match(r.regex);
    if (!m) continue;
    const params = {};
    r.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

/** Current query string as a plain object — the filter state. */
export function query() {
  return Object.fromEntries(new URLSearchParams(location.search).entries());
}

/**
 * Merges into the current query string without touching the path. Passing
 * null/"" for a key removes it, so filters stay out of the URL when unset.
 */
export function setQuery(patch, { replace = true } = {}) {
  const sp = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "" || v === false) sp.delete(k);
    else sp.set(k, v === true ? "1" : String(v));
  }
  const qs = sp.toString();
  const url = location.pathname + (qs ? "?" + qs : "");
  navigate(url, { replace });
}

export function buildUrl(path, params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    sp.set(k, v === true ? "1" : String(v));
  }
  const qs = sp.toString();
  return path + (qs ? "?" + qs : "");
}

export function navigate(url, { replace = false } = {}) {
  const target = new URL(url, location.origin);
  const same = target.pathname === location.pathname && target.search === location.search;
  if (same && !replace) return;
  if (replace) history.replaceState({}, "", target);
  else history.pushState({}, "", target);
  resolve();
}

export function currentRoute() { return current; }

export function resolve() {
  const hit = match(location.pathname);
  const ctx = {
    path: location.pathname,
    params: hit ? hit.params : {},
    query: query(),
    pattern: hit ? hit.route.pattern : null,
  };
  current = ctx;
  if (onNavigate) onNavigate(ctx);
  if (hit) hit.route.handler(ctx);
  else if (notFound) notFound(ctx);
}

/**
 * Any in-app anchor is intercepted so the shell never reloads. External links,
 * new-tab clicks and modified clicks fall through to the browser.
 */
export function start() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || a.target === "_blank" || a.hasAttribute("download") || href.startsWith("http") || href.startsWith("mailto:")) return;
    e.preventDefault();
    navigate(href);
  });

  window.addEventListener("popstate", resolve);
  resolve();
}
