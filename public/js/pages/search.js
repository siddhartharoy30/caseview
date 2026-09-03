/**
 * Search — full text across every cached subject, description and comment.
 *
 * The question this page exists to answer is "have I seen this PKIX error
 * before", and that question is only worth asking if the answer arrives while
 * you are still thinking about it. The server does the work in FTS5 and
 * returns matches already grouped by case; this page's job is to render them
 * fast and to make the matched text legible.
 *
 * Three decisions worth writing down:
 *
 * 1. Snippets arrive as HTML. The server wraps each hit in <mark>…</mark>, and
 *    the text around it is whatever the customer's mail client produced —
 *    <br/>, &nbsp;, stray <div>s. Both have to be handled, and they have to be
 *    handled differently: the marks are ours and must render, the rest is
 *    customer data and must not. So the marks are swapped for two control
 *    characters, the whole string goes through htmlToText like every other
 *    piece of customer content in this app, and the nodes are rebuilt from the
 *    sentinels afterwards. Nothing is ever assigned to innerHTML.
 *
 * 2. A match links to /case/NUM?q=<term>, not to a bare case. The case detail
 *    page already reads `q` as a timeline find and highlights it, so following
 *    a result lands on the case with the term lit up rather than at the top of
 *    six hundred comments with the search forgotten.
 *
 * 3. The scope filter is client-side. The server returns the whole grouped set;
 *    narrowing to open cases is a predicate over rows already in hand, so it is
 *    instant and cannot disagree with the count beside it. Re-querying the
 *    server for a filter it already answered would be slower and no truer.
 */

import { h, mount, debounce } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as store from "../lib/store.js";
import * as fmt from "../lib/fmt.js";
import { banner, button, emptyState, copyBtn } from "../lib/ui.js";
import { htmlToText } from "../lib/text.js";
import { pageHead, page } from "./_shared.js";
import { setQuery } from "../router.js";

/* ------------------------------------------------------------------ config */

const KEY_PREFS = "search.prefs";

/** Long enough that a stray keystroke does not fire, short enough to feel live. */
const DEBOUNCE_MS = 180;

/** FTS on a one-character term matches most of the corpus and helps nobody. */
const MIN_CHARS = 2;

const ICON_SEARCH = ["circle:11,11,7", "M20 20l-3.5-3.5"];

const SCOPES = [
  { id: "all", label: "All cases" },
  { id: "open", label: "Open only" },
];

const SORTS = [
  { id: "relevance", label: "Relevance" },
  { id: "matches", label: "Most hits" },
  { id: "recent", label: "Newest case" },
];

/**
 * Where a hit landed. The server's vocabulary is subject / email / comment /
 * internal note; these are the labels and the tone each gets.
 */
const WHERE = {
  subject: { label: "Subject", tone: "purple" },
  email: { label: "Email", tone: "p3" },
  comment: { label: "Comment", tone: "neutral" },
  "internal note": { label: "Internal note", tone: "" },
};

/* -------------------------------------------------------------- snippet →  */

const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

/**
 * Server HTML in, safe nodes out, with the highlight preserved.
 *
 * The two sentinels survive htmlToText because they are not tags and not
 * entities, which is the whole trick: it lets the customer's markup be
 * stripped by the same function used everywhere else, without losing track of
 * where our own highlight was.
 */
function stripSentinels(s) {
  return s.replace(/[\u0001\u0002]/g, "");
}

function snippetNodes(snippet) {
  const swapped = String(snippet || "")
    .replace(/<mark>/gi, MARK_OPEN)
    .replace(/<\/mark>/gi, MARK_CLOSE);
  const text = htmlToText(swapped).replace(/\s+/g, " ").trim();

  const out = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf(MARK_OPEN, at);
    if (open === -1) break;
    const close = text.indexOf(MARK_CLOSE, open + 1);
    if (close === -1) break;
    if (open > at) out.push(document.createTextNode(text.slice(at, open)));
    out.push(h("mark", { text: text.slice(open + 1, close) }));
    at = close + 1;
  }
  if (at < text.length) {
    out.push(document.createTextNode(stripSentinels(text.slice(at))));
  }
  return out.length ? out : [document.createTextNode(stripSentinels(text))];
}

/* ------------------------------------------------------------------ pieces */

function matchRow(row, m, term) {
  const meta = WHERE[m.where] || { label: m.where || "Match", tone: "" };
  const href = "/case/" + encodeURIComponent(row.caseNumber) +
    (term ? "?q=" + encodeURIComponent(term) : "");
  return h("a", { class: "sr-match", href },
    h("div", { class: "sr-match-head" },
      h("span", { class: "chip " + meta.tone, text: meta.label }),
      m.author ? h("span", { class: "sr-author", text: m.author }) : null,
      m.createdDate
        ? h("span", { class: "sr-when", title: fmt.dateTime(m.createdDate), text: fmt.dateTimeShort(m.createdDate) })
        : null),
    h("p", { class: "sr-snippet" }, snippetNodes(m.snippet)));
}

