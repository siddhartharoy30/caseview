/**
 * IQS scorecard.
 *
 * One rule governs this page: every number is a link. The spec puts it
 * bluntly — a number I cannot click into is a number I do not trust — so each
 * tile, each bar and each chart segment carries the Queue URL that reproduces
 * exactly the population it counted. Where the Queue cannot express that
 * population, the number is not shown as a drill; it is shown as plain text
 * with a note saying why. Silently linking to an approximation would be worse
 * than linking to nothing.
 *
 * Charts are hand-rolled SVG. The app has no build step and no dependencies,
 * and four small charts are not worth changing that. They are also deliberately
 * plain: flat fills, one colour per series, no gradients and no depth. This is
 * a page read at a glance between cases, not a slide.
 */

import { h, mount } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as store from "../lib/store.js";
import * as fmt from "../lib/fmt.js";
import {
  toast, toastError, dialog, confirmDialog, skeletonCards, banner, field, button,
} from "../lib/ui.js";
import { pageHead, page, tile } from "./_shared.js";
import { navigate } from "../router.js";

const KEY_PERIOD = "metrics.period";
const KEY_CUSTOM = "metrics.custom";

const PERIODS = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
  { id: "half", label: "Half" },
  { id: "custom", label: "Custom" },
];

/**
 * CSAT, NPS and IQS live in systems this app cannot reach. They are typed in
 * so a self-assessment ends with one complete page rather than three tabs.
 */
const MANUAL = [
  { id: "csat", label: "CSAT", suffix: "%", min: 0, max: 100, hint: "Average satisfaction across surveys returned in this period." },
  { id: "nps", label: "NPS", suffix: "", min: -100, max: 100, hint: "Net promoter score reported for this period. Range -100 to 100." },
  { id: "iqs", label: "IQS", suffix: "", min: 0, max: 100, hint: "Interaction quality score from the review or self-assessment." },
];

/* ------------------------------------------------------------------ links -- */

function qsp(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    p.set(k, v);
  }
  return p.toString();
}

const queueHref = (params) => "/?" + qsp(params);
const window_ = (r) => `${r.from}..${r.to}`;

const drill = {
  opened: (r) => queueHref({ status: "all", opened: window_(r) }),
  closed: (r) => queueHref({ status: "all", closed: window_(r) }),
  openNow: () => queueHref({ status: "open" }),
  irtMisses: (misses) => queueHref({ status: "all", cases: misses.join(",") }),
  closedByPriority: (r, priority) => queueHref({ status: "all", closed: window_(r), priority }),
  openPriority: (priority) => queueHref({ status: "open", priority }),
  openStatus: (status) => queueHref({ status: "open", caseStatus: status }),
  openArea: (area) => queueHref({ status: "open", area }),
  openAccount: (account) => queueHref({ status: "open", account }),
  escalated: () => queueHref({ status: "open", flag: "escalated" }),
  p1Open: () => queueHref({ status: "open", priority: "P0,P1" }),
  commitments: (state) => "/commitments?state=" + encodeURIComponent(state),
};

/**
 * How far Eastern wall-clock sits behind UTC at a given instant, in ms.
 * The server buckets days in Eastern; the browser must agree with it or a case
 * closed at 9 PM ET would drill into the wrong day.
 */
function etOffsetMs(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: fmt.TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(ms));
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour % 24, +g.minute, +g.second);
  return ms - asUtc;
}

/** ISO instant of Eastern midnight on a YYYY-MM-DD key, offset by whole days. */
function easternMidnightIso(dayKey, plusDays = 0) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d + plusDays);
  return new Date(guess + etOffsetMs(guess)).toISOString();
}

/** One day of the volume chart, as the half-open window the server used. */
function dayHref(kind, dayKey) {
  const from = easternMidnightIso(dayKey);
  const to = easternMidnightIso(dayKey, 1);
  return queueHref({ status: "all", [kind]: `${from}..${to}` });
}

/**
 * An open case in the 3-7d bucket is exactly a case opened between seven and
 * three days ago, so the aging histogram needs no filter the Queue does not
 * already have. The oldest bucket is open-ended, which is why the range
 * parameter tolerates a missing start.
 */
function agingHref(bucket, nowMs) {
  const to = new Date(nowMs - bucket.minDays * 86400000).toISOString();
  const from = bucket.maxDays === null ? "" : new Date(nowMs - bucket.maxDays * 86400000).toISOString();
  return queueHref({ status: "open", opened: `${from}..${to}` });
}

