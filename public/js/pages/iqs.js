/**
 * Quality — the two scorers side by side, and what the model one costs.
 *
 * Phase 3's gate is "cost and hit rate visible", so those two numbers open the
 * page and are never behind a click. Everything below them answers the
 * question they raise: if the model is being paid for, what is it saying that
 * the regex did not?
 *
 * Three things this page refuses to do.
 *
 *   1. TREAT AN ABSENT MODEL AS AN ERROR. No token, budget spent, layer turned
 *      off -- each is a sentence printed where the model column would be, with
 *      Layer 1 rendered in full beside it. A Layer 2 outage costs the delta
 *      table, never the page.
 *
 *   2. SPEND MONEY ON A PAGE LOAD. Nothing here scores. The overview is a read
 *      of what is already stored. The one button that can spend says so on its
 *      face and reports what it spent when it returns.
 *
 *   3. LINK TO AN APPROXIMATION. A number is a link when the Queue can
 *      reproduce exactly the population it counted. The band distributions
 *      cannot be expressed as a Queue filter, so they are plain, with a note.
 *      The delta table can -- it names its own cases -- so it links.
 *
 * The band vocabulary is imported, never restated: bands, labels and tones all
 * come from lib/iqs.js, which reads them from the rubric the server sends.
 */

import { h, mount } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as store from "../lib/store.js";
import * as fmt from "../lib/fmt.js";
import { toast, toastError, banner, button, skeletonCards } from "../lib/ui.js";
import { pageHead, page, tile } from "./_shared.js";
import { scoreMeter, bandLabel, tone, KEYWORD_LABEL } from "../lib/iqs.js";
import { navigate } from "../router.js";

const KEY_SCOPE = "iqs.scope";
const WINDOW_DAYS = 30;
const TABLE_LIMIT = 120;

/* ------------------------------------------------------------------ format */

/**
 * Money, at the precision the number deserves. A day of sweeping is fractions
 * of a cent and does not move at all at two decimals; a month is dollars and
 * would be unreadable at five.
 */
function usd(n) {
  const v = Number(n) || 0;
  if (v === 0) return "$0";
  if (v < 0.001) return "<$0.001";
  if (v < 1) return "$" + v.toFixed(3);
  return "$" + v.toFixed(2);
}

/** Token counts get an order-of-magnitude suffix; the exact figure is a title. */
function tokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1e6) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + "k";
  return (v / 1e6).toFixed(2) + "M";
}