function resultCard(row, term) {
  const matches = row.matches || [];
  const shown = matches.length;
  const extra = (row.matchCount || shown) - shown;
  const href = "/case/" + encodeURIComponent(row.caseNumber) +
    (term ? "?q=" + encodeURIComponent(term) : "");

  return h("article", { class: "sr-card" + (row.isClosed ? " closed" : "") },
    h("header", { class: "sr-head" },
      h("a", { class: "mono sr-num", href, text: row.caseNumber }),
      copyBtn(row.caseNumber, "Case number", "Copy case number"),
      h("span", { class: "chip " + fmt.priorityClass(row.priority), text: row.priority || "—" }),
      h("span", { class: "chip " + (row.isClosed ? "ok" : "neutral"), text: row.status || "—" }),
      h("span", { class: "spacer" }),
      h("span", { class: "sr-count", text: (row.matchCount || shown) + (row.matchCount === 1 ? " hit" : " hits") })),
    h("a", { class: "sr-subject", href, title: row.subject || "", text: row.subject || "(no subject)" }),
    h("div", { class: "sr-account" },
      h("strong", { text: row.account || "—" }),
      row.productArea ? h("span", { class: "dim", text: " · " + row.productArea }) : null),
    h("div", { class: "sr-matches" }, matches.map((m) => matchRow(row, m, term))),
    extra > 0
      ? h("a", { class: "sr-more link", href, text: extra + " more " + (extra === 1 ? "match" : "matches") + " in this case" })
      : null);
}

/* ------------------------------------------------------------------ render */