/* ------------------------------------------------------------------- svg --- */

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** Rounds an axis maximum up to something a human would have chosen. */
function niceMax(value) {
  if (!value || value <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * mag;
    if (candidate >= value) return candidate;
  }
  return 10 * mag;
}

function chartFrame({ width = 560, height = 190, pad = { t: 12, r: 12, b: 26, l: 42 } } = {}) {
  const root = svg("svg", {
    class: "chart", viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none", role: "img",
  });
  return {
    root, width, height, pad,
    plotW: width - pad.l - pad.r,
    plotH: height - pad.t - pad.b,
    x0: pad.l,
    y0: height - pad.b,
  };
}

function gridlines(f, max, ticks = 4, format = (v) => String(v)) {
  const out = [];
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const y = f.y0 - (v / max) * f.plotH;
    out.push(svg("line", { class: "grid", x1: f.x0, x2: f.x0 + f.plotW, y1: y, y2: y }));
    out.push(svg("text", { class: "axis", x: f.x0 - 6, y: y + 3.5, "text-anchor": "end" }, format(v)));
  }
  return out;
}

/** Thins day labels to roughly six so a 46-day quarter stays readable. */
function xLabels(f, days, xFor) {
  const stride = Math.max(1, Math.ceil(days.length / 6));
  return days.map((d, i) =>
    i % stride === 0 || i === days.length - 1
      ? svg("text", { class: "axis", x: xFor(i), y: f.y0 + 15, "text-anchor": "middle" }, fmt.dateShort(easternMidnightIso(d)))
      : null);
}

/** Makes an SVG shape behave like a link without leaving the vector. */
function linkify(node, href, label) {
  node.classList.add("hit");
  node.setAttribute("role", "link");
  node.setAttribute("tabindex", "0");
  node.setAttribute("aria-label", label);
  node.addEventListener("click", () => navigate(href));
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(href); }
  });
  return node;
}

function chartKey(entries) {
  return h("div", { class: "chart-key" },
    entries.map(([tone, label]) =>
      h("span", { class: "key-item" }, h("i", { class: "key-swatch " + tone }), label)));
}

/* ----------------------------------------------------------------- charts -- */

function volumeChart(volume) {
  if (!volume.length) return null;
  const f = chartFrame();
  const max = niceMax(Math.max(1, ...volume.map((d) => Math.max(d.opened, d.closed))));
  const slot = f.plotW / volume.length;
  const barW = Math.max(2, Math.min(14, slot / 2 - 1.5));

  const bars = [];
  volume.forEach((d, i) => {
    const centre = f.x0 + slot * (i + 0.5);
    for (const [kind, tone, value] of [["opened", "blue", d.opened], ["closed", "green", d.closed]]) {
      if (!value) continue;
      const height = (value / max) * f.plotH;
      const x = kind === "opened" ? centre - barW - 1 : centre + 1;
      const rect = svg("rect", {
        class: "bar " + tone, x, y: f.y0 - height, width: barW, height,
      }, svg("title", {}, `${fmt.dateShort(easternMidnightIso(d.day))} — ${value} ${kind}`));
      bars.push(linkify(rect, dayHref(kind === "opened" ? "opened" : "closed", d.day),
        `${value} cases ${kind} on ${d.day}`));
    }
  });

  f.root.append(...gridlines(f, max, 4, (v) => String(Math.round(v))), ...bars,
    ...xLabels(f, volume.map((d) => d.day), (i) => f.x0 + slot * (i + 0.5)).filter(Boolean),
    svg("line", { class: "axis-line", x1: f.x0, x2: f.x0 + f.plotW, y1: f.y0, y2: f.y0 }));
  return f.root;
}

/**
 * Mean resolution time per day. Days that closed nothing arrive as null and are
 * drawn as a break in the line rather than a dive to zero — a zero would claim
 * cases were resolved instantly.
 */
