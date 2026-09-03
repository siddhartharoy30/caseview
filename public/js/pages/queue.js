/**
 * Queue — every case I own, in one dense table.
 *
 * Data model note: there are only a couple of hundred cases in the cache and
 * rarely more than twenty open at once, so this page fetches one scope from the
 * server and then does all sorting, grouping, filtering and state derivation in
 * the browser. That keeps interactions instant. The server-side scope filter is
 * still used so a URL stays shareable and reproduces the same view cold.
 *
 * Nothing here writes case content to localStorage — only column layout, saved
 * views and thresholds, which are preferences, not customer data.
 */

import { $, $$, h, mount, on, icon, copy } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as store from "../lib/store.js";
import * as fmt from "../lib/fmt.js";
import {
  toast, toastError, dialog, confirmDialog,
  skeletonRows, emptyState, banner, button,
} from "../lib/ui.js";
import { pageHead, page } from "./_shared.js";
import { navigate, setQuery } from "../router.js";

/* ------------------------------------------------------------------ config */

const KEY_COLS  = "queue.columns";
const KEY_VIEWS = "queue.views";
const KEY_STALE = "queue.staleDays";
const KEY_ORDER = "queue.order";

const DEFAULT_STALE_DAYS = 5;

const ICON_COLS = ["M4 4h16v6H4z", "M4 14h10v6H4z"];
const ICON_COPY = ["M9 9h10v10H9z", "M5 15V5h10"];

/**
 * The eleven columns from the spec. Order here is the factory default; the
 * user's own order and visibility live in localStorage.
 *
 *   sortVal — comparable value; null/"" always sorts last, in both directions
 *   cell    — DOM for the table cell
 *   csv     — flat text for export
 */
const COLUMNS = [
  {
    id: "priority", label: "Pri", defaultOn: true,
    sortVal: (c) => prioRank(c.priority),
    csv: (c) => c.priority || "",
    cell: (c) => h("span", { class: `chip ${fmt.priorityClass(c.priority)}`, text: c.priority || "—" }),
  },
  {
    id: "caseNumber", label: "Case #", defaultOn: true, locked: true,
    sortVal: (c) => c.caseNumber || "",
    csv: (c) => c.caseNumber || "",
    cell: (c) => h("span", { class: "cell-num" },
      h("a", { class: "mono", href: `/case/${encodeURIComponent(c.caseNumber)}`, text: c.caseNumber }),
      h("button", {
        class: "copybtn", title: "Copy case number", "aria-label": "Copy case number",
        dataset: { copy: c.caseNumber },
      }, icon(ICON_COPY, 13)),
    ),
  },
  {
    id: "account", label: "Account", defaultOn: true,
    sortVal: (c) => (c.account || "").toLowerCase(),
    csv: (c) => c.account || "",
    cell: (c) => h("span", { class: "nowrap", title: c.account || "", text: c.account || "—" }),
  },
  {
    id: "contact", label: "Contact", defaultOn: false,
    sortVal: (c) => (c.contactName || "").toLowerCase(),
    csv: (c) => c.contactName || "",
    cell: (c) => h("span", { class: "nowrap", text: c.contactName || "—" }),
  },
  {
    id: "subject", label: "Subject", defaultOn: true,
    sortVal: (c) => (c.subject || "").toLowerCase(),
    csv: (c) => c.subject || "",
    cell: (c) => {
      const wrap = h("span", { class: "cell-subject", title: c.subject || "" });
      if (c.needsMyReply) wrap.append(h("span", { class: "reply-flag", text: "REPLY" }));
      wrap.append(h("span", { text: c.subject || "(no subject)" }));
      return wrap;
    },
  },
  {
    id: "status", label: "Status", defaultOn: true,
    sortVal: (c) => (c.status || "").toLowerCase(),
    csv: (c) => c.status || "",
    cell: (c) => h("span", { class: "nowrap", text: c.status || "—" }),
  },
  {
    id: "age", label: "Age", defaultOn: true,
    // negated so that "ascending" reads as "oldest first", which is what you want
    sortVal: (c) => (c.createdDate ? -Date.parse(c.createdDate) : null),
    csv: (c) => (c.createdDate ? `${fmt.ageDays(c.createdDate).days}d` : ""),
    cell: (c) => {
      if (!c.createdDate) return h("span", { class: "dim", text: "—" });
      const a = fmt.ageDays(c.createdDate);
      const cls = a.band === "red" ? "age-red" : a.band === "amber" ? "age-amber" : "";
      return h("span", { class: `mono ${cls}`, title: `Opened ${fmt.dateTime(c.createdDate)}`, text: `${a.days}d` });
    },
  },
  {
    id: "lastCustomerTouch", label: "Cust. touch", defaultOn: true,
    sortVal: (c) => (c.lastCustomerTouch ? -Date.parse(c.lastCustomerTouch) : null),
    csv: (c) => (c.lastCustomerTouch ? fmt.dateTime(c.lastCustomerTouch) : ""),
    cell: (c) => {
      if (!c.lastCustomerTouch) return h("span", { class: "dim", text: "—" });
      return h("span", {
        class: `nowrap ${c.needsMyReply ? "age-red" : ""}`,
        title: fmt.dateTime(c.lastCustomerTouch)
          + (c.needsMyReply ? " — customer replied and I have not answered" : ""),
        text: fmt.relative(c.lastCustomerTouch),
      });
    },
  },
  {
    id: "lastMyTouch", label: "My touch", defaultOn: true,
    sortVal: (c) => (c.lastMyTouch ? -Date.parse(c.lastMyTouch) : null),
    csv: (c) => (c.lastMyTouch ? fmt.dateTime(c.lastMyTouch) : ""),
    cell: (c) => c.lastMyTouch
      ? h("span", { class: "nowrap", title: fmt.dateTime(c.lastMyTouch), text: fmt.relative(c.lastMyTouch) })
      : h("span", { class: "dim", text: "never" }),
  },
  {
    id: "commitment", label: "Next commitment", defaultOn: true,
    sortVal: (c) => c._due,
    csv: (c) => (c._due ? fmt.dateTime(c._due) : ""),
    cell: (c) => {
      if (!c._due) return h("span", { class: "dim", text: "—" });
      return h("span", { class: "due-cell" },
        h("span", {
          class: `cd ${dueTone(c._due)}`, dataset: { due: String(c._due) },
          text: fmt.countdown(c._due),
        }),
        h("span", { class: "abs", text: fmt.dateTimeShort(c._due) }),
      );
    },
  },
  {
    id: "productArea", label: "Product area", defaultOn: false,
    sortVal: (c) => (c.productArea || "").toLowerCase(),
    csv: (c) => c.productArea || "",
    cell: (c) => h("span", { class: "nowrap", text: c.productArea || "—" }),
  },
];

