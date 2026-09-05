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

export function navigate(url, { replace = false, force = false } = {}) {
  const target = new URL(url, location.origin);
  const same = target.pathname === location.pathname && target.search === location.search;
  if (same && !force) return;
  if (replace) history.replaceState({}, "", target);
  else history.pushState({}, "", target);
  resolve();
}

export function currentRoute() { return current; }

// Re-entrancy guard: a handler that itself triggers a navigation (directly or
// via a query-only update) could in principle spin forever. Past a shallow
// depth, stop recursing and log loudly instead of exhausting the socket pool
// the way the pre-fix search page did.
let resolveDepth = 0;
const recentUrls = [];

export function resolve() {
  const url = location.pathname + location.search;
  recentUrls.push(url);
  if (recentUrls.length > 3) recentUrls.shift();

  resolveDepth++;
  if (resolveDepth > 2) {
    console.error("[router] resolve() re-entrancy depth exceeded — stopping", {
      pattern: current?.pattern,
      recentUrls: [...recentUrls],
    });
    resolveDepth--;
    return;
  }

  try {
    const hit = match(location.pathname);
    const prev = current;
    const ctx = {
      path: location.pathname,
      params: hit ? hit.params : {},
      query: query(),
      pattern: hit ? hit.route.pattern : null,
    };

    // A query-only change (same pattern, same params) never remounts the
    // page — that is what search.js typing into the box or a Queue filter
    // dropdown would otherwise do on every keystroke/click. The page's own
    // onQueryChange hook is given the chance to react (a page that already
    // repaints itself from its own event handlers, like commitments.js or
    // triage.js, needs none). Route handlers are only re-invoked when the
    // pattern or params actually changed — a real navigation.
    const sameRoute = prev && prev.pattern === ctx.pattern &&
      JSON.stringify(prev.params) === JSON.stringify(ctx.params);
    const queryOnly = sameRoute && JSON.stringify(prev.query) !== JSON.stringify(ctx.query);

    current = ctx;
    if (onNavigate) onNavigate(ctx);

    if (queryOnly) {
      if (onQueryOnly) onQueryOnly(ctx);
    } else if (hit) {
      hit.route.handler(ctx);
    } else if (notFound) {
      notFound(ctx);
    }
  } finally {
    resolveDepth--;
  }
}

let onQueryOnly = null;

/**
 * Registers a hook consulted on every query-only URL change (same route
 * pattern and params, different query string). Remounting never happens for
 * this case regardless of whether a hook is registered — a page whose own
 * event handlers already repaint themselves (commitments.js, triage.js,
 * patterns.js, caseDetail.js) needs no hook at all. Pages whose filter/sort
 * paths depend on being told about the change (queue.js, search.js — the
 * latter also for browser back/forward through its own search history)
 * register one to react in place.
 */
export function onQueryChange(fn) { onQueryOnly = fn; }

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