function ttrChart(volume) {
  const points = volume.filter((d) => d.meanTtrHours !== null && d.meanTtrHours !== undefined);
  if (points.length < 1) return null;
  const f = chartFrame();
  const max = niceMax(Math.max(...points.map((d) => d.meanTtrHours)));
  const slot = f.plotW / Math.max(1, volume.length);
  const xFor = (i) => f.x0 + slot * (i + 0.5);
  const yFor = (v) => f.y0 - (v / max) * f.plotH;

  const runs = [];
  let run = [];
  volume.forEach((d, i) => {
    if (d.meanTtrHours === null || d.meanTtrHours === undefined) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push([xFor(i), yFor(d.meanTtrHours)]);
    }
  });
  if (run.length) runs.push(run);

  const lines = runs.map((r) =>
    r.length > 1
      ? svg("polyline", { class: "line blue", points: r.map(([x, y]) => `${x},${y}`).join(" ") })
      : svg("circle", { class: "dot blue", cx: r[0][0], cy: r[0][1], r: 2.6 }));

  const dots = volume.map((d, i) =>
    d.meanTtrHours === null || d.meanTtrHours === undefined ? null
      : svg("circle", { class: "dot blue", cx: xFor(i), cy: yFor(d.meanTtrHours), r: 2.6 },
        svg("title", {}, `${fmt.dateShort(easternMidnightIso(d.day))} — mean ${fmt.duration(d.meanTtrHours)} over ${d.closed} closed`)));

  f.root.append(...gridlines(f, max, 4, (v) => (v >= 48 ? `${Math.round(v / 24)}d` : `${Math.round(v)}h`)),
    ...lines, ...dots.filter(Boolean),
    ...xLabels(f, volume.map((d) => d.day), xFor).filter(Boolean),
    svg("line", { class: "axis-line", x1: f.x0, x2: f.x0 + f.plotW, y1: f.y0, y2: f.y0 }));
  return f.root;
}

/**
 * Cumulative opened against cumulative closed. The gap between the two lines is
 * the backlog this period added or removed, which is the only reason to plot
 * two running totals rather than a net figure — the net hides which side moved.
 */
function burndownChart(volume) {
  if (volume.length < 2) return null;
  const f = chartFrame();
  let o = 0, c = 0;
  const series = volume.map((d) => { o += d.opened; c += d.closed; return { day: d.day, o, c }; });
  const max = niceMax(Math.max(o, c, 1));
  const slot = f.plotW / volume.length;
  const xFor = (i) => f.x0 + slot * (i + 0.5);
  const yFor = (v) => f.y0 - (v / max) * f.plotH;

  const openPts = series.map((s, i) => [xFor(i), yFor(s.o)]);
  const closePts = series.map((s, i) => [xFor(i), yFor(s.c)]);
  const band = svg("polygon", {
    class: "band " + (c >= o ? "green" : "red"),
    points: [...openPts, ...closePts.slice().reverse()].map(([x, y]) => `${x},${y}`).join(" "),
  });

  f.root.append(...gridlines(f, max, 4, (v) => String(Math.round(v))), band,
    svg("polyline", { class: "line blue", points: openPts.map(([x, y]) => `${x},${y}`).join(" ") }),
    svg("polyline", { class: "line green", points: closePts.map(([x, y]) => `${x},${y}`).join(" ") }),
    ...xLabels(f, volume.map((d) => d.day), xFor).filter(Boolean),
    svg("line", { class: "axis-line", x1: f.x0, x2: f.x0 + f.plotW, y1: f.y0, y2: f.y0 }));
  return f.root;
}

function agingChart(aging, nowMs) {
  const total = aging.reduce((a, b) => a + b.count, 0);
  if (!total) return null;
  const f = chartFrame({ height: 176 });
  const max = niceMax(Math.max(...aging.map((b) => b.count)));
  const slot = f.plotW / aging.length;
  const barW = Math.min(56, slot - 14);

  const bars = aging.map((b, i) => {
    const x = f.x0 + slot * i + (slot - barW) / 2;
    const height = b.count ? (b.count / max) * f.plotH : 0;
    const tone = b.minDays >= 14 ? "red" : b.minDays >= 7 ? "amber" : "blue";
    const group = svg("g", {},
      svg("rect", { class: "bar " + tone, x, y: f.y0 - height, width: barW, height: Math.max(height, 1) },
        svg("title", {}, `${b.count} open ${b.count === 1 ? "case" : "cases"} aged ${b.key}`)),
      svg("text", { class: "bar-value", x: x + barW / 2, y: f.y0 - height - 5, "text-anchor": "middle" }, b.count),
      svg("text", { class: "axis", x: x + barW / 2, y: f.y0 + 15, "text-anchor": "middle" }, b.key));
    return b.count ? linkify(group, agingHref(b, nowMs), `${b.count} open cases aged ${b.key}`) : group;
  });

  f.root.append(...gridlines(f, max, 3, (v) => String(Math.round(v))), ...bars,
    svg("line", { class: "axis-line", x1: f.x0, x2: f.x0 + f.plotW, y1: f.y0, y2: f.y0 }));
  return f.root;
}