const COL_BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));

/** Saved views that ship with the app. `flag` filters on a derived row state. */
const BUILTIN_VIEWS = [
  { id: "reply",   label: "Needs Reply",         params: { status: "open", flag: "reply" },     hint: "Customer replied and I have not answered" },
  { id: "p1",      label: "P1 Only",             params: { status: "open", priority: "P0,P1" }, hint: "P1 and P0 — a P0 is never hidden behind this pill" },
  { id: "due",     label: "Due Today",           params: { status: "open", flag: "due" },       hint: "Commitment deadline falls today" },
  { id: "stale",   label: "Stale",               params: { status: "open", flag: "stale" },     hint: "No touch from me recently" },
  { id: "waiting", label: "Waiting on Customer", params: { status: "open", flag: "waiting" },   hint: "Ball is in their court" },
  { id: "open",    label: "All Open",            params: { status: "open" },                    hint: "Every case I own that is not closed" },
  { id: "closed",  label: "Recently Closed",     params: { status: "closed", sort: "age:asc" }, hint: "Closed cases, newest first" },
];

const GROUPS = [
  { value: "account",     label: "Account" },
  { value: "priority",    label: "Priority" },
  { value: "productArea", label: "Product area" },
  { value: "status",      label: "Status" },
];

const STATE_LABEL = {
  reply:     "Needs my reply",
  breached:  "Commitment breached",
  due:       "Commitment due today",
  stale:     "Stale",
  waiting:   "Waiting on customer",
  escalated: "Escalated",
};
const STATE_RANK = { reply: 0, breached: 1, due: 2, stale: 3, waiting: 4, "": 5 };

/**
 * Drill-through parameters.
 *
 * The Scorecard's promise is that every number on it can be clicked into and
 * checked. That only holds if the Queue can express the same population the
 * number was counted over, and the toolbar filters cannot: they have no notion
 * of a date window, of an explicit set of cases, or of an exact status string.
 * These four fill that gap. They are deliberately not in the toolbar — they
 * arrive by link, from a tile, and the only affordance they need is a chip
 * saying what is being shown and a way to drop it.
 *
 *   cases=01302660,01303334      exactly these case numbers
 *   opened=<iso>..<iso>          created inside the window; either end may be blank
 *   closed=<iso>..<iso>          closed inside the window
 *   caseStatus=Waiting for ...   exact status string, not a substring match
 *
 * Windows are half-open — from inclusive, to exclusive — which is what the
 * server's own range maths does, so a case never lands in two adjacent buckets.
 */
const DRILL_KEYS = ["cases", "opened", "closed", "caseStatus"];

function parseCaseSet(spec) {
  const ids = String(spec || "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function parseRange(spec) {
  const raw = String(spec || "");
  if (!raw.includes("..")) return null;
  const [a, b] = raw.split("..");
  const from = a ? Date.parse(a) : NaN;
  const to   = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(from) && !Number.isFinite(to)) return null;
  return { from: Number.isFinite(from) ? from : null, to: Number.isFinite(to) ? to : null };
}