/** Elapsed time for a sweep: milliseconds up to a second, then seconds. */
function msText(v) {
  const ms = Number(v) || 0;
  if (ms < 1000) return Math.round(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  const mins = Math.floor(ms / 60000);
  return mins + "m " + Math.round((ms % 60000) / 1000) + "s";
}

/**
 * availability() writes its reasons as whole sentences. Every caller here
 * sets one inside a larger sentence -- after a colon, inside brackets -- so
 * the trailing stop is the caller's to add, never the reason's to keep.
 */
const because = (reason, fallback) => String(reason || fallback).replace(/\s*\.+\s*$/, "");

const pctText = (n) => (n === null || n === undefined ? "—" : n.toFixed(1).replace(/\.0$/, "") + "%");

const signed = (n) => (n > 0 ? "+" : "") + n.toFixed(1).replace(/\.0$/, "");

/* ------------------------------------------------------------------- links */

const casesHref = (numbers) =>
  "/?status=all&cases=" + encodeURIComponent(numbers.join(","));

const caseHref = (n) => "/case/" + encodeURIComponent(n) + "?tab=iqs";

/** The Queue sorted worst-quality-first: the population the scorer covers. */
const worstFirst = () => "/?status=open&sort=iqs:asc";

/* --------------------------------------------------------------- fragments */

function fact(k, v, title) {
  return h("div", { class: "l2-fact", title: title || null },
    h("dt", { text: k }),
    h("dd", { class: "mono", text: String(v) }));
}

/**
 * The model's own status line, rendered whether or not it is on.
 *
 * "Off" is a state with a reason, not a failure: the reason string comes from
 * availability() and is the only place the user learns that a token is missing
 * rather than that the gateway is down.
 */
function layer2Strip(meta) {
  const on = meta.enabled;
  return h("div", { class: "l2-strip " + (on ? "on" : "off") },
    h("span", { class: "l2-dot", "aria-hidden": "true" }),
    h("div", { class: "l2-strip-main" },
      h("div", { class: "l2-strip-title", text: on ? "Model scoring is on" : "Model scoring is off" }),
      h("div", { class: "l2-strip-sub", text: meta.reason || (on ? "Gateway reachable." : "No reason given.") })),
    h("dl", { class: "l2-facts" },
      fact("Model", meta.model || "—"),
      fact("Prompt", meta.promptVersion || "—"),
      fact("Rubric", meta.rubricVersion || "—", "Both layers score against this rubric version.")));
}

/**
 * Spend against the daily cap.
 *
 * The cap is enforced against our own list-price estimate, not a bill -- the
 * gateway reports no spend -- so the footer says estimate rather than letting
 * the bar imply an invoice.
 */
function budgetMeter(b) {
  if (!b || !b.dailyUsd) {
    return h("div", { class: "budget none" },
      h("div", { class: "budget-row" },
        h("span", { class: "budget-label" }, "Daily budget"),
        h("span", { class: "budget-num mono" }, "no cap")),
      h("div", { class: "budget-foot" },
        "No daily cap is set, so nothing but the sweep's own pace limits spending. "
        + usd(b ? b.spentToday : 0) + " estimated so far today."));
  }
  const frac = Math.max(0, Math.min(1, b.spentToday / b.dailyUsd));
  const t = b.exhausted ? "bad" : frac >= 0.7 ? "mid" : "good";
  return h("div", { class: "budget t-" + t },
    h("div", { class: "budget-row" },
      h("span", { class: "budget-label" }, "Daily budget"),
      h("span", { class: "budget-num mono" }, usd(b.spentToday) + " of " + usd(b.dailyUsd))),
    h("span", { class: "budget-track" },
      h("i", { class: "budget-fill", style: { width: (frac * 100).toFixed(1) + "%" } })),
    h("div", { class: "budget-foot" },
      b.exhausted
        ? "Spent. The sweep is paused and Score again refuses until midnight UTC."
        : usd(b.remainingUsd) + " left today, estimated at list price. Resets at midnight UTC."));
}

/** What the sweep is, when it last ran, and a way to run it now. */
function sweepCard(meta, { onSweep, busy }) {
  const s = meta.sweep || {};
  const last = s.last;
  const cadence = !meta.enabled
    ? "Paused: " + because(meta.reason, "the model layer is off") + "."
    : s.scheduled
      ? "Every " + s.everyMinutes + " minutes, " + s.batch + " cases at a time."
      : "No timer is armed, so cases are only scored when this button is pressed.";

  const lastLine = !last
    ? h("p", { class: "hint" }, "Has not run since the server started.")
    : h("ul", { class: "sweep-stats" },
        h("li", {}, h("b", {}, fmt.num(last.considered)), " considered"),
        h("li", {}, h("b", {}, fmt.num(last.fresh)), " scored"),
        h("li", {}, h("b", {}, fmt.num(last.hits)), " already current"),
        last.skipped ? h("li", {}, h("b", {}, fmt.num(last.skipped)), " skipped") : null,
        last.errors ? h("li", { class: "t-bad" }, h("b", {}, fmt.num(last.errors)), " failed") : null,
        h("li", {}, h("b", {}, usd(last.costUsd)), " spent"),
        h("li", {}, h("b", {}, msText(last.ms)), " elapsed"));

  return h("div", { class: "card iqs-card sweep-card" },
    h("div", { class: "iqs-card-head" },
      h("h3", {}, "Background sweep"),
      s.running ? h("span", { class: "chip p2" }, "running") : null),
    h("p", { class: "hint" }, cadence),
    last ? h("div", { class: "sweep-when" }, "Last run " + fmt.relative(last.at)) : null,
    lastLine,
    h("div", { class: "iqs-card-foot" },
      button(busy ? "Sweeping…" : "Run sweep now", {
        small: true, onclick: onSweep, disabled: !meta.enabled || busy,
        title: meta.enabled
          ? "Scores up to " + s.batch + " cases that cannot currently hold a valid score. This spends money."
          : "Disabled: " + because(meta.reason, "the model layer is off") + ". There is nothing it could spend.",
      }),
      h("span", { class: "hint" },
        meta.enabled
          ? "This one spends money."
          : "Nothing to run while the model layer is off.")));
}

/** A band distribution as three bars. Counts, not percentages, lead. */
function bandBars(counts, { note }) {
  const rows = [
    { band: "meeting", n: counts.meeting || 0 },
    { band: "partial", n: counts.partial || 0 },
    { band: "not_meeting", n: counts.notMeeting || 0 },
  ];
  const total = rows.reduce((a, r) => a + r.n, 0);
  if (!total) return h("p", { class: "hint" }, "Nothing scored yet.");
  const max = Math.max(...rows.map((r) => r.n));
  return h("div", {},
    h("div", { class: "bars" }, rows.map((r) =>
      h("div", { class: "bar-row" },
        h("span", { class: "bar-name" }, bandLabel(r.band)),
        h("span", { class: "bar-track" },
          h("i", {
            class: "bar-fill t-" + tone(r.band),
            style: { width: (max ? (r.n / max) * 100 : 0) + "%", background: "var(--tone)" },
          })),
        h("span", { class: "bar-count" },
          fmt.num(r.n),
          h("span", { class: "bar-pct" }, " " + Math.round((r.n / total) * 100) + "%"))))),
    note ? h("p", { class: "hint bars-note" }, note) : null);
}

/** One scorer's summary column. */
function scorerCard({ title, sub, stats, tone: cardTone, note, action }) {
  return h("div", { class: "card iqs-card scorer-card " + (cardTone || "") },
    h("div", { class: "iqs-card-head" },
      h("h3", {}, title),
      action || null),
    h("p", { class: "hint" }, sub),
    stats.scored
      ? h("div", { class: "scorer-headline" },
          h("div", { class: "scorer-avg" },
            scoreMeter(stats.average, bandOf(stats.average), { width: 96 }),
            h("span", { class: "scorer-avg-label" }, "mean of " + fmt.num(stats.scored)
              + (stats.scored === 1 ? " case" : " cases"))),
          stats.lastScoredAt
            ? h("div", { class: "scorer-when" }, "Last scored " + fmt.relative(stats.lastScoredAt))
            : null)
      : null,
    bandBars(stats, { note }));
}

/**
 * The band a mean falls in.
 *
 * Recomputed here rather than stored because a mean is not a case and the
 * server does not band one. The thresholds still are not duplicated: they come
 * from the rubric the payload carries, and the caller passes them in.
 */
let BANDS = { meeting: 0.8, partial: 0.5 };
function bandOf(avg) {
  if (avg === null || avg === undefined) return null;
  const f = avg / 100;
  if (f >= BANDS.meeting) return "meeting";
  if (f >= BANDS.partial) return "partial";
  return "not_meeting";
}

/**
 * Where the two scorers disagree.
 *
 * This is the product. A negative delta -- the model below the regex -- is
 * usually a template phrase that satisfied a pattern and not a person. A
 * positive one is the regex being harsher than a reader would be. Agreement is
 * not news, which is why the server sorts by the size of the gap.
 */
function deltaTable(rows, onOpen) {
  if (!rows.length) {
    return h("p", { class: "hint" },
      "No case has both scores yet. Score one from its Quality tab, or run the sweep.");
  }
  const body = rows.map((r) => {
    const d = r.delta;
    const dTone = d === null ? "none" : Math.abs(d) < 5 ? "none" : d < 0 ? "bad" : "good";
    return h("tr", {
      class: "row iqs-delta-row",
      tabindex: "0",
      onclick: () => onOpen(r.caseNumber),
      onkeydown: (e) => { if (e.key === "Enter") onOpen(r.caseNumber); },
    },
      h("td", { class: "mono nowrap" }, r.caseNumber),
      h("td", { class: "iqs-subj", title: r.subject || "" }, r.subject || "—"),
      h("td", { class: "nowrap" },
        h("span", { class: "iqs-kw" }, (KEYWORD_LABEL[r.keyword] || r.keyword || "—").toUpperCase())),
      h("td", { class: "right" }, r.layer1 === null ? "—" : scoreMeter(r.layer1, r.layer1Band, { width: 44 })),
      h("td", { class: "right" }, r.layer2 === null ? "—" : scoreMeter(r.layer2, r.layer2Band, { width: 44 })),
      h("td", { class: "right" },
        h("span", { class: "iqs-delta t-" + dTone }, d === null ? "—" : signed(d))),
      h("td", { class: "nowrap hint" }, fmt.dateTimeShort(r.scoredAt)));
  });

  return h("div", { class: "table-wrap" },
    h("table", { class: "tbl iqs-delta" },
      h("thead", {},
        h("tr", {},
          h("th", {}, "Case"),
          h("th", {}, "Subject"),
          h("th", {}, "Scored as"),
          h("th", { class: "right" }, "Layer 1"),
          h("th", { class: "right" }, "Layer 2"),
          h("th", { class: "right" }, "Δ"),
          h("th", {}, "Model scored"))),
      h("tbody", {}, body)));
}

/**
 * Predicted vs official, side by side, never averaged (phase 0's rule --
 * the two are not measured against the same dimensions or weights, so a
 * blended number would claim a precision neither score has).
 */
function officialTable(rows, onOpen) {
  if (!rows.length) {
    return h("p", { class: "hint" }, "Nothing imported yet — paste a report above.");
  }
  const body = rows.map((r) => {
    const d = r.delta;
    const dTone = d === null ? "none" : Math.abs(d) < 5 ? "none" : d < 0 ? "bad" : "good";
    return h("tr", {
      class: "row iqs-delta-row",
      tabindex: "0",
      onclick: () => onOpen(r.caseNumber),
      onkeydown: (e) => { if (e.key === "Enter") onOpen(r.caseNumber); },
    },
      h("td", { class: "mono nowrap" }, r.caseNumber),
      h("td", { class: "right" }, r.predicted === null ? "not scored" : scoreMeter(r.predicted, null, { width: 44 })),
      h("td", { class: "right mono" }, r.official.toFixed(1)),
      h("td", { class: "right" },
        h("span", { class: "iqs-delta t-" + dTone }, d === null ? "—" : signed(d))),
      h("td", { class: "nowrap hint" }, fmt.dateTimeShort(r.importedAt)));
  });

  return h("div", { class: "table-wrap" },
    h("table", { class: "tbl iqs-delta" },
      h("thead", {},
        h("tr", {},
          h("th", {}, "Case"),
          h("th", { class: "right" }, "Predicted (Layer 1)"),
          h("th", { class: "right" }, "Official (SentryAI)"),
          h("th", { class: "right" }, "Δ"),
          h("th", {}, "Imported"))),
      h("tbody", {}, body)));
}

/**
 * The paste box. Column names are matched by alias, not one exact format --
 * nobody on this project has seen a real SentryAI export, so this reports
 * what it understood before committing rather than assuming it guessed right.
 */
function officialImportCard(onImported) {
  const area = h("textarea", {
    class: "input",
    rows: "6",
    style: { fontFamily: "ui-monospace, monospace", fontSize: "12px" },
    placeholder: "Paste a CSV or a copied table from the IQS Report page — needs a case number column and a score column, any header names.",
  });
  const resultHost = h("div", { style: { marginTop: "10px" } });
  const importBtn = button("Import", {
    kind: "primary", small: true,
    onclick: async () => {
      const text = area.value.trim();
      if (!text) { toast("Paste some rows first", "error"); return; }
      importBtn.disabled = true;
      importBtn.textContent = "Importing…";
      try {
        const result = await api.importOfficialScores(text);
        mount(resultHost,
          banner(result.unmatched.length || result.warnings.length ? "warn" : "info",
            `Imported ${result.imported} score${result.imported === 1 ? "" : "s"}.`
            + (result.unmatched.length ? ` ${result.unmatched.length} case number(s) not in the cache: ${result.unmatched.join(", ")}.` : "")
            + (result.warnings.length ? ` ${result.warnings.length} row(s) skipped.` : "")),
          result.warnings.length
            ? h("ul", { class: "hint", style: { margin: "6px 0 0 18px" } }, result.warnings.map((w) => h("li", {}, w)))
            : null);
        if (result.imported) { area.value = ""; onImported(); }
      } catch (err) {
        toast(err.message || "Import failed", "error");
      }
      importBtn.disabled = false;
      importBtn.textContent = "Import";
    },
  });

  return h("div", { class: "card iqs-card" },
    area,
    h("div", { style: { marginTop: "8px" } }, importBtn),
    resultHost);
}

const OUTCOME_TONE = { hit: "good", miss: "blue", skip: "none", error: "bad" };
const OUTCOME_LABEL = { hit: "cache hit", miss: "scored", skip: "skipped", error: "failed" };

/** Every decision the store made, hits included. The ledger, read back. */
function activityList(rows) {
  if (!rows.length) return h("p", { class: "hint" }, "No decisions recorded yet.");
  return h("ul", { class: "l2-activity" }, rows.map((r) =>
    h("li", { class: "l2-act t-" + (OUTCOME_TONE[r.outcome] || "none") },
      h("span", { class: "l2-act-dot", "aria-hidden": "true" }),
      h("span", { class: "l2-act-when hint" }, fmt.relative(r.createdAt)),
      r.caseNumber
        ? h("a", { class: "l2-act-case mono link", href: caseHref(r.caseNumber) }, r.caseNumber)
        : h("span", { class: "l2-act-case hint" }, "—"),
      h("span", { class: "l2-act-outcome" }, OUTCOME_LABEL[r.outcome] || r.outcome),
      r.reason ? h("span", { class: "l2-act-reason hint" }, r.reason) : null,
      h("span", { class: "spacer" }),
      r.costUsd ? h("span", { class: "l2-act-cost mono" }, usd(r.costUsd)) : null,
      r.ms ? h("span", { class: "l2-act-ms hint mono" }, Math.round(r.ms) + "ms") : null,
      h("span", { class: "l2-act-src hint" }, r.source))));
}

function section(title, note, ...children) {
  return h("section", { class: "sc-section" },
    h("div", { class: "sc-head" },
      h("h2", {}, title),
      note ? h("p", { class: "hint" }, note) : null),
    ...children.flat(Infinity).filter(Boolean));
}

/* ------------------------------------------------------------------- page */

export function render(ctx, host, shell) {
  const state = {
    scope: store.get(KEY_SCOPE, "open") === "all" ? "all" : "open",
    data: null,
    error: null,
    loading: true,
    sweeping: false,
  };

  const head = pageHead("Quality", "Reading the cache…");
  const scopeBar = h("div", { class: "sc-periods" });
  const body = h("div", { class: "sc-body" });
  mount(host, page(head, scopeBar, body));

  let disposed = false;
  if (shell && shell.setPageKeys) shell.setPageKeys(null);

  /* ---------------------------------------------------------------- load */

  async function load() {
    state.loading = true;
    state.error = null;
    paintScopeBar();
    mount(body, skeletonCards(8, "92px"), skeletonCards(2, "220px"));
    try {
      const data = await api.iqsOverview({
        open: state.scope === "open",
        days: WINDOW_DAYS,
        limit: TABLE_LIMIT,
      });
      if (disposed) return;
      state.data = data;
      if (data.rubric && data.rubric.bands) BANDS = data.rubric.bands;
    } catch (err) {
      if (disposed) return;
      state.error = err;
    } finally {
      state.loading = false;
      if (!disposed) paint();
    }
  }

  function setScope(id) {
    if (id === state.scope) return;
    state.scope = id;
    store.set(KEY_SCOPE, id);
    load();
  }

  /**
   * The only outbound call this page can make. It is a POST because it spends,
   * and it reports what it spent rather than silently refreshing -- a button
   * that costs money and shows nothing is indistinguishable from a broken one.
   */
  async function runSweep() {
    if (state.sweeping) return;
    state.sweeping = true;
    paint();
    try {
      const { run } = await api.iqsSweep();
      if (disposed) return;
      if (!run) {
        toast("Sweep did not run: it is either already in flight, off, or out of budget.", "warn");
      } else if (!run.considered) {
        toast("Nothing to sweep — every open case already holds a current score.", "ok");
      } else {
        toast(run.fresh + " scored, " + run.hits + " already current, " + usd(run.costUsd) + " spent.", "ok");
      }
    } catch (err) {
      if (!disposed) toastError(err);
    } finally {
      state.sweeping = false;
      if (!disposed) await load();
    }
  }

  /* ------------------------------------------------------------- painting */

  function paintScopeBar() {
    const seg = h("div", { class: "seg", role: "tablist" },
      [["open", "Open cases"], ["all", "All cases"]].map(([id, label]) =>
        h("button", {
          class: "seg-btn" + (id === state.scope ? " on" : ""),
          role: "tab", "aria-selected": id === state.scope ? "true" : "false",
          onclick: () => setScope(id),
        }, label)));

    const d = state.data;
    mount(scopeBar, seg,
      h("span", { class: "sc-range" },
        state.loading ? "Reading the cache…"
          : d ? "Ledger over the last " + d.layer2.windowDays + " days" : ""),
      h("span", { class: "spacer" }),
      button("Refresh", { small: true, onclick: load }));
  }

  function paint() {
    paintScopeBar();

    if (state.error) {
      mount(body, banner("error",
        "Could not read the quality overview: " + (state.error.message || "unknown error"),
        button("Try again", { small: true, onclick: load })));
      return;
    }
    const d = state.data;
    if (!d) return;

    const { layer1: l1, layer2: l2, meta, comparisons, activity } = d;
    const decided = l2.hits + l2.misses;

    head.querySelector(".page-sub").textContent =
      "Rubric " + meta.rubricVersion + " · Layer 1 scored " + fmt.num(l1.scored)
      + " · Layer 2 scored " + fmt.num(l2.scored)
      + (state.scope === "open" ? " · open cases only" : " · all cases");

    /* --- the gate: cost and hit rate ---------------------------------- */

    const gate = h("div", { class: "tiles" },
      tile({
        label: "Cache hit rate",
        value: pctText(l2.hitRate),
        tone: l2.hitRate === null ? "" : l2.hitRate >= 60 ? "t-good" : l2.hitRate >= 30 ? "t-mid" : "t-bad",
        sub: decided
          ? fmt.num(l2.hits) + " of " + fmt.num(decided) + " decisions served from cache"
          : "no decisions yet",
        hint: "Only decisions that could have gone either way are counted. "
          + "Skips are excluded so an unreachable gateway cannot inflate the rate.",
      }),
      tile({
        label: "Spent today",
        value: usd(l2.spendToday),
        tone: meta.budget && meta.budget.exhausted ? "t-bad" : "",
        sub: meta.budget && meta.budget.dailyUsd
          ? usd(meta.budget.remainingUsd) + " of " + usd(meta.budget.dailyUsd) + " left"
          : "no daily cap",
        hint: "Our own list-price estimate. The gateway reports no spend, so this is "
          + "a runaway-loop brake, not an invoice.",
      }),
      tile({
        label: "Last 7 days", value: usd(l2.spend7d),
        sub: "estimated at list price",
      }),
      tile({
        label: "Last " + l2.windowDays + " days", value: usd(l2.spend30d),
        sub: "estimated at list price",
      }),
      tile({
        label: "Scores bought", value: fmt.num(l2.misses),
        sub: "model calls that produced a new score",
      }),
      tile({
        label: "Skipped", value: fmt.num(l2.skipped),
        sub: "no token, no budget, or nothing scorable",
      }),
      tile({
        label: "Failed", value: fmt.num(l2.errors),
        tone: l2.errors ? "t-bad" : "",
        sub: l2.errors ? "gateway or parse failures" : "none in the window",
      }),
      tile({
        label: "Mean call", value: l2.avgMs === null ? "—" : msText(l2.avgMs),
        sub: "mean round trip to the gateway",
      }));

    const tokenStrip = h("div", { class: "l2-tokens" },
      h("span", { class: "l2-tok-label" }, "Tokens over " + l2.windowDays + " days"),
      tok("in", l2.inputTokens),
      tok("out", l2.outputTokens),
      tok("cache read", l2.cacheReadTokens),
      tok("cache write", l2.cacheWriteTokens));

    /* --- the two scorers ---------------------------------------------- */

    const scorers = h("div", { class: "iqs-two" },
      scorerCard({
        title: "Layer 1 · deterministic",
        sub: "Pure functions over the cached rows. No network, no key, runs on every sync. "
          + "Scorer " + l1.scorerVersion + ".",
        stats: l1,
        note: "Band counts cannot be expressed as a Queue filter, so they are not links. "
          + "The Queue sorted worst-first is the closest honest equivalent.",
        action: h("a", { class: "link sm", href: worstFirst() }, "Open worst-first"),
      }),
      meta.enabled || l2.scored
        ? scorerCard({
            title: "Layer 2 · model",
            sub: meta.enabled
              ? "Scored by " + meta.model + " against the same rubric, prompt " + meta.promptVersion
                + ". Cached by content, so unchanged text is never re-scored."
              : "Currently off: " + because(meta.reason, "the model layer is off")
                + ". These are the scores already stored.",
            stats: l2,
            cardTone: meta.enabled ? "" : "muted",
            note: "Only cases that have been through the model appear here — "
              + fmt.num(l2.queueDepth) + " open cases have no current model score.",
          })
        : h("div", { class: "card iqs-card scorer-card muted" },
            h("div", { class: "iqs-card-head" }, h("h3", {}, "Layer 2 · model")),
            h("p", { class: "hint" }, meta.reason),
            h("p", { class: "hint" },
              "Layer 1 above is unaffected: it never calls out, so every number on the "
              + "left is current. Set the gateway token and this column fills in.")));

    /* --- money and machinery ------------------------------------------ */

    const machinery = h("div", { class: "iqs-two" },
      h("div", { class: "card iqs-card" },
        h("div", { class: "iqs-card-head" }, h("h3", {}, "Budget")),
        budgetMeter(meta.budget),
        h("div", { class: "iqs-mini-facts" },
          fact("Queue depth", fmt.num(l2.queueDepth),
            "Open cases that cannot currently hold a valid score: never scored, "
            + "scored under an older rubric or prompt, or changed since."),
          fact("Decisions", fmt.num(decided + l2.skipped + l2.errors)),
          fact("Window", l2.windowDays + "d"))),
      sweepCard(meta, { onSweep: runSweep, busy: state.sweeping }));

    /* --- assemble ------------------------------------------------------ */

    mount(body,
      layer2Strip(meta),
      section("What the model costs",
        "The phase gate: hit rate and spend, both read from the append-only ledger rather "
        + "than inferred from the scores themselves.",
        gate, tokenStrip),
      section("The two scorers", null, scorers),
      section("Budget and sweep", null, machinery),
      section("Where they disagree",
        "Sorted by the size of the gap, because agreement is not news. Below the regex "
        + "usually means a template phrase satisfied a pattern and not a person; above it "
        + "means the pattern was harsher than a reader.",
        comparisons.length
          ? h("div", { class: "sc-head-inline" },
              h("a", { class: "link sm", href: casesHref(comparisons.map((c) => c.caseNumber)) },
                "Show these " + comparisons.length + " in the Queue"))
          : null,
        deltaTable(comparisons, (n) => navigate(caseHref(n)))),
      section("Recent decisions",
        "Every decision the store made, hits included — the ledger is what makes the hit "
        + "rate above recoverable at all.",
        activityList(activity)),
      section("Official scores (SentryAI)",
        "Phase 9's Tier 3 import: no authenticated SentryAI session has ever been reachable, "
        + "so this is the working floor — paste a CSV or a copied table from the IQS Report "
        + "page. Predicted and official are never averaged; they measure with different "
        + "dimensions and weights.",
        officialImportCard(load),
        (d.official || []).length
          ? h("div", { class: "sc-head-inline" },
              h("a", { class: "link sm", href: casesHref(d.official.map((c) => c.caseNumber)) },
                "Show these " + d.official.length + " in the Queue"))
          : null,
        officialTable(d.official || [], (n) => navigate(caseHref(n)))));
  }

  function tok(label, n) {
    return h("span", { class: "l2-tok", title: fmt.num(n) + " tokens" },
      h("b", { class: "mono" }, tokens(n)), " ", label);
  }

  load();

  return () => { disposed = true; };
}
