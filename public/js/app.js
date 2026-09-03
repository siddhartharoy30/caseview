/**
 * The shell.
 *
 * Built once at boot: sidebar, top bar, clocks, health, badges, keyboard map.
 * Only `main#main` is ever swapped by the router, so navigation never causes
 * the chrome to flicker or lose scroll position.
 */

import { $, h, icon, mount, debounce } from "./lib/dom.js";
import { api, onUnauthorized } from "./lib/api.js";
import * as store from "./lib/store.js";
import * as fmt from "./lib/fmt.js";
import { toast, toastError, dialog, emptyState } from "./lib/ui.js";
import { startNotifications } from "./lib/notify.js";
import { route, setNotFound, onRouteChange, navigate, start, resolve, currentRoute } from "./router.js";

/* ------------------------------------------------------------- navigation */

const ICONS = {
  queue:       ["M4 6h16", "M4 12h16", "M4 18h10"],
  triage:      ["circle:12,12,9", "M12 8v4l2.5 2"],
  commitments: ["M6 4h9l4 4v12H6z", "M9 12h6", "M9 16h4"],
  escalations: ["M12 4l9 16H3z", "M12 10v4", "M12 17.5v.01"],
  metrics:     ["M5 20V10", "M12 20V4", "M19 20v-7"],
  search:      ["circle:11,11,7", "M20 20l-3.5-3.5"],
  patterns:    ["circle:6,7,2.4", "circle:17,7,2.4", "circle:11.5,17,2.4", "M8.1,8.4 L10.2,14.8", "M15,8.6 L12.8,14.8"],
  settings:    ["circle:12,12,3", "M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1"],
};

const NAV = [
  { section: "Work" },
  { id: "queue",       label: "Queue",       path: "/",            key: "q", badge: "queue" },
  { id: "triage",      label: "Triage",      path: "/triage",      key: "t", badge: "triage" },
  { id: "commitments", label: "Commitments", path: "/commitments", key: "c", badge: "commitments" },
  { id: "escalations", label: "Escalations", path: "/escalations", key: "e", badge: "escalations" },
  { section: "Insight" },
  { id: "metrics",     label: "Scorecard",   path: "/metrics",     key: "m" },
  { id: "search",      label: "Search",      path: "/search",      key: "s" },
  { id: "patterns",    label: "Patterns",    path: "/patterns" },
  { section: "System" },
  { id: "settings",    label: "Settings",    path: "/settings" },
];

const PAGES = {
  queue:       () => import("./pages/queue.js"),
  caseDetail:  () => import("./pages/caseDetail.js"),
  commitments: () => import("./pages/commitments.js"),
  metrics:     () => import("./pages/metrics.js"),
  triage:      () => import("./pages/triage.js"),
  escalations: () => import("./pages/escalations.js"),
  search:      () => import("./pages/search.js"),
  patterns:    () => import("./pages/patterns.js"),
  settings:    () => import("./pages/settings.js"),
};

/* ----------------------------------------------------------------- state */

const state = {
  email: null,
  counts: { queue: 0, triage: 0, commitments: 0, commitmentsBreached: 0, escalations: 0 },
  sync: null,
  health: "warn",
  pageCleanup: null,
};

/** Pages register a keyboard handler here; the shell owns the global map. */
export const pageKeys = { handler: null };

/* ----------------------------------------------------------------- boot */

boot();

async function boot() {
  applyTheme(store.get("theme", "dark"));
  applyDensity(store.get("density", "default"));
  if (store.get("sidebarCollapsed", false)) document.body.classList.add("sidebar-collapsed");

  buildNav();
  wireTopbar();
  wireKeyboard();
  startClocks();

  // A 401 once the shell is already running is a different animal from being
  // signed out: it means the browser held a session the server would not
  // accept. Bouncing silently back to a form that then looks like it did
  // nothing is the worst possible way to report that, so say it plainly.
  onUnauthorized(() =>
    showLogin(
      state.email
        ? "Your session was rejected. Clear this site's cookies, then sign in again."
        : ""
    )
  );

  try {
    const me = await api.me();
    if (me && me.authenticated) return showApp(me.email);
  } catch {
    /* fall through to the login screen */
  }
  showLogin();
}

/* ----------------------------------------------------------------- login */