function inRange(value, range) {
  if (!value) return false;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return false;
  if (range.from !== null && t < range.from) return false;
  if (range.to !== null && t >= range.to) return false;
  return true;
}

function rangeLabel(range) {
  const d = (ms) => fmt.dateShort(new Date(ms).toISOString());
  if (range.from === null) return `before ${d(range.to)}`;
  if (range.to === null) return `after ${d(range.from)}`;
  return `${d(range.from)} – ${d(range.to - 1)}`;
}

/* ----------------------------------------------------------------- helpers */

function prioRank(p) {
  const m = /^P(\d)/i.exec(p || "");
  return m ? Number(m[1]) : 9;
}

function dueTone(due, now = Date.now()) {
  if (due < now) return "red";
  if (due - now <= 4 * 3600 * 1000) return "amber";
  return "";
}

function columnLayout() {
  const saved = store.get(KEY_COLS, null);
  const order = Array.isArray(saved?.order) ? saved.order.filter((id) => COL_BY_ID.has(id)) : [];
  for (const c of COLUMNS) if (!order.includes(c.id)) order.push(c.id);
  const hidden = new Set(Array.isArray(saved?.hidden)
    ? saved.hidden.filter((id) => COL_BY_ID.has(id))
    : COLUMNS.filter((c) => !c.defaultOn).map((c) => c.id));
  for (const c of COLUMNS) if (c.locked) hidden.delete(c.id);
  return { order, hidden };
}

const saveLayout = (layout) => store.set(KEY_COLS, { order: layout.order, hidden: [...layout.hidden] });

const visibleColumns = (layout) =>
  layout.order.map((id) => COL_BY_ID.get(id)).filter((c) => c && !layout.hidden.has(c.id));

/** Derives the row states the whole page keys off. */
function decorate(cases, staleDays, now = Date.now()) {
  for (const c of cases) {
    const due = c.nextCommitment?.dueAt ? Date.parse(c.nextCommitment.dueAt) : NaN;
    c._due = Number.isFinite(due) ? due : null;
    c._ageMs = c.createdDate ? now - Date.parse(c.createdDate) : 0;

    const flags = new Set();
    if (c.needsMyReply) flags.add("reply");
    if (c._due !== null) {
      if (c._due < now) flags.add("breached");
      if (fmt.isToday(c._due)) flags.add("due");
    }
    if (!c.needsMyReply && /wait|pending|customer/i.test(c.status || "")) flags.add("waiting");
    const touch = c.lastMyTouch ? Date.parse(c.lastMyTouch) : null;
    if (!c.isClosed && (touch === null || now - touch > staleDays * 86400000)) flags.add("stale");
    if (c.isEscalated) flags.add("escalated");

    c._flags = flags;
    c._state = ["reply", "breached", "due", "stale", "waiting"].find((k) => flags.has(k)) || "";
  }
  return cases;
}

/** Default ordering when the user has not chosen one: most urgent first. */
function byUrgency(a, b) {
  const d = STATE_RANK[a._state] - STATE_RANK[b._state];
  if (d) return d;
  const ad = a._due ?? Infinity, bd = b._due ?? Infinity;
  if (ad !== bd) return ad - bd;
  const p = prioRank(a.priority) - prioRank(b.priority);
  if (p) return p;
  return b._ageMs - a._ageMs;
}

function parseSort(spec) {
  return String(spec || "").split(",").map((s) => s.trim()).filter(Boolean)
    .map((part) => {
      const [id, dir] = part.split(":");
      return COL_BY_ID.has(id) ? { id, dir: dir === "desc" ? "desc" : "asc" } : null;
    })
    .filter(Boolean);
}

const serializeSort = (keys) => keys.map((k) => `${k.id}:${k.dir}`).join(",");