/* -------------------------------------------------------------- fragments -- */


/** Horizontal bars for a categorical breakdown. Each row is its own filter. */
function breakdown(rows, hrefFor, { empty = "Nothing to show.", tone = "blue", max: cap } = {}) {
  if (!rows.length) return h("div", { class: "hint" }, empty);
  const max = cap || Math.max(...rows.map((r) => r.count));
  return h("div", { class: "bars" }, rows.map((r) => {
    const href = hrefFor(r);
    const body = [
      h("span", { class: "bar-name", title: String(r.key) }, String(r.key)),
      h("span", { class: "bar-track" }, h("i", { class: "bar-fill " + tone, style: { width: `${(r.count / max) * 100}%` } })),
      h("span", { class: "bar-count" }, fmt.num(r.count)),
    ];
    return href ? h("a", { class: "bar-row link", href }, body) : h("div", { class: "bar-row" }, body);
  }));
}

function section(title, note, ...children) {
  return h("section", { class: "sc-section" },
    h("div", { class: "sc-head" },
      h("h2", {}, title),
      note ? h("p", { class: "hint" }, note) : null),
    ...children.flat(Infinity).filter(Boolean));
}

function chartCard(title, note, node, key) {
  if (!node) return h("div", { class: "chart-card empty" }, h("h3", {}, title), h("p", { class: "hint" }, note));
  return h("div", { class: "chart-card" },
    h("h3", {}, title),
    key || null,
    h("div", { class: "chart-wrap" }, node));
}

/* ------------------------------------------------------------------ page --- */