function showLogin(message) {
  state.email = null;
  $("#app").hidden = true;
  const screen = $("#loginScreen");
  screen.hidden = false;
  $("#loginEmail").focus();
  if (message) $("#loginError").textContent = message;

  const form = $("#loginForm");
  if (form.dataset.wired) return;
  form.dataset.wired = "1";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#loginError");
    const btn = $("#loginSubmit");
    err.textContent = "";
    btn.disabled = true;
    btn.textContent = "Signing in…";
    try {
      const res = await api.login($("#loginEmail").value.trim());
      showApp(res.email);
    } catch (ex) {
      err.textContent = ex.message || "Sign-in failed";
    } finally {
      btn.disabled = false;
      btn.textContent = "Sign in";
    }
  });
}

function showApp(email) {
  state.email = email;
  $("#loginScreen").hidden = true;
  $("#app").hidden = false;
  $("#whoami").textContent = email || "";

  registerRoutes();
  start();

  refreshCounts();
  refreshSync();
  setInterval(refreshCounts, 60_000);
  setInterval(refreshSync, 30_000);

  // Started unconditionally: the module itself checks the preference and the
  // browser permission on every tick, so a toggle in Settings takes effect
  // without anything here needing to know about it.
  startNotifications(navigate);
}

/* ------------------------------------------------------------------- nav */

function buildNav() {
  const nav = $("#nav");
  const nodes = NAV.map((item) => {
    if (item.section) return h("div", { class: "nav-section", text: item.section });
    return h("a", {
      class: "nav-item",
      href: item.path,
      dataset: { id: item.id, path: item.path },
      title: item.key ? `${item.label}  (g ${item.key})` : item.label,
    },
      icon(ICONS[item.id], 18),
      h("span", { class: "nav-label", text: item.label }),
      item.badge ? h("span", { class: "nav-badge", dataset: { badge: item.badge }, hidden: true }) : null);
  });
  mount(nav, nodes);

  $("#toggleSidebar").addEventListener("click", (e) => {
    e.preventDefault();
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    store.set("sidebarCollapsed", collapsed);
  });
}

function markActive(ctx) {
  const path = ctx.path;
  for (const a of document.querySelectorAll(".nav-item[data-path]")) {
    const p = a.dataset.path;
    const active = p === "/" ? path === "/" : path.startsWith(p);
    a.classList.toggle("active", active);
  }
  // A case detail page still belongs to the Queue section.
  if (path.startsWith("/case/")) {
    document.querySelector('.nav-item[data-path="/"]')?.classList.add("active");
  }
}

/* --------------------------------------------------------------- topbar */

function wireTopbar() {
  const search = $("#globalSearch");
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { search.value = ""; search.blur(); }
    if (e.key === "Enter") {
      const q = search.value.trim();
      if (q) navigate("/search?q=" + encodeURIComponent(q));
    }
  });

  $("#refreshBtn").addEventListener("click", () => manualSync());
  $("#themeBtn").addEventListener("click", () => {
    const next = document.body.classList.contains("light") ? "dark" : "light";
    applyTheme(next);
    store.set("theme", next);
    // localStorage is what applyTheme reads; the server copy exists only so
    // Settings can show a stored value that matches what is on screen.
    api.saveSettings({ theme: next }).catch(() => {});
  });
  $("#helpBtn").addEventListener("click", showShortcuts);
  $("#riskBadge").addEventListener("click", () => navigate("/commitments?state=at-risk"));
}

function applyTheme(theme) {
  document.body.classList.toggle("light", theme === "light");
  document.body.classList.toggle("dark", theme !== "light");
}

export function applyDensity(density) {
  document.body.classList.remove("compact", "roomy");
  if (density === "compact" || density === "roomy") document.body.classList.add(density);
}

function startClocks() {
  const est = $("#clockEst");
  const utc = $("#clockUtc");
  const tick = () => {
    const now = new Date();
    est.textContent = fmt.clockEastern(now) + " ET";
    utc.textContent = fmt.clockUtc(now) + " UTC";
  };
  tick();
  setInterval(tick, 1000);
}

/* --------------------------------------------------- counts, sync, health */

async function refreshCounts() {
  try {
    const c = await api.counts();
    state.counts = c;
    paintBadges();
  } catch {
    /* badge staleness is not worth a toast; the sync chip already tells the story */
  }
}