function comparator(keys) {
  if (!keys.length) return byUrgency;
  const cmps = keys.map(({ id, dir }) => {
    const col = COL_BY_ID.get(id);
    const s = dir === "desc" ? -1 : 1;
    return (a, b) => {
      const av = col.sortVal(a), bv = col.sortVal(b);
      const an = av === null || av === undefined || av === "";
      const bn = bv === null || bv === undefined || bv === "";
      if (an && bn) return 0;
      if (an) return 1;            // blanks always sink, whichever direction
      if (bn) return -1;
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * s;
      return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * s;
    };
  });
  return (a, b) => {
    for (const cmp of cmps) { const r = cmp(a, b); if (r) return r; }
    return byUrgency(a, b);
  };
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * copy() resolves to its label rather than announcing anything itself, so every
 * copy affordance in this page pairs it with a toast — a silent clipboard write
 * is indistinguishable from a broken button.
 */
function copyToast(text, label) {
  copy(text, label).then((m) => toast(m, "ok")).catch(() => toast("Could not copy", "error"));
}

function summaryBlock(c) {
  return [
    `Case ${c.caseNumber} — ${c.priority || "—"} — ${c.status || "—"}`,
    `Account: ${c.account || "—"}${c.contactName ? ` (${c.contactName})` : ""}`,
    `Subject: ${c.subject || "—"}`,
    `Opened: ${c.createdDate ? `${fmt.dateTime(c.createdDate)} (${fmt.ageDays(c.createdDate).days}d old)` : "—"}`,
    `Last customer touch: ${c.lastCustomerTouch ? fmt.dateTime(c.lastCustomerTouch) : "—"}`,
    `Last my touch: ${c.lastMyTouch ? fmt.dateTime(c.lastMyTouch) : "—"}`,
    `Next commitment: ${c._due ? `${fmt.dateTime(c._due)} (${fmt.countdown(c._due)})` : "none"}`,
    `QView: ${location.origin}/case/${c.caseNumber}`,
  ].join("\n");
}

/* ------------------------------------------------------------------ render */

export async function render(ctx, host, shell) {
  const layout = columnLayout();
  const staleDays = Number(store.get(KEY_STALE, DEFAULT_STALE_DAYS)) || DEFAULT_STALE_DAYS;

  const q = ctx.query || {};
  const state = {
    scope:    q.status === "closed" || q.status === "all" ? q.status : "open",
    priority: q.priority || "",
    account:  q.account || "",
    area:     q.area || "",
    flag:     q.flag || "",
    find:     q.q || "",
    sort:     parseSort(q.sort),
    group:    q.group || "",
    view:     q.view || "",
    // Set by a Scorecard tile rather than by the toolbar — see DRILL_KEYS.
    caseSet:  parseCaseSet(q.cases),
    opened:   parseRange(q.opened),
    closed:   parseRange(q.closed),
    cstatus:  q.caseStatus || "",
    all:      [],
    rows:     [],
    cursor:   -1,
  };

  let facets = { accounts: [], priorities: [], statuses: [], productAreas: [] };
  let menuEl = null;

  /* --------------------------------------------------------------- chrome */

  const viewsBar   = h("div", { class: "views" });
  const filterBar  = h("div", { class: "toolbar-row" });
  const resultLine = h("div", { class: "result-line" });
  const tableWrap  = h("div", { class: "table-wrap" });

  const root = page(
    // .page-actions is already a flex row with a gap, so the buttons go in bare.
    pageHead("Queue", "Every case I own", [
      button("Columns", { small: true, iconPaths: ICON_COLS, onclick: openColumnPicker }),
      button("Export CSV", { small: true, onclick: exportCsv }),
      button("Save view", { small: true, kind: "primary", onclick: saveCurrentView }),
    ]),
    h("div", { class: "toolbar" }, viewsBar, filterBar),
    resultLine,
    tableWrap,
  );
  mount(host, root);
  mount(tableWrap, skeletonRows(10));

  /* ------------------------------------------------------------ data load */

  async function load() {
    try {
      const [res, f] = await Promise.all([
        api.cases({ status: state.scope, limit: 1000 }),
        api.facets(state.scope === "open" ? undefined : "all").catch(() => null),
      ]);
      if (f) facets = f;
      state.all = decorate(res.cases || [], staleDays);
    } catch (err) {
      mount(tableWrap, banner("error", err.message || "Could not load the queue",
        button("Retry", { small: true, onclick: () => { mount(tableWrap, skeletonRows(6)); load(); } })));
      toastError(err);
      return;
    }
    paintFilters();
    paint();
  }

  /* --------------------------------------------------------- saved views */

  const userViews = () => store.get(KEY_VIEWS, []);

  function applyView(view) {
    setQuery({
      view: null, priority: null, status: null, account: null, area: null, flag: null, sort: null, group: null,
      // A saved view describes a standing slice of the queue; a drill describes
      // one trip in from a Scorecard tile. Picking a view ends the trip.
      cases: null, opened: null, closed: null, caseStatus: null,
      ...(view ? { ...view.params, view: view.id } : {}),
    }, { replace: false });
  }

  /** Counts only mean something for views inside the scope we actually hold. */
  function countFor(v) {
    if ((v.params.status || "open") !== state.scope) return null;
    return filterRows(state.all, {
      priority: v.params.priority || "", account: v.params.account || "",
      area: v.params.area || "", flag: v.params.flag || "", find: "",
    }).length;
  }

  function paintViews() {
    const all = [...BUILTIN_VIEWS, ...userViews()];
    mount(viewsBar, ...all.map((v) => {
      const active = state.view === v.id;
      const pill = h("button", {
        class: `view-pill${active ? " active" : ""}`, title: v.hint || v.label,
        onclick: () => applyView(active ? null : v),
      }, h("span", { text: v.label }));

      const n = countFor(v);
      if (n !== null) pill.append(h("span", { class: "vcount", text: String(n) }));

      if (v.custom) {
        pill.append(h("span", {
          class: "vkill", title: "Delete this view", text: "×",
          onclick: async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog({
              title: "Delete view", message: `Delete the saved view “${v.label}”?`,
              confirmLabel: "Delete", danger: true,
            });
            if (!ok) return;
            store.set(KEY_VIEWS, userViews().filter((x) => x.id !== v.id));
            if (state.view === v.id) applyView(null);
            else paintViews();
          },
        }));
      }
      return pill;
    }));
  }

  /* ------------------------------------------------------------- filters */

  function dropdown(label, key, options, value) {
    const sel = h("select", {
      class: `filter-select${value ? " on" : ""}`, "aria-label": label,
      onchange: (e) => setQuery({ [key]: e.target.value || null, view: null }, { replace: false }),
    }, h("option", { value: "", text: label }));
    for (const o of options) {
      const val = o.value ?? o;
      if (!val) continue;
      sel.append(h("option", {
        value: val, selected: String(val) === String(value),
        text: o.count ? `${o.label ?? val} (${o.count})` : String(o.label ?? val),
      }));
    }
    return sel;
  }

  function paintFilters() {
    const find = h("input", {
      class: "input queue-find", type: "search", placeholder: "Filter these rows…",
      value: state.find, "aria-label": "Filter rows",
      oninput: (e) => { state.find = e.target.value; paint({ keepFocus: true }); },
      onchange: (e) => setQuery({ q: e.target.value || null }, { replace: true }),
    });

    mount(filterBar,
      dropdown("Open cases", "status",
        [{ value: "all", label: "All cases" }, { value: "closed", label: "Closed only" }],
        state.scope === "open" ? "" : state.scope),
      dropdown("Priority", "priority", facets.priorities || [], state.priority),
      dropdown("Account", "account", facets.accounts || [], state.account),
      dropdown("Product area", "area", facets.productAreas || [], state.area),
      dropdown("Row state", "flag",
        Object.entries(STATE_LABEL).map(([value, label]) => ({ value, label })), state.flag),
      find,
      h("span", { class: "spacer" }),
      dropdown("No grouping", "group", GROUPS, state.group),
      button("Reset", {
        small: true,
        onclick: () => setQuery({
          priority: null, account: null, area: null, flag: null,
          q: null, sort: null, view: null, group: null,
          cases: null, opened: null, closed: null, caseStatus: null,
        }, { replace: false }),
      }),
    );
  }

  function filterRows(rows, s) {
    const needle = (s.find || "").trim().toLowerCase();
    const prios = s.priority ? s.priority.split(",").map((x) => x.trim().toUpperCase()) : null;
    return rows.filter((c) => {
      if (prios && !prios.includes((c.priority || "").toUpperCase())) return false;
      if (s.account && c.account !== s.account) return false;
      if (s.area && c.productArea !== s.area) return false;
      if (s.flag && !c._flags.has(s.flag)) return false;
      // Drill-through predicates. These narrow to exactly the population a
      // Scorecard tile counted, which is the whole point of the tile being a
      // link — the number and the list have to be the same set of cases.
      if (s.caseSet && !s.caseSet.has(c.caseNumber)) return false;
      if (s.opened && !inRange(c.createdDate, s.opened)) return false;
      if (s.closed && !inRange(c.closedDate, s.closed)) return false;
      if (s.cstatus && c.status !== s.cstatus) return false;
      if (needle) {
        const hay = `${c.caseNumber} ${c.subject} ${c.account} ${c.contactName} ${c.status} ${c.productArea}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }

  /* ---------------------------------------------------------------- paint */

  function paint(opts = {}) {
    paintViews();
    const cols = visibleColumns(layout);
    const rows = filterRows(state.all, state).sort(comparator(state.sort));
    state.rows = rows;
    if (state.cursor >= rows.length) state.cursor = rows.length - 1;

    /**
     * The case page's prev/next has to walk the queue in the order you are
     * actually looking at, not some canonical order the server would pick. The
     * ordering only exists in this browser, so hand it over here — case numbers
     * only, no case content.
     */
    store.set(KEY_ORDER, { at: Date.now(), numbers: rows.map((r) => r.caseNumber) });

    paintResultLine(rows);

    if (!rows.length) {
      mount(tableWrap, emptyState(emptyFor()));
      if (opts.keepFocus) refocusFind();
      return;
    }

    const tbody = h("tbody");
    const table = h("table", { class: "tbl" }, h("thead", {}, headRow(cols)), tbody);

    const span = cols.length + 1;
    let index = 0;
    for (const [label, items] of (state.group ? groupRows(rows, state.group) : [[null, rows]])) {
      if (label !== null) {
        tbody.append(h("tr", { class: "group-row" },
          h("td", { colspan: String(span) },
            h("span", { text: label || "—" }),
            h("span", { class: "gcount", text: String(items.length) }))));
      }
      for (const c of items) tbody.append(rowFor(c, cols, index++));
    }

    mount(tableWrap, table);
    tickCountdowns();
    if (state.cursor >= 0) focusRow(state.cursor, { scroll: false });
    if (opts.keepFocus) refocusFind();
  }

  function refocusFind() {
    const el = $(".queue-find", filterBar);
    if (!el || document.activeElement === el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }

  /**
   * A drill arrives by link with no toolbar control behind it, so without this
   * the page would silently be showing a subset and look like the whole queue.
   * Each chip says what narrowed the list and offers the way back out.
   */
  function drillChips() {
    const chips = [];
    const chip = (label, key) => chips.push(
      h("span", { class: "drill-chip" },
        h("span", { text: label }),
        h("button", {
          class: "drill-x", type: "button", title: "Remove this filter",
          "aria-label": `Remove filter: ${label}`,
          text: "×", onclick: () => setQuery({ [key]: null, view: null }, { replace: false }),
        })));

    if (state.caseSet) chip(`${state.caseSet.size} specific case${state.caseSet.size === 1 ? "" : "s"}`, "cases");
    if (state.opened)  chip(`opened ${rangeLabel(state.opened)}`, "opened");
    if (state.closed)  chip(`closed ${rangeLabel(state.closed)}`, "closed");
    if (state.cstatus) chip(`status is “${state.cstatus}”`, "caseStatus");
    return chips;
  }

  function paintResultLine(rows) {
    const legend = [...new Set(rows.map((r) => r._state).filter(Boolean))]
      .sort((a, b) => STATE_RANK[a] - STATE_RANK[b]);

    mount(resultLine,
      h("span", { text: `${rows.length} of ${state.all.length} ${state.scope === "open" ? "open " : ""}case${rows.length === 1 ? "" : "s"}` }),
      ...drillChips(),
      state.sort.length
        ? h("button", {
            class: "linkbtn", onclick: () => setQuery({ sort: null }),
            text: `sorted by ${state.sort.map((k) => `${COL_BY_ID.get(k.id).label.toLowerCase()} ${k.dir}`).join(", ")} — reset`,
          })
        : h("span", { class: "dim", text: "sorted by urgency" }),
      h("span", { class: "spacer" }),
      h("span", { class: "legend" }, ...legend.map((k) =>
        h("span", { class: "legend-item" },
          h("span", { class: `legend-swatch st-${k}` }),
          h("span", { class: "muted", text: STATE_LABEL[k] })))),
    );
  }

  function headRow(cols) {
    const tr = h("tr", {}, h("th", { class: "rail", "aria-hidden": "true" }));
    for (const col of cols) {
      const idx = state.sort.findIndex((k) => k.id === col.id);
      const key = idx >= 0 ? state.sort[idx] : null;
      const th = h("th", {
        class: `sortable${key ? " sorted" : ""}`, scope: "col",
        title: "Click to sort · shift-click to add a secondary sort",
        onclick: (e) => toggleSort(col.id, e.shiftKey),
      }, h("span", { text: col.label }));
      if (key) {
        th.append(h("span", { class: "sort-ind", text: key.dir === "asc" ? "▲" : "▼" }));
        if (state.sort.length > 1) th.append(h("span", { class: "sort-rank", text: String(idx + 1) }));
      }
      tr.append(th);
    }
    return tr;
  }

  function rowFor(c, cols, index) {
    const tr = h("tr", {
      class: `row${c._state ? ` st-${c._state}` : ""}`,
      dataset: { case: c.caseNumber, index: String(index) },
      title: c._state ? STATE_LABEL[c._state] : "",
      onclick: () => focusRow(index, { scroll: false }),
      ondblclick: () => openCase(c),
      oncontextmenu: (e) => {
        e.preventDefault();
        focusRow(index, { scroll: false });
        openRowMenu(c, e.clientX, e.clientY);
      },
    }, h("td", { class: "rail" }));
    for (const col of cols) tr.append(h("td", { dataset: { label: col.label } }, col.cell(c)));
    return tr;
  }

  function emptyFor() {
    // A drill that comes up empty is worth its own message: the tile it came
    // from claimed a count, so zero rows here means something disagrees —
    // almost always the scope, since a closed-case drill needs more than the
    // open scope the queue defaults to.
    if (state.caseSet || state.opened || state.closed || state.cstatus) {
      const scoped = state.scope === "open";
      return {
        title: "Nothing here in this scope",
        message: scoped
          ? "This link came from the Scorecard, which counts closed cases too. Widen the scope to see them."
          : "The cache does not hold any case matching this link. It may have been counted before the last sync.",
        iconName: "search",
        action: scoped
          ? button("Include closed cases", { small: true, onclick: () => setQuery({ status: "all" }) })
          : button("Clear this link", {
              small: true,
              onclick: () => setQuery({ cases: null, opened: null, closed: null, caseStatus: null }),
            }),
      };
    }
    if (state.find || state.priority || state.account || state.area || state.flag) {
      return {
        title: "Nothing matches these filters",
        message: "Loosen a filter, or reset to see the whole queue again.",
        iconName: "search",
        action: button("Reset filters", {
          small: true,
          onclick: () => setQuery({
            priority: null, account: null, area: null, flag: null, q: null, view: null,
            cases: null, opened: null, closed: null, caseStatus: null,
          }),
        }),
      };
    }
    if (state.scope === "open") {
      return {
        title: "Queue is clear",
        message: "No open cases are assigned to you right now. That is a good place to be.",
        iconName: "check", kind: "ok",
      };
    }
    return { title: "No cases in this scope", message: "Switch the scope back to open cases.", iconName: "inbox" };
  }

  function groupRows(rows, key) {
    const pick = (c) => (key === "account" ? c.account
      : key === "priority" ? c.priority
      : key === "productArea" ? c.productArea
      : c.status) || "—";
    const map = new Map();
    for (const c of rows) {
      const k = pick(c);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }

  function toggleSort(id, additive) {
    const keys = state.sort.slice();
    const at = keys.findIndex((k) => k.id === id);

    if (!additive) {
      // single click cycles asc → desc → off
      if (at >= 0 && keys.length === 1 && keys[0].dir === "desc") return setQuery({ sort: null });
      const dir = at >= 0 && keys[at].dir === "asc" ? "desc" : "asc";
      return setQuery({ sort: serializeSort([{ id, dir }]) });
    }
    if (at >= 0) {
      if (keys[at].dir === "asc") keys[at] = { id, dir: "desc" };
      else keys.splice(at, 1);
    } else {
      keys.push({ id, dir: "asc" });
    }
    setQuery({ sort: keys.length ? serializeSort(keys) : null });
  }

  /* --------------------------------------------------------------- cursor */

  function focusRow(index, { scroll = true } = {}) {
    const els = $$("tr.row", tableWrap);
    if (!els.length) return;
    state.cursor = Math.max(0, Math.min(index, els.length - 1));
    for (const el of els) el.classList.remove("cursor");
    const el = els[state.cursor];
    el.classList.add("cursor");
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  const rowAt = (i) => (i >= 0 ? state.rows[i] : null);
  const openCase = (c) => { if (c) navigate(`/case/${encodeURIComponent(c.caseNumber)}`); };

  /* ------------------------------------------------------------- row menu */

  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

  function openRowMenu(c, x, y) {
    closeMenu();
    const item = (label, fn) => h("button", { onclick: () => { closeMenu(); fn(); } }, h("span", { text: label }));

    menuEl = h("div", { class: "ctxmenu", role: "menu" },
      h("div", { class: "mtitle", text: `Case ${c.caseNumber}` }),
      item("Copy case number", () => copyToast(c.caseNumber, "Case number copied")),
      item("Copy case link", () => copyToast(`${location.origin}/case/${c.caseNumber}`, "Link copied")),
      item("Copy summary block", () => copyToast(summaryBlock(c), "Summary copied")),
      h("div", { class: "sep" }),
      item("Open in QView", () => openCase(c)),
      // routed server-side so the org's instance URL never ships in the bundle
      item("Open in Salesforce", () => window.open(`/go/case/${encodeURIComponent(c.caseNumber)}`, "_blank", "noopener")),
    );
    document.body.append(menuEl);

    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    menuEl.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  }

  const onDocDown = (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };
  document.addEventListener("mousedown", onDocDown);
  window.addEventListener("resize", closeMenu);

  /* --------------------------------------------------------------- actions */

  function exportCsv() {
    const cols = visibleColumns(layout);
    const head = cols.map((c) => csvCell(c.label)).join(",");
    const body = state.rows.map((c) => cols.map((col) => csvCell(col.csv(c))).join(",")).join("\n");
    // BOM so Excel opens it as UTF-8 rather than mangling customer names
    const blob = new Blob([`﻿${head}\n${body}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: `qview-queue-${fmt.dayKey(new Date())}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(`Exported ${state.rows.length} row${state.rows.length === 1 ? "" : "s"}`, "ok");
  }

  function saveCurrentView() {
    let input;
    dialog({
      title: "Save this view",
      width: "420px",
      body: () => h("div", {},
        h("p", { class: "muted", text: "Saves the current filters, sort and grouping as a pill on this page." }),
        (input = h("input", { class: "input", placeholder: "View name", "aria-label": "View name" })),
      ),
      actions: (close) => [
        button("Cancel", { onclick: close }),
        button("Save", {
          kind: "primary",
          onclick: () => {
            const label = input.value.trim();
            if (!label) { input.focus(); return; }
            store.set(KEY_VIEWS, [...userViews(), {
              id: `u_${Date.now().toString(36)}`,
              label,
              custom: true,
              params: {
                status: state.scope,
                priority: state.priority || null,
                account: state.account || null,
                area: state.area || null,
                flag: state.flag || null,
                sort: state.sort.length ? serializeSort(state.sort) : null,
                group: state.group || null,
              },
            }]);
            close();
            toast(`Saved view “${label}”`, "ok");
            paintViews();
          },
        }),
      ],
    });
    setTimeout(() => input?.focus(), 0);
  }

  function openColumnPicker() {
    const order = layout.order.slice();
    const hidden = new Set(layout.hidden);
    const list = h("div", { class: "col-list" });

    const rebuild = () => {
      mount(list, ...order.map((id) => {
        const col = COL_BY_ID.get(id);
        const row = h("div", {
          class: `col-item${col.locked ? " locked" : ""}`,
          draggable: !col.locked,
          dataset: { id },
          ondragstart: (e) => { e.dataTransfer.setData("text/plain", id); row.classList.add("dragging"); },
          ondragend: () => {
            row.classList.remove("dragging");
            for (const n of $$(".col-item", list)) n.classList.remove("over");
          },
          ondragover: (e) => { e.preventDefault(); row.classList.add("over"); },
          ondragleave: () => row.classList.remove("over"),
          ondrop: (e) => {
            e.preventDefault();
            const from = e.dataTransfer.getData("text/plain");
            if (!from || from === id) return;
            order.splice(order.indexOf(from), 1);
            order.splice(order.indexOf(id), 0, from);
            rebuild();
          },
        },
          h("span", { class: "grab", text: "⠿" }),
          h("input", {
            type: "checkbox", checked: !hidden.has(id), disabled: !!col.locked,
            "aria-label": `Show ${col.label}`,
            onchange: (e) => { if (e.target.checked) hidden.delete(id); else hidden.add(id); },
          }),
          h("span", { class: "cname", text: col.label }),
        );
        return row;
      }));
    };
    rebuild();

    dialog({
      title: "Columns",
      width: "380px",
      body: () => h("div", {},
        h("p", { class: "muted", text: "Drag to reorder, tick to show. Remembered on this device." }),
        list,
      ),
      actions: (close) => [
        button("Reset to default", {
          onclick: () => {
            store.remove(KEY_COLS);
            const fresh = columnLayout();
            layout.order = fresh.order;
            layout.hidden = fresh.hidden;
            close();
            paint();
          },
        }),
        button("Apply", {
          kind: "primary",
          onclick: () => {
            layout.order = order;
            layout.hidden = hidden;
            saveLayout(layout);
            close();
            paint();
          },
        }),
      ],
    });
  }

  /* -------------------------------------------------------------- keyboard */

  // The shell owns "/" and "r" globally; this page only claims list navigation.
  shell.setPageKeys((e) => {
    if (e.key === "Escape" && menuEl) { closeMenu(); return true; }
    if (e.key === "j" || e.key === "ArrowDown") { focusRow(state.cursor + 1); return true; }
    if (e.key === "k" || e.key === "ArrowUp") { focusRow(state.cursor < 0 ? 0 : state.cursor - 1); return true; }
    if (e.key === "Enter") { openCase(rowAt(state.cursor)); return true; }
    if (e.key === ".") {
      const c = rowAt(state.cursor);
      const el = $$("tr.row", tableWrap)[state.cursor];
      if (c && el) {
        const r = el.getBoundingClientRect();
        openRowMenu(c, r.left + 48, r.bottom);
      }
      return true;
    }
    return false;
  });

  /* ------------------------------------------------------ copy + countdown */

  on(tableWrap, "click", ".copybtn", (e, el) => {
    e.preventDefault();
    e.stopPropagation();
    copyToast(el.dataset.copy, "Case number copied");
  });

  function tickCountdowns() {
    const now = Date.now();
    for (const el of $$(".cd[data-due]", tableWrap)) {
      const due = Number(el.dataset.due);
      el.textContent = fmt.countdown(due, now);
      el.classList.toggle("red", due < now);
      el.classList.toggle("amber", due >= now && due - now <= 4 * 3600 * 1000);
    }
  }
  const timer = setInterval(tickCountdowns, 30000);

  await load();

  /* --------------------------------------------------------------- unmount */

  return () => {
    clearInterval(timer);
    closeMenu();
    document.removeEventListener("mousedown", onDocDown);
    window.removeEventListener("resize", closeMenu);
    shell.setPageKeys(null);
  };
}