export function render(ctx, host, shell) {
  const state = {
    period: store.get(KEY_PERIOD, "week"),
    custom: store.get(KEY_CUSTOM, null), // { from, to } — to is already exclusive
    data: null,
    error: null,
    loading: true,
  };

  const head = pageHead("Scorecard", "Loading…");
  const periodBar = h("div", { class: "sc-periods" });
  const body = h("div", { class: "sc-body" });
  mount(host, page(head, periodBar, body));

  let disposed = false;

  async function load() {
    state.loading = true;
    state.error = null;
    paintPeriodBar();
    mount(body, skeletonCards(8, "92px"), skeletonCards(2, "220px"));
    const params = state.period === "custom" && state.custom
      ? { period: "custom", from: state.custom.from, to: state.custom.to }
      : { period: state.period };
    try {
      const data = await api.metrics(params);
      if (disposed) return;
      state.data = data;
    } catch (err) {
      if (disposed) return;
      state.error = err;
    } finally {
      state.loading = false;
      if (!disposed) paint();
    }
  }

  function setPeriod(id) {
    if (id === "custom" && !state.custom) return askCustomRange();
    state.period = id;
    store.set(KEY_PERIOD, id);
    load();
  }

  function paintPeriodBar() {
    const seg = h("div", { class: "seg", role: "tablist" },
      PERIODS.map((p) => h("button", {
        class: "seg-btn" + (p.id === state.period ? " on" : ""),
        role: "tab", "aria-selected": p.id === state.period ? "true" : "false",
        onclick: () => (p.id === state.period && p.id === "custom" ? askCustomRange() : setPeriod(p.id)),
      }, p.label)));

    const r = state.data && state.data.range;
    const sentence = state.loading
      ? "Reading the cache…"
      : r
        ? `${fmt.dateOnly(r.from)} → ${fmt.dateOnly(new Date(Date.parse(r.to) - 1))} ET`
        : "";

    mount(periodBar, seg,
      h("span", { class: "sc-range" }, sentence),
      h("span", { class: "spacer" }),
      state.period === "custom"
        ? button("Change range", { small: true, onclick: askCustomRange })
        : null,
      button("Refresh", { small: true, onclick: load }));
  }

  function askCustomRange() {
    const today = fmt.dayKey(new Date());
    // The server's window is half-open, so the stored `to` is the day after the
    // last day the user wants counted. Show them the inclusive day they typed.
    const shownTo = state.custom
      ? fmt.dayKey(new Date(Date.parse(state.custom.to) - 1))
      : today;
    const fromEl = h("input", { class: "input", type: "date", max: today, value: state.custom ? fmt.dayKey(state.custom.from) : today });
    const toEl = h("input", { class: "input", type: "date", max: today, value: shownTo });
    const err = h("div", { class: "form-err", style: { display: "none" } });

    const d = dialog({
      title: "Custom range",
      width: "420px",
      body: h("div", {},
        h("p", { class: "hint", style: { marginBottom: "14px" } },
          "Both days are included. Counting runs from midnight Eastern on the first day to midnight Eastern after the last."),
        field("From", fromEl),
        field("To", toEl),
        err),
      actions: (close) => [
        h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
        h("button", {
          class: "btn primary",
          onclick: () => {
            const from = fromEl.value;
            const to = toEl.value;
            if (!from || !to) return fail("Pick both days.");
            if (from > to) return fail("The first day has to come before the last.");
            state.custom = { from: easternMidnightIso(from), to: easternMidnightIso(to, 1) };
            state.period = "custom";
            store.set(KEY_CUSTOM, state.custom);
            store.set(KEY_PERIOD, "custom");
            close(null);
            load();
          },
        }, "Apply"),
      ],
    });

    function fail(message) {
      err.textContent = message;
      err.style.display = "block";
    }
    return d;
  }

  /* ------------------------------------------------------------- painting -- */

  function paint() {
    paintPeriodBar();
    if (state.error) {
      mount(body, banner("error", "Could not read the scorecard: " + (state.error.message || "unknown error"),
        button("Try again", { small: true, onclick: load })));
      return;
    }
    const d = state.data;
    if (!d) return;

    const r = d.range;
    head.querySelector(".page-sub").textContent =
      `${r.label} · ${fmt.dateOnly(r.from)} → ${fmt.dateOnly(new Date(Date.parse(r.to) - 1))} ET`;

    const nowMs = Date.now();
    const p1 = d.ttr.find((t) => t.priority === "P1" || t.priority === "P0");

    /* --- headline ---------------------------------------------------- */

    const headline = h("div", { class: "tiles" },
      tile({
        label: "Cases opened", value: fmt.num(d.owned.opened), href: drill.opened(r),
        sub: "assigned to me in this period",
      }),
      tile({
        label: "Cases closed", value: fmt.num(d.owned.closed), href: drill.closed(r),
        sub: "resolved in this period",
      }),
      tile({
        label: "Open now", value: fmt.num(d.owned.open), href: drill.openNow(),
        sub: "the whole queue, not just this period",
        hint: "Open cases are counted as of right now, so this tile does not move when the period changes.",
      }),
      tile({
        label: "Initial response",
        value: fmt.pct(d.irt.pct),
        tone: d.irt.pct === null ? "" : d.irt.pct >= 95 ? "good" : d.irt.pct >= 85 ? "warn" : "bad",
        href: d.irt.misses.length ? drill.irtMisses(d.irt.misses) : null,
        sub: d.irt.eligible === 0
          ? "no case in this period has been answered yet"
          : d.irt.misses.length
            ? `${d.irt.met} of ${d.irt.eligible} on target · click for the ${d.irt.misses.length} ${d.irt.misses.length === 1 ? "miss" : "misses"}`
            : `${d.irt.met} of ${d.irt.eligible} on target · nothing missed`,
        hint: "Targets in minutes: " + Object.entries(d.irt.targets).map(([k, v]) => `${k} ${v}`).join(", ")
          + ". Cases with no reply yet are not scored here — they are in Triage.",
      }),
      tile({
        label: "Commitments met",
        value: fmt.pct(d.commitments.pct),
        tone: d.commitments.pct === null ? "" : d.commitments.pct >= 95 ? "good" : d.commitments.pct >= 85 ? "warn" : "bad",
        href: d.commitments.met ? drill.commitments("met") : null,
        sub: d.commitments.met + d.commitments.breached === 0
          ? "nothing came due in this period"
          : `${d.commitments.met} met, ${d.commitments.breached} breached`,
        hint: "This is measured from the promises parsed out of my own replies, not from a Salesforce field.",
      }),
      tile({
        label: "Commitments breached",
        value: fmt.num(d.commitments.breached),
        tone: d.commitments.breached ? "bad" : "good",
        href: d.commitments.breached ? drill.commitments("breached") : null,
        sub: d.commitments.breached ? "deadlines that passed unanswered" : "none in this period",
      }),
      tile({
        label: "Escalated, open",
        value: fmt.num(d.escalations.flagged),
        tone: d.escalations.flagged ? "warn" : "",
        href: d.escalations.flagged ? drill.escalated() : null,
        sub: "carrying the escalation flag right now",
      }),
      tile({
        label: "P0/P1 open",
        value: fmt.num(d.escalations.p1),
        tone: d.escalations.p1 ? "warn" : "",
        href: d.escalations.p1 ? drill.p1Open() : null,
        sub: "highest-severity cases still open",
      }));

    /* --- resolution time ---------------------------------------------- */

    const ttrRows = d.ttr.length
      ? h("table", { class: "mini-table" },
        h("thead", {}, h("tr", {},
          h("th", {}, "Priority"), h("th", {}, "Closed"), h("th", {}, "Mean"), h("th", {}, "Median"))),
        h("tbody", {}, d.ttr.map((t) => h("tr", {},
          h("td", {}, h("a", { class: "link", href: drill.closedByPriority(r, t.priority) },
            h("span", { class: "chip " + fmt.priorityClass(t.priority) }, t.priority))),
          h("td", {}, fmt.num(t.count)),
          h("td", {}, fmt.duration(t.meanHours)),
          h("td", {}, fmt.duration(t.medianHours))))))
      : h("div", { class: "hint" }, "No case closed in this period, so there is nothing to average.");

    const ttrSection = section(
      "Time to resolve",
      "Wall clock from case creation to close. Median is the honest one — a single three-week case drags the mean and does not represent the week.",
      h("div", { class: "split" },
        h("div", {},
          tile({
            label: "P1 time to resolve",
            value: p1 ? fmt.duration(p1.medianHours) : "—",
            sub: p1 ? `median across ${p1.count} closed · mean ${fmt.duration(p1.meanHours)}` : "no P0 or P1 closed in this period",
            href: p1 ? drill.closedByPriority(r, p1.priority) : null,
            hint: "Called out on its own because P1 resolution time is the number that gets asked about.",
          })),
        h("div", {}, ttrRows)));

    /* --- charts --------------------------------------------------------- */

    const charts = section("Trends", "Everything here is drawn from the same rows the tiles above counted.",
      h("div", { class: "chart-grid" },
        chartCard("Case volume", "Nothing opened or closed in this period.",
          volumeChart(d.volume), chartKey([["blue", "Opened"], ["green", "Closed"]])),
        chartCard("Resolution time", "No case closed in this period, so there is no trend to draw.",
          ttrChart(d.volume), chartKey([["blue", "Mean hours to close"]])),
        chartCard("Opened vs closed, cumulative", "Two days of data are needed before a burn-down means anything.",
          burndownChart(d.volume), chartKey([["blue", "Opened"], ["green", "Closed"]])),
        chartCard("Open case age", "The queue is empty.",
          agingChart(d.aging, nowMs), chartKey([["blue", "Under a week"], ["amber", "1-2 weeks"], ["red", "Over two weeks"]]))));

    /* --- breakdowns ------------------------------------------------------ */

    const breakdowns = section("The queue right now",
      "These four count open cases as of this moment and do not follow the period selector.",
      h("div", { class: "break-grid" },
        h("div", { class: "break-card" }, h("h3", {}, "By priority"),
          breakdown(d.openByPriority, (row) => (row.key === "Unset" ? null : drill.openPriority(row.key)), { empty: "Nothing open." })),
        h("div", { class: "break-card" }, h("h3", {}, "By status"),
          breakdown(d.openByStatus, (row) => drill.openStatus(row.key), { empty: "Nothing open.", tone: "purple" })),
        h("div", { class: "break-card" }, h("h3", {}, "By product area"),
          breakdown(d.byProductArea, (row) => (row.key === "Unclassified" ? null : drill.openArea(row.key)), { empty: "Nothing open.", tone: "cyan" })),
        h("div", { class: "break-card" }, h("h3", {}, "Top accounts"),
          breakdown(d.byAccount, (row) => (row.key === "Unknown" ? null : drill.openAccount(row.key)), { empty: "Nothing open.", tone: "green" }))));

    mount(body, headline, ttrSection, charts, breakdowns, manualBlock(d, r));
  }

  /* --------------------------------------------------------------- manual -- */

  /**
   * A hand-typed score belongs to the period it was typed against, not to
   * whatever the selector happens to be showing later, so the key encodes the
   * period itself rather than an id that would drift.
   */
  function periodKey(r) {
    const from = fmt.dayKey(r.from);
    const [y, m] = from.split("-").map(Number);
    if (state.period === "month") return `month:${y}-${String(m).padStart(2, "0")}`;
    if (state.period === "quarter") return `quarter:${y}-Q${Math.ceil(m / 3)}`;
    if (state.period === "half") return `half:${y}-H${m <= 6 ? 1 : 2}`;
    if (state.period === "custom") return `custom:${from}..${fmt.dayKey(new Date(Date.parse(r.to) - 1))}`;
    return `week:${from}`;
  }

  function manualBlock(d, r) {
    const key = periodKey(r);
    const byMetric = new Map(d.manual.filter((m) => m.period === key).map((m) => [m.metric, m]));

    const cards = MANUAL.map((spec) => {
      const row = byMetric.get(spec.id);
      return h("div", { class: "manual-card" + (row ? "" : " unset") },
        h("div", { class: "manual-head" },
          h("span", { class: "manual-label" }, spec.label),
          h("span", { class: "manual-value" }, row ? `${row.value}${spec.suffix}` : "—")),
        h("p", { class: "hint" }, row && row.note ? row.note : spec.hint),
        h("div", { class: "manual-meta" },
          row ? `Saved ${fmt.dateTime(row.updated_at)}` : "Not recorded for this period"),
        h("div", { class: "manual-actions" },
          button(row ? "Edit" : "Record", { small: true, onclick: () => editManual(spec, row, key) }),
          row ? button("Clear", { small: true, kind: "danger", onclick: () => clearManual(spec, key) }) : null));
    });

    return section("Self-assessment",
      `CSAT, NPS and IQS are not in Salesforce, so they are typed in here and stored locally against ${key}. `
      + "They stay attached to that period, so changing the selector does not carry them along.",
      h("div", { class: "manual-grid" }, cards));
  }

  function editManual(spec, row, key) {
    const input = h("input", {
      class: "input", type: "number", step: "0.1",
      min: String(spec.min), max: String(spec.max),
      value: row ? String(row.value) : "",
      placeholder: `${spec.min} to ${spec.max}`,
    });
    const note = h("input", { class: "input", value: row && row.note ? row.note : "", placeholder: "Optional note — where this came from" });
    const err = h("div", { class: "form-err", style: { display: "none" } });

    dialog({
      title: `${row ? "Edit" : "Record"} ${spec.label}`,
      width: "420px",
      body: h("div", {},
        h("p", { class: "hint", style: { marginBottom: "14px" } }, spec.hint),
        field(`${spec.label} for ${key}`, input),
        field("Note", note),
        err),
      actions: (close) => [
        h("button", { class: "btn", onclick: () => close(null) }, "Cancel"),
        h("button", {
          class: "btn primary",
          onclick: async () => {
            const value = Number(input.value);
            if (input.value === "" || Number.isNaN(value)) {
              err.textContent = "Enter a number.";
              err.style.display = "block";
              return;
            }
            if (value < spec.min || value > spec.max) {
              err.textContent = `${spec.label} has to be between ${spec.min} and ${spec.max}.`;
              err.style.display = "block";
              return;
            }
            try {
              await api.saveManualMetric({ period: key, metric: spec.id, value, note: note.value.trim() || undefined });
              close(null);
              toast(`${spec.label} saved`);
              load();
            } catch (e) {
              toastError(e);
            }
          },
        }, "Save"),
      ],
    });
  }

  async function clearManual(spec, key) {
    const ok = await confirmDialog({
      title: `Clear ${spec.label}?`,
      message: `The ${spec.label} recorded for ${key} will be removed. Nothing else is affected.`,
      confirmLabel: "Clear",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteManualMetric({ period: key, metric: spec.id });
      toast(`${spec.label} cleared`);
      load();
    } catch (e) {
      toastError(e);
    }
  }

  /* ----------------------------------------------------------------- keys -- */

  shell.setPageKeys((e) => {
    if (e.key !== "[" && e.key !== "]") return false;
    const ids = PERIODS.map((p) => p.id);
    const at = Math.max(0, ids.indexOf(state.period));
    const next = ids[Math.min(ids.length - 1, Math.max(0, at + (e.key === "]" ? 1 : -1)))];
    if (next !== state.period) setPeriod(next);
    return true;
  });

  load();

  return () => { disposed = true; };
}