export function render(ctx, host, shell) {
  const prefs = store.get(KEY_PREFS, {});
  const q0 = (ctx.query && ctx.query.q) || "";

  const state = {
    term: q0,
    ran: "",           // the term the current rows actually answer
    rows: [],
    tookMs: null,
    loading: false,
    error: null,
    scope: (ctx.query && ctx.query.scope) || prefs.scope || "all",
    sort: (ctx.query && ctx.query.sort) || prefs.sort || "relevance",
  };

  const bodyHost = h("div", {});
  const bannerHost = h("div", {});
  const input = h("input", {
    class: "sr-input",
    type: "search",
    placeholder: "Search subjects, descriptions and every cached comment…",
    value: q0,
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Search cached case history",
  });
  let disposed = false;
  let seq = 0;

  function savePrefs() {
    store.set(KEY_PREFS, { scope: state.scope, sort: state.sort });
  }

  /* ----------------------------------------------------------------- data */

  async function run() {
    const term = state.term.trim();
    setQuery({ q: term || null, scope: state.scope === "all" ? null : state.scope,
      sort: state.sort === "relevance" ? null : state.sort });

    if (term.length < MIN_CHARS) {
      state.rows = []; state.ran = ""; state.tookMs = null;
      state.loading = false; state.error = null;
      paint();
      return;
    }

    const mine = ++seq;
    state.loading = true;
    paint();
    try {
      const data = await api.search(term);
      // A slow answer to an abandoned query must not overwrite a fast answer to
      // the current one. Typing outruns the network on a short term.
      if (disposed || mine !== seq) return;
      state.rows = data.results || [];
      state.tookMs = typeof data.tookMs === "number" ? data.tookMs : null;
      state.ran = term;
      state.error = null;
    } catch (err) {
      if (disposed || mine !== seq) return;
      state.error = err;
    }
    state.loading = false;
    paint();
  }

  const runSoon = debounce(run, DEBOUNCE_MS);

  /* -------------------------------------------------------------- toolbar */

  function segmented(items, current, onpick) {
    return h("div", { class: "seg" }, items.map((it) =>
      h("button", {
        class: "seg-btn" + (it.id === current ? " on" : ""),
        type: "button",
        text: it.label,
        onclick: () => onpick(it.id),
      })));
  }

  function toolbar() {
    return h("div", { class: "toolbar sr-toolbar" },
      h("div", { class: "sr-field" },
        h("svg", { class: "sr-icon", viewBox: "0 0 24 24", "aria-hidden": "true" },
          h("circle", { cx: "11", cy: "11", r: "7" }),
          h("path", { d: "M20 20l-3.5-3.5" })),
        input,
        state.term
          ? h("button", {
              class: "sr-clear", type: "button", title: "Clear", text: "×",
              onclick: () => { state.term = ""; input.value = ""; input.focus(); run(); },
            })
          : null),
      h("div", { class: "tb-label", text: "Scope" }),
      segmented(SCOPES, state.scope, (id) => { state.scope = id; savePrefs(); run(); }),
      h("div", { class: "tb-label", text: "Sort" }),
      segmented(SORTS, state.sort, (id) => { state.sort = id; savePrefs(); paint(); setQuery({ sort: id === "relevance" ? null : id }); }));
  }

  /* ---------------------------------------------------------------- paint */

  function visibleRows() {
    let rows = state.rows;
    if (state.scope === "open") rows = rows.filter((r) => !r.isClosed);
    if (state.sort === "matches") {
      rows = rows.slice().sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0));
    } else if (state.sort === "recent") {
      rows = rows.slice().sort((a, b) => String(b.caseNumber).localeCompare(String(a.caseNumber)));
    }
    return rows;
  }

  function results() {
    const term = state.term.trim();

    if (term.length < MIN_CHARS) {
      return emptyState({
        title: term ? "Keep typing" : "Search the cache, not Salesforce",
        message: term
          ? "Two characters or more. A single letter matches most of the corpus and tells you nothing."
          : "Every subject, description and comment already pulled down is indexed locally. Type an error string, a hostname, a KB number — whatever you would have pasted into Salesforce global search.",
        iconName: "search",
      });
    }

    if (state.loading && !state.ran) {
      return h("div", { class: "sr-list" },
        [0, 1, 2].map(() => h("div", { class: "sr-card skeleton-card" },
          h("div", { class: "sk-line w40" }), h("div", { class: "sk-line w80" }),
          h("div", { class: "sk-line w70" }), h("div", { class: "sk-line w60" }))));
    }

    if (state.error) {
      return emptyState({
        title: "Search failed",
        message: state.error.message || "The server did not answer.",
        iconName: "alert",
        kind: "error",
        action: button("Try again", { kind: "primary", onclick: () => run() }),
      });
    }

    const rows = visibleRows();
    const hidden = state.rows.length - rows.length;

    if (!rows.length) {
      return emptyState({
        title: "No matches for “" + state.ran + "”",
        message: hidden
          ? hidden + " closed " + (hidden === 1 ? "case matches" : "cases match") + ". Switch the scope to All cases to see them."
          : "Nothing in the cached history contains that. If the case is older than the sync window it was never pulled down — widen the closed-case window in Settings and run a full resync.",
        iconName: "search",
        action: hidden
          ? button("Include closed cases", { kind: "primary", onclick: () => { state.scope = "all"; savePrefs(); run(); } })
          : button("Open Settings", { onclick: () => shell.navigate("/settings") }),
      });
    }

    const matches = rows.reduce((n, r) => n + (r.matchCount || (r.matches || []).length), 0);

    return h("div", {},
      h("div", { class: "result-line" },
        h("strong", { text: String(rows.length) }),
        rows.length === 1 ? " case" : " cases",
        h("span", { class: "dim", text: " · " + matches + (matches === 1 ? " match" : " matches") }),
        state.tookMs !== null
          ? h("span", { class: "dim", text: " · " + state.tookMs + " ms" })
          : null,
        hidden
          ? h("span", { class: "dim", text: " · " + hidden + " closed hidden" })
          : null,
        h("span", { class: "spacer" }),
        state.loading ? h("span", { class: "dim", text: "searching…" }) : null),
      h("div", { class: "sr-list" }, rows.map((r) => resultCard(r, state.ran))));
  }

  function paint() {
    mount(bodyHost, toolbar(), results());
    // Rebuilding the toolbar re-parents the same input node, so the caret and
    // selection survive; what does not survive is focus, and losing focus
    // mid-word would make the page unusable.
    if (document.activeElement !== input && state.term) {
      const at = input.value.length;
      input.focus();
      try { input.setSelectionRange(at, at); } catch { /* type=search on old engines */ }
    }
  }

  /* ----------------------------------------------------------------- boot */

  input.addEventListener("input", () => { state.term = input.value; runSoon(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); run(); }
    if (e.key === "Escape" && input.value) {
      e.preventDefault();
      state.term = ""; input.value = ""; run();
    }
  });

  mount(host, page(
    pageHead(
      "Search",
      "Full text across every subject, description and comment in the local cache.",
      [button("Search", { small: true, iconPaths: ICON_SEARCH, onclick: () => run() })]),
    bannerHost,
    bodyHost));

  mount(bannerHost, banner("info",
    "This searches the local cache only. Anything never synced — closed beyond the retention window, or owned by someone else — is not in here."));

  paint();
  if (q0.trim().length >= MIN_CHARS) run();
  input.focus();

  // `/` is taken by the global find; on this page the search box is the find,
  // so the page handler claims it and puts the caret where it belongs.
  shell.setPageKeys((e) => {
    if (e.key === "/") { input.focus(); input.select(); return true; }
    return false;
  });

  return () => {
    disposed = true;
    shell.setPageKeys(null);
  };
}