function paintBadges() {
  const c = state.counts;
  const set = (name, value, cls) => {
    const el = document.querySelector(`.nav-badge[data-badge="${name}"]`);
    if (!el) return;
    el.hidden = !value;
    el.textContent = value > 99 ? "99+" : String(value || "");
    el.classList.toggle("is-hot", cls === "hot");
    el.classList.toggle("is-warn", cls === "warn");
  };

  // Anything past its deadline counts as blown, whether or not the reconciler
  // has relabelled it 'breached' yet.
  const breached = (c.commitmentsBreached || 0) + (c.overdue || 0);
  const atRisk = c.commitmentsAtRisk || 0;
  const needsAttention = breached + atRisk;

  set("queue", c.queue);
  set("triage", c.triage, c.triage ? "warn" : "");
  // Red the moment anything has actually breached, amber while merely at risk.
  set("commitments", needsAttention, breached ? "hot" : atRisk ? "warn" : "");
  set("escalations", c.escalations, c.escalations ? "hot" : "");

  const badge = $("#riskBadge");
  const text = $("#riskBadgeText");
  badge.classList.toggle("show", needsAttention > 0);
  badge.classList.toggle("breached", breached > 0);
  const parts = [];
  if (breached) parts.push(`${breached} breached`);
  if (atRisk) parts.push(`${atRisk} at risk`);
  text.textContent = parts.join(" · ");
  badge.title = needsAttention
    ? "Commitments needing attention — click to open the Commitments page"
    : "";
}

async function refreshSync() {
  try {
    const s = await api.syncStatus();
    state.sync = s;
    paintSync();
  } catch {
    setHealth("error");
    $("#syncText").textContent = "server unreachable";
  }
}

function paintSync() {
  const s = state.sync;
  if (!s) return;
  const chipText = $("#syncText");
  const running = !!s.running;

  $("#refreshBtn").classList.toggle("spinning", running);
  $("#healthDot").classList.toggle("busy", running);

  // The route speaks camelCase and hands back epoch milliseconds, not an ISO
  // string. Reading the snake_case names left this permanently on "never
  // synced" with an amber dot, which is worse than no indicator at all: it
  // reported a problem that did not exist and would have hidden a real one.
  const lastSuccess = s.lastSuccess;
  const errorCount = Number(s.errorCount || 0);

  if (!lastSuccess) {
    setHealth("warn");
    chipText.textContent = running ? "first sync running…" : "never synced";
    return;
  }

  const ageMin = (Date.now() - lastSuccess) / 60000;
  const interval = Number(s.intervalMinutes || 5);
  chipText.textContent = `synced ${fmt.relative(lastSuccess)} · ${fmt.dateTimeShort(lastSuccess)}`;

  // Amber once we have missed a cycle, red once errors are stacking up. The
  // sync only runs inside the active window, so an overnight gap is expected
  // rather than a fault — three intervals of slack absorbs a skipped cycle
  // without absorbing a night, which is what the window check below handles.
  if (errorCount > 3) setHealth("error");
  else if (errorCount > 0) setHealth("warn");
  else if (ageMin > interval * 3 && withinActiveWindow()) setHealth("warn");
  else setHealth("ok");
}

/**
 * Whether a sync is due right now. Outside the configured window nothing is
 * scheduled, so a five-hour-old sync at 3am is the system working correctly,
 * and colouring it amber would train me to ignore the dot.
 */
function withinActiveWindow() {
  const s = state.sync;
  if (!s || s.activeWindowStart == null) return true; // unknown: do not excuse staleness
  const now = new Date();
  const hour = Number(fmt.clockEastern(now).slice(0, 2));
  const start = Number(s.activeWindowStart);
  const end = Number(s.activeWindowEnd);
  if (Number.isFinite(hour) && (hour < start || hour >= end)) return false;
  if (s.activeWindowWeekdaysOnly) {
    // getDay() is local, but no timezone puts a weekday on a different side of
    // the weekend from Eastern by more than the window's own edges.
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
  }
  return true;
}

function setHealth(level) {
  state.health = level;
  const dot = $("#healthDot");
  dot.classList.remove("ok", "warn", "error");
  dot.classList.add(level);
  dot.title = level === "ok" ? "Salesforce sync healthy"
    : level === "warn" ? "Sync is behind — showing last known data"
    : "Sync failing — data may be stale";
}

async function manualSync(full = false) {
  $("#refreshBtn").classList.add("spinning");
  try {
    await api.sync(full);
    toast(full ? "Full resync started" : "Sync started");
    setTimeout(refreshSync, 1200);
    setTimeout(() => { refreshSync(); refreshCounts(); rerender(); }, 6000);
  } catch (e) {
    toastError(e);
    $("#refreshBtn").classList.remove("spinning");
  }
}

/* ---------------------------------------------------------------- routes */

function registerRoutes() {
  const page = (loader) => async (ctx) => {
    const host = $("#main");
    host.scrollTop = 0;
    if (typeof state.pageCleanup === "function") { try { state.pageCleanup(); } catch { /* noop */ } }
    state.pageCleanup = null;
    pageKeys.handler = null;
    try {
      const mod = await loader();
      const cleanup = await mod.render(ctx, host, shell);
      state.pageCleanup = typeof cleanup === "function" ? cleanup : null;
    } catch (e) {
      mount(host, emptyState({
        title: "This page failed to load",
        message: e?.message || String(e),
        iconName: "alert",
        action: h("button", { class: "btn", onclick: () => resolve() }, "Try again"),
      }));
    }
  };

  route("/", page(PAGES.queue));
  route("/case/:caseNumber", page(PAGES.caseDetail));
  route("/commitments", page(PAGES.commitments));
  route("/metrics", page(PAGES.metrics));
  route("/triage", page(PAGES.triage));
  route("/escalations", page(PAGES.escalations));
  route("/search", page(PAGES.search));
  route("/patterns", page(PAGES.patterns));
  route("/settings", page(PAGES.settings));

  setNotFound((ctx) => {
    mount($("#main"), emptyState({
      title: "No such page",
      message: `${ctx.path} is not a QView route.`,
      iconName: "search",
      action: h("a", { class: "btn primary", href: "/" }, "Back to the queue"),
    }));
  });

  onRouteChange((ctx) => {
    markActive(ctx);
    document.title = titleFor(ctx);
  });
}

function titleFor(ctx) {
  if (ctx.path.startsWith("/case/")) return `${ctx.params.caseNumber} · QView`;
  const hit = NAV.find((n) => n.path && n.path === ctx.path);
  return hit ? `${hit.label} · QView` : "QView";
}

function rerender() { resolve(); }

/* --------------------------------------------------- shell API for pages */

export const shell = {
  get email() { return state.email; },
  get counts() { return state.counts; },
  get sync() { return state.sync; },
  refreshCounts,
  refreshSync,
  manualSync,
  rerender,
  navigate,
  setPageKeys: (fn) => { pageKeys.handler = fn; },
  applyDensity,
};

/* -------------------------------------------------------------- keyboard */

const GOTO = { q: "/", c: "/commitments", m: "/metrics", t: "/triage", e: "/escalations", s: "/search", p: "/patterns", g: "/settings" };

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function wireKeyboard() {
  let awaitingGoto = false;
  let gotoTimer = null;

  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (awaitingGoto) {
      clearTimeout(gotoTimer);
      awaitingGoto = false;
      const dest = GOTO[e.key.toLowerCase()];
      if (dest) { e.preventDefault(); navigate(dest); return; }
    }

    if (isTyping(e)) return;

    switch (e.key) {
      case "/":
        e.preventDefault();
        $("#globalSearch").focus();
        $("#globalSearch").select();
        return;
      case "g":
        e.preventDefault();
        awaitingGoto = true;
        gotoTimer = setTimeout(() => { awaitingGoto = false; }, 900);
        return;
      case "r":
        e.preventDefault();
        manualSync();
        return;
      case "?":
        e.preventDefault();
        showShortcuts();
        return;
      case "\\":
        e.preventDefault();
        $("#toggleSidebar").click();
        return;
    }

    // Everything else belongs to the page: j/k/Enter and friends.
    if (typeof pageKeys.handler === "function") pageKeys.handler(e);
  });
}

const SHORTCUTS = [
  ["Navigate", [
    ["g then q", "Queue"],
    ["g then t", "Triage"],
    ["g then c", "Commitments"],
    ["g then e", "Escalations"],
    ["g then m", "Scorecard"],
    ["g then s", "Search"],
    ["g then p", "Patterns"],
    ["g then g", "Settings"],
  ]],
  ["Global", [
    ["/", "Focus search"],
    ["r", "Sync now"],
    ["\\", "Collapse / expand sidebar"],
    ["?", "This sheet"],
  ]],
  ["Lists", [
    ["j / k", "Move down / up"],
    ["Enter", "Open the highlighted case"],
    [".", "Row actions"],
    ["Esc", "Clear selection or close"],
  ]],
];

function showShortcuts() {
  dialog({
    title: "Keyboard shortcuts",
    width: "560px",
    body: h("div", {},
      SHORTCUTS.map(([group, rows]) =>
        h("div", { style: { marginBottom: "18px" } },
          h("div", { class: "nav-section", style: { padding: "0 0 8px" }, text: group }),
          h("div", { class: "keys-grid" },
            rows.map(([keys, label]) =>
              h("div", { class: "key-row" },
                h("span", {}, keys.split(" then ").map((k, i, arr) =>
                  h("span", {}, h("kbd", { text: k }), i < arr.length - 1 ? " then " : "")),
                ),
                h("span", { text: label }))))))),
  });
}
