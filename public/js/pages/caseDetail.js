/**
 * Case detail — the page that has to make opening Salesforce unnecessary.
 *
 * Two constraints shape everything below.
 *
 * First, the whole history has to be readable here, so the timeline renders
 * every cached comment and email with nothing silently dropped. Where a body is
 * folded, the control says what it is hiding and always opens.
 *
 * Second, comment bodies arrive as Salesforce HTML written by customers. They
 * are converted to plain text and emitted as text nodes; no customer content
 * ever reaches innerHTML on this page. The only thing marked up is the search
 * term, and that mark is a DOM node, not a string.
 */

import { $, $$, h, mount, on, icon, copy, debounce } from "../lib/dom.js";
import { api, ApiError } from "../lib/api.js";
import * as store from "../lib/store.js";
import * as fmt from "../lib/fmt.js";
import { toast, emptyState, banner, button, skeletonRows } from "../lib/ui.js";
import { page } from "./_shared.js";
import { navigate, setQuery } from "../router.js";

/* ------------------------------------------------------------------ config */

const KEY_ORDER  = "queue.order";
const KEY_DRAFT  = "case.draft";
const KEY_TLPREF = "case.timelinePrefs";

const FOLD_LINES = 14;    // bodies longer than this fold, with the line count shown
const FOLD_CHARS = 1100;

const ICON_COPY = ["M9 9h10v10H9z", "M5 15V5h10"];
const ICON_OUT  = ["M14 4h6v6", "M20 4l-8 8", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"];
const ICON_PREV = ["M15 5l-7 7 7 7"];
const ICON_NEXT = ["M9 5l7 7-7 7"];

const TABS = [
  { id: "timeline",    label: "Timeline" },
  { id: "artifacts",   label: "Artifacts" },
  { id: "commitments", label: "Commitments" },
  { id: "related",     label: "Related" },
  { id: "draft",       label: "Draft" },
];

const COMMITMENT_TONE = {
  active: "",
  met: "ok",
  breached: "p0",
  unparsed: "purple",
  superseded: "neutral",
  dismissed: "neutral",
};

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

function decodeEntities(input) {
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
function htmlToText(input) {
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

function splitQuoted(text) {
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

function highlightInto(target, text, needle) {
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
function textNodes(text, needle, className = "tl-text") {
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

/* ----------------------------------------------------------------- helpers */

/** copy() resolves to its label; a clipboard write with no toast looks broken. */
function copyToast(text, label) {
  copy(text, label).then((m) => toast(m, "ok")).catch(() => toast("Could not copy", "error"));
}

const copyBtn = (text, label, title) =>
  h("button", {
    class: "copybtn",
    type: "button",
    title: title || "Copy",
    onclick: (e) => { e.stopPropagation(); copyToast(text, label); },
  }, icon(ICON_COPY, 13));

function lastActivity(c) {
  const stamps = [c.lastCustomerTouch, c.lastMyTouch, c.lastModifiedDate]
    .map((v) => (v ? Date.parse(v) : NaN))
    .filter((n) => Number.isFinite(n));
  return stamps.length ? Math.max(...stamps) : null;
}

function dueTone(dueAt, atRiskHours = 4) {
  const ms = dueAt ? Date.parse(dueAt) - Date.now() : NaN;
  if (!Number.isFinite(ms)) return "dim";
  if (ms < 0) return "red";
  if (ms < atRiskHours * 3600000) return "amber";
  return "";
}

function metaItem(label, ...value) {
  return h("div", { class: "cd-meta-item" },
    h("span", { class: "cd-meta-label", text: label }),
    h("div", { class: "cd-meta-value" }, value));
}

/* ------------------------------------------------------------------ render */

export function render(ctx, host, shell) {
  const caseNumber = ctx.params.caseNumber;

  const state = {
    detail: null,
    timeline: null,
    artifacts: null,
    related: null,
    tab: TABS.some((t) => t.id === ctx.query.tab) ? ctx.query.tab : "timeline",
    find: ctx.query.q || "",
    expanded: new Set(),
    expandAll: false,
    vis: "all",
    src: "all",
    order: "desc",
    ...store.get(KEY_TLPREF, {}),
  };

  const headHost = h("div", { class: "cd-head" }, h("div", { class: "skel", style: { height: "88px" } }));
  const tabStrip = h("div", { class: "cd-tabs" });
  const bodyHost = h("div", { class: "cd-body" }, skeletonRows(5));

  mount(host, page(headHost, tabStrip, bodyHost));

  /* ------------------------------------------------------------ prev/next */

  /**
   * The queue writes down the order you are actually looking at, so prev/next
   * walks that — your filters, your sort — rather than an order the server
   * would have picked. Arrive by URL without having opened the queue and the
   * controls are simply disabled, instead of jumping somewhere arbitrary.
   */
  function neighbours() {
    const saved = store.get(KEY_ORDER, null);
    const list = Array.isArray(saved?.numbers) ? saved.numbers : [];
    const at = list.indexOf(caseNumber);
    if (at === -1) return { prev: null, next: null, at: -1, total: list.length };
    return {
      prev: at > 0 ? list[at - 1] : null,
      next: at < list.length - 1 ? list[at + 1] : null,
      at,
      total: list.length,
    };
  }

  function goRelative(which) {
    const n = neighbours()[which];
    if (!n) { toast(which === "prev" ? "First case in the queue" : "Last case in the queue"); return; }
    navigate(`/case/${encodeURIComponent(n)}`);
  }

  /* ------------------------------------------------------------ data load */

  async function load() {
    try {
      const [detail, timeline] = await Promise.all([
        api.caseDetail(caseNumber),
        api.timeline(caseNumber).catch(() => null),
      ]);
      state.detail = detail;
      state.timeline = timeline;
      paintHead();
      paintTabs();
      paintBody();
    } catch (err) {
      const missing = err instanceof ApiError && err.status === 404;
      mount(headHost);
      mount(tabStrip);
      mount(bodyHost, missing
        ? emptyState({
            title: `Case ${caseNumber} is not in the cache`,
            message: "Either the number is wrong, or this case has never synced. A full resync from Settings will pull it if it is yours.",
            iconName: "search",
            action: button("Back to queue", { small: true, onclick: () => navigate("/") }),
          })
        : banner("error", err.message || "Could not load this case",
            button("Retry", { small: true, onclick: () => { mount(bodyHost, skeletonRows(5)); load(); } })));
    }
  }

  /* ----------------------------------------------------------- the header */

  function paintHead() {
    const c = state.detail.case;
    const age = fmt.ageDays(c.createdDate);
    const act = lastActivity(c);
    const nav = neighbours();
    const nc = c.nextCommitment;

    /**
     * There is no contact email field in the cache. Rather than leave the row
     * blank or invent one, use the address the contact actually writes from:
     * the most recent inbound message on the case.
     */
    const inbound = (state.timeline?.entries || [])
      .filter((e) => e.isInbound && e.authorEmail)
      .sort((a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate))[0];
    const contactEmail = inbound?.authorEmail || null;

    mount(headHost,
      h("div", { class: "cd-title-row" },
        h("span", { class: `chip ${fmt.priorityClass(c.priority)}`, text: c.priority || "—" }),
        h("span", { class: "cd-num mono", text: c.caseNumber }),
        copyBtn(c.caseNumber, "Case number copied", "Copy case number"),
        h("h1", { class: "cd-subject", text: c.subject || "(no subject)", title: c.subject || "" }),
        c.isEscalated ? h("span", { class: "chip p0", text: "Escalated" }) : null,
        c.isClosed ? h("span", { class: "chip neutral", text: "Closed" }) : null,
        h("div", { class: "cd-title-actions" },
          h("div", { class: "cd-stepper" },
            h("button", {
              class: "icon-btn", type: "button", disabled: !nav.prev,
              title: nav.prev ? `Previous in queue (${nav.prev})` : "No previous case in the queue order",
              onclick: () => goRelative("prev"),
            }, icon(ICON_PREV, 16)),
            nav.at >= 0
              ? h("span", { class: "cd-stepper-pos mono", text: `${nav.at + 1}/${nav.total}` })
              : null,
            h("button", {
              class: "icon-btn", type: "button", disabled: !nav.next,
              title: nav.next ? `Next in queue (${nav.next})` : "No next case in the queue order",
              onclick: () => goRelative("next"),
            }, icon(ICON_NEXT, 16))),
          button("Open in Salesforce", {
            small: true,
            iconPaths: ICON_OUT,
            title: "Goes through the server, so the org URL never ships to the browser",
            onclick: () => window.open(`/go/case/${encodeURIComponent(c.caseNumber)}`, "_blank", "noopener"),
          }))),

      h("div", { class: "cd-meta" },
        metaItem("Account", h("span", { text: c.account || "—" })),
        metaItem("Contact",
          h("span", { text: c.contactName || "—" }),
          contactEmail
            ? h("a", { class: "cd-mail", href: `mailto:${contactEmail}`, text: contactEmail })
            : null),
        metaItem("Status",
          h("span", { text: c.status || "—" }),
          c.needsMyReply ? h("span", { class: "chip ok", text: "Waiting on me" }) : null),
        metaItem("Created",
          h("span", { class: "mono", text: fmt.dateTime(c.createdDate) }),
          h("span", { class: `rel ${age.band ? "age-" + age.band : ""}`, text: age.days === null ? "" : `${age.days}d old` })),
        metaItem("Last activity",
          h("span", { class: "mono", text: act ? fmt.dateTime(act) : "—" }),
          h("span", { class: "rel", text: act ? fmt.relative(act) : "" })),
        metaItem("Next commitment",
          nc?.dueAt
            ? h("div", { class: "due-cell" },
                h("span", { class: `cd ${dueTone(nc.dueAt)}`, dataset: { countdown: nc.dueAt }, text: fmt.countdown(nc.dueAt) }),
                h("span", { class: "abs", text: fmt.dateTime(nc.dueAt) }))
            : h("span", { class: "dim", text: "None parsed" })),
        c.ncc
          ? metaItem("Next customer contact",
              h("span", { class: "mono", text: fmt.dateTime(c.ncc) }),
              h("span", { class: "rel", text: "Salesforce field" }))
          : null,
        metaItem("Product area", h("span", { text: c.productArea || "—" }))));

    tickCountdowns();
  }

  /* ------------------------------------------------------------- tabstrip */

  function tabCount(id) {
    if (id === "timeline") return state.timeline?.entries?.length ?? null;
    if (id === "commitments") return state.detail?.commitments?.length ?? null;
    if (id === "artifacts") {
      return state.artifacts
        ? state.artifacts.groups.reduce((n, g) => n + g.values.length, 0)
        : null;
    }
    if (id === "related") {
      return state.related
        ? (state.related.cases?.length || 0) + (state.related.jira?.length || 0)
        : null;
    }
    return null;
  }

  function paintTabs() {
    mount(tabStrip, TABS.map((t, i) => {
      const n = tabCount(t.id);
      return h("button", {
        class: `cd-tab ${state.tab === t.id ? "active" : ""}`,
        type: "button",
        title: `${t.label}  (press ${i + 1})`,
        onclick: () => selectTab(t.id),
      },
      h("span", { text: t.label }),
      n === null ? null : h("span", { class: "cd-tab-count mono", text: String(n) }));
    }));
  }

  function selectTab(id) {
    if (state.tab === id) return;
    state.tab = id;
    setQuery({ tab: id === "timeline" ? null : id });
    paintTabs();
    paintBody();
  }

  /* ----------------------------------------------------------- tab bodies */

  function paintBody() {
    if (state.tab === "timeline")    return paintTimeline();
    if (state.tab === "artifacts")   return paintArtifacts();
    if (state.tab === "commitments") return paintCommitments();
    if (state.tab === "related")     return paintRelated();
    if (state.tab === "draft")       return paintDraft();
    return undefined;
  }

  /* ---- timeline ---------------------------------------------------------- */

  const savePrefs = () =>
    store.set(KEY_TLPREF, { vis: state.vis, src: state.src, order: state.order });

  function visibleEntries() {
    const all = state.timeline?.entries || [];
    const needle = state.find.trim().toLowerCase();
    return all
      .filter((e) => {
        if (state.vis === "public" && !e.isPublic) return false;
        if (state.vis === "internal" && e.isPublic) return false;
        if (state.src !== "all" && e.source !== state.src) return false;
        if (!needle) return true;
        return `${e.subject || ""}\n${e.author || ""}\n${e._text || ""}`.toLowerCase().includes(needle);
      })
      .sort((a, b) => {
        const d = Date.parse(a.createdDate) - Date.parse(b.createdDate);
        return state.order === "desc" ? -d : d;
      });
  }

  function paintTimeline() {
    if (!state.timeline) {
      mount(bodyHost, banner("warn", "The timeline for this case could not be loaded.",
        button("Retry", { small: true, onclick: () => load() })));
      return;
    }

    const all = state.timeline.entries || [];
    // Convert once rather than on every repaint — some bodies run to several KB.
    for (const e of all) if (e._text === undefined) e._text = htmlToText(e.body);

    const pill = (group, value, label) => h("button", {
      class: `view-pill ${state[group] === value ? "active" : ""}`,
      type: "button",
      onclick: () => { state[group] = value; savePrefs(); paintTimeline(); },
    }, h("span", { text: label }));

    const findInput = h("input", {
      class: "queue-find",
      type: "search",
      placeholder: "Find in this case…",
      value: state.find,
      oninput: debounce((e) => {
        state.find = e.target.value;
        setQuery({ q: state.find || null });
        paintTimeline();
      }, 160),
    });

    const rows = visibleEntries();
    const needle = state.find.trim();
    const internal = all.filter((e) => !e.isPublic).length;

    mount(bodyHost,
      state.timeline.emailsUnavailable
        ? banner("warn", "Email bodies are not reachable for this case, so the timeline shows comments only.")
        : null,

      descriptionCard(needle),

      h("div", { class: "toolbar" },
        h("div", { class: "toolbar-row" },
          h("div", { class: "views" },
            pill("vis", "all", "All"),
            pill("vis", "public", "Public"),
            pill("vis", "internal", "Internal")),
          h("div", { class: "views" },
            pill("src", "all", "Everything"),
            pill("src", "comment", "Comments"),
            pill("src", "email", "Email")),
          h("div", { class: "spacer" }),
          findInput,
          button(state.order === "desc" ? "Newest first" : "Oldest first", {
            small: true,
            title: "Flip the chronological order",
            onclick: () => { state.order = state.order === "desc" ? "asc" : "desc"; savePrefs(); paintTimeline(); },
          }),
          button(state.expandAll ? "Collapse all" : "Expand all", {
            small: true,
            onclick: () => { state.expandAll = !state.expandAll; state.expanded.clear(); paintTimeline(); },
          }))),

      h("div", { class: "result-line" },
        h("span", { text: needle
          ? `${rows.length} of ${all.length} entries match “${needle}”`
          : `${rows.length} of ${all.length} entries` }),
        needle
          ? h("button", { class: "linkbtn", type: "button", text: "clear search",
              onclick: () => { state.find = ""; setQuery({ q: null }); paintTimeline(); } })
          : null,
        h("div", { class: "spacer" }),
        h("span", { class: "dim", text: `${internal} internal · ${all.length - internal} public` })),

      rows.length
        ? h("div", { class: "tl" }, rows.map((e) => entryCard(e, needle)))
        : emptyState({
            title: needle ? "Nothing matches that" : "No entries with those filters",
            message: needle
              ? "Try a shorter fragment — the search looks at message text, subject and author."
              : "Widen the visibility or source filter above to see the rest of the history.",
            iconName: "search",
            action: button("Reset filters", {
              small: true,
              onclick: () => {
                state.vis = "all"; state.src = "all"; state.find = "";
                savePrefs(); setQuery({ q: null }); paintTimeline();
              },
            }),
          }));
  }

  /** The customer's original problem statement, pinned above the history. */
  function descriptionCard(needle) {
    const text = htmlToText(state.detail.case.description);
    if (!text) return null;
    return h("div", { class: "card tl-desc" },
      h("div", { class: "tl-desc-head" },
        h("span", { class: "tl-desc-title", text: "Case description" }),
        h("span", { class: "dim", text: "as submitted" }),
        h("div", { class: "spacer" }),
        copyBtn(text, "Description copied", "Copy description")),
      folded("description", text, needle, state.expandAll));
  }

  /**
   * A body folds only when it is genuinely long, and the control always says how
   * much is underneath. The point is that you can tell there is more, not that
   * it looks tidy — a fold you cannot see is a truncation.
   */
  function folded(key, text, needle, forceOpen) {
    const lines = text.split("\n");
    const long = lines.length > FOLD_LINES || text.length > FOLD_CHARS;
    if (!long) return textNodes(text, needle);

    if (forceOpen || state.expanded.has(key)) {
      return h("div", {},
        textNodes(text, needle),
        h("button", {
          class: "linkbtn tl-more", type: "button", text: "Show less",
          onclick: () => { state.expanded.delete(key); paintBody(); },
        }));
    }

    return h("div", { class: "tl-folded" },
      textNodes(lines.slice(0, FOLD_LINES).join("\n"), needle),
      h("button", {
        class: "linkbtn tl-more",
        type: "button",
        text: `Show all ${lines.length} lines`,
        onclick: () => { state.expanded.add(key); paintBody(); },
      }));
  }

  const entryAsText = (e) => [
    `${e.author || "Unknown"} · ${fmt.dateTime(e.createdDate)} · ${e.isPublic ? "public" : "internal"} ${e.source}`,
    e.subject ? `Subject: ${e.subject}` : "",
    "",
    e._text || "",
  ].filter(Boolean).join("\n");

  function entryCard(e, needle) {
    const key = `e:${e.id}`;
    const split = splitQuoted(e._text || "");
    // A hit inside the quoted history is reason enough to open it.
    const quoteHasHit = Boolean(needle) && split.quoted.toLowerCase().includes(needle.toLowerCase());
    const quoteOpen = state.expanded.has(`${key}:q`) || quoteHasHit;

    return h("article", {
      class: `tl-entry ${e.isPublic ? "is-public" : "is-internal"} ${e.isMine ? "is-mine" : ""}`,
      id: `tl-${e.id}`,
    },
      h("div", { class: "tl-rail" }),
      h("div", { class: "tl-main" },
        h("header", { class: "tl-head" },
          h("span", { class: "tl-author", text: e.author || "Unknown" }),
          e.isMine ? h("span", { class: "chip ok tl-badge", text: "me" }) : null,
          h("span", { class: `chip tl-badge ${e.isPublic ? "neutral" : "purple"}`,
            text: e.isPublic ? "Public" : "Internal" }),
          h("span", { class: "chip tl-badge neutral", text: e.source === "email" ? "Email" : "Comment" }),
          e.isInbound ? h("span", { class: "chip tl-badge", text: "Inbound" }) : null,
          h("div", { class: "spacer" }),
          h("time", { class: "mono tl-when", dateTime: e.createdDate, text: fmt.dateTime(e.createdDate) }),
          h("span", { class: "rel", text: fmt.relative(e.createdDate) }),
          copyBtn(entryAsText(e), "Entry copied", "Copy this entry")),

        e.subject ? textNodes(e.subject, needle, "tl-subject") : null,

        split.body
          ? folded(key, split.body, needle, Boolean(needle) || state.expandAll)
          : h("div", { class: "tl-empty dim", text: e.subject
              ? "No body on this message — the subject line is all Salesforce holds."
              : "This entry has no content in the cache." }),

        split.quoted
          ? h("div", { class: "tl-quote" },
              h("button", {
                class: "linkbtn", type: "button",
                text: quoteOpen
                  ? "Hide quoted history"
                  : `Show quoted history (${split.quoted.split("\n").length} lines)`,
                onclick: () => {
                  const k = `${key}:q`;
                  if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
                  paintBody();
                },
              }),
              quoteOpen ? textNodes(split.quoted, needle, "tl-text tl-quoted") : null)
          : null));
  }

  /* ---- artifacts --------------------------------------------------------- */

  async function paintArtifacts() {
    if (!state.artifacts) {
      mount(bodyHost, skeletonRows(4, [120, 200, 200, 160]));
      try {
        state.artifacts = await api.artifacts(caseNumber);
        paintTabs();
      } catch (err) {
        mount(bodyHost, banner("error", err.message || "Could not load artifacts",
          button("Retry", { small: true, onclick: () => paintArtifacts() })));
        return;
      }
      if (state.tab !== "artifacts") return;   // the tab changed while fetching
    }

    const c = state.detail.case;

    /**
     * The Salesforce fields sit alongside the extracted artifacts because in
     * practice they answer the same question — what am I actually looking at —
     * and both want the same one-click copy.
     */
    const caseFields = [
      ["Case number", c.caseNumber],
      ["Account", c.account],
      ["Contact", c.contactName],
      ["Owner", c.owner],
      ["Type", c.type],
      ["Origin", c.origin],
      ["Component", c.component],
      ["Sub-component", c.subComponent],
      ["Product area", c.productArea],
      ["Labels", c.labels],
      ["Error signature", c.errorSignature],
      ["Queue", c.queue],
      ["SLA", c.sla],
      ["Salesforce ID", c.id],
    ].filter(([, v]) => v !== null && v !== undefined && v !== "");

    const extracted = state.artifacts.groups || [];

    const groups = [
      { label: "Case fields", pairs: caseFields },
      ...extracted.map((g) => ({
        label: g.label,
        flat: true,
        pairs: g.values.map((v) => [g.label, v]),
      })),
    ];

    mount(bodyHost,
      h("div", { class: "hint", style: { marginBottom: "12px" } },
        "Cluster IDs, versions and node counts pulled out of the case history, next to the Salesforce fields. Every value copies with one click."),

      h("div", { class: "art-grid" }, groups.map((g) => h("div", { class: "card art-card" },
        h("div", { class: "art-head" },
          h("span", { class: "art-title", text: g.label }),
          h("div", { class: "spacer" }),
          button("Copy all", {
            small: true,
            onclick: () => copyToast(
              g.pairs.map(([k, v]) => (g.flat ? String(v) : `${k}: ${v}`)).join("\n"),
              `${g.label} copied`),
          })),
        h("div", { class: "art-rows" }, g.pairs.map(([k, v]) => h("div", { class: "art-row" },
          g.flat ? null : h("span", { class: "art-key", text: k }),
          h("span", { class: `art-val mono ${g.flat ? "wide" : ""}`, text: String(v) }),
          copyBtn(String(v), `${g.flat ? g.label : k} copied`))))))),

      extracted.length ? null : h("div", { class: "art-none" }, emptyState({
        title: "Nothing extracted yet",
        message: "No cluster IDs, versions or node counts were found in this case's history. The Salesforce fields above are still here.",
        iconName: "search",
      })));
  }

  /* ---- commitments ------------------------------------------------------- */

  function paintCommitments() {
    const rows = [...(state.detail.commitments || [])];
    if (!rows.length) {
      mount(bodyHost, emptyState({
        title: "No commitments on this case",
        message: "Nothing in the history parsed as a follow-up deadline. If you have promised a time, the Commitments page can record it by hand.",
        iconName: "clock",
        action: button("Open Commitments", { small: true, onclick: () => navigate("/commitments") }),
      }));
      return;
    }

    const rank = { active: 0, unparsed: 1, breached: 2, superseded: 3, met: 4, dismissed: 5 };
    rows.sort((a, b) => {
      const r = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
      return r || (Date.parse(b.dueAt) || 0) - (Date.parse(a.dueAt) || 0);
    });

    const active = rows.filter((r) => r.state === "active");
    const inTimeline = new Set((state.timeline?.entries || []).map((e) => e.id));

    const jumpToSource = (cm) => {
      if (!cm.sourceCommentId || !inTimeline.has(cm.sourceCommentId)) {
        toast("The comment this came from is not in the cached timeline");
        return;
      }
      state.find = "";
      state.vis = "all";
      state.src = "all";
      state.expandAll = true;
      setQuery({ q: null });
      selectTab("timeline");
      requestAnimationFrame(() => {
        const el = document.getElementById(`tl-${cm.sourceCommentId}`);
        if (!el) return;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("tl-flash");
        setTimeout(() => el.classList.remove("tl-flash"), 1600);
      });
    };

    mount(bodyHost,
      active.length > 1
        ? banner("error",
            `${active.length} commitments are live on this case at once. Only one deadline should be active — renegotiate or close the others out.`,
            button("Open Commitments", { small: true, onclick: () => navigate("/commitments") }))
        : null,

      h("div", { class: "hint", style: { marginBottom: "12px" } },
        "Parsed out of the case history. Editing, renegotiating and manual entry live on the Commitments page."),

      h("div", { class: "cm-list" }, rows.map((cm) => h("div", { class: `card cm-card st-${cm.state}` },
        h("div", { class: "cm-top" },
          h("span", { class: `chip ${COMMITMENT_TONE[cm.state] ?? "neutral"}`, text: cm.state }),
          cm.dueAt
            ? h("div", { class: "due-cell" },
                h("span", {
                  class: `cd ${cm.state === "active" ? dueTone(cm.dueAt) : "dim"}`,
                  dataset: cm.state === "active" ? { countdown: cm.dueAt } : {},
                  text: cm.state === "active" ? fmt.countdown(cm.dueAt) : fmt.relative(cm.dueAt),
                }),
                h("span", { class: "abs", text: fmt.dateTime(cm.dueAt) }))
            : h("span", { class: "dim", text: "No date parsed" }),
          h("div", { class: "spacer" }),
          cm.metAt ? h("span", { class: "rel", text: `met ${fmt.dateTime(cm.metAt)}` }) : null,
          cm.supersededBy ? h("span", { class: "chip neutral", text: "superseded" }) : null,
          cm.sourceCommentId
            ? h("button", { class: "linkbtn", type: "button", text: "jump to source",
                onclick: () => jumpToSource(cm) })
            : null,
          copyBtn(htmlToText(cm.rawText), "Commitment text copied")),

        cm.rawText ? textNodes(htmlToText(cm.rawText), "", "cm-raw") : null,
        cm.note ? h("div", { class: "cm-note", text: cm.note }) : null))));

    tickCountdowns();
  }

  /* ---- related ----------------------------------------------------------- */

  async function paintRelated() {
    if (!state.related) {
      mount(bodyHost, skeletonRows(5));
      try {
        state.related = await api.related(caseNumber);
        paintTabs();
      } catch (err) {
        mount(bodyHost, banner("error", err.message || "Could not load related cases",
          button("Retry", { small: true, onclick: () => paintRelated() })));
        return;
      }
      if (state.tab !== "related") return;
    }

    const cases = state.related.cases || [];
    const jira = state.related.jira || [];

    if (!cases.length && !jira.length) {
      mount(bodyHost, emptyState({
        title: "Nothing related in the cache",
        message: "No other case on this account, in this product area, or sharing an error signature.",
        iconName: "search",
      }));
      return;
    }

    const groups = new Map();
    for (const c of cases) {
      const k = c.relation || "Related";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }

    mount(bodyHost,
      [...groups].map(([label, items]) => h("div", { class: "card rel-card" },
        h("div", { class: "art-head" },
          h("span", { class: "art-title", text: label }),
          h("span", { class: "cd-tab-count mono", text: String(items.length) })),
        h("table", { class: "tbl" },
          h("tbody", {}, items.map((c) => h("tr", { class: "row" },
            h("td", { class: "cell-num" },
              h("span", { class: `chip ${fmt.priorityClass(c.priority)}`, text: c.priority || "—" })),
            h("td", { class: "cell-num" },
              h("a", { class: "mono", href: `/case/${encodeURIComponent(c.caseNumber)}`, text: c.caseNumber })),
            h("td", { class: "cell-subject", text: c.subject || "—", title: c.subject || "" }),
            h("td", { class: "nowrap muted", text: c.account || "" }),
            h("td", { class: "nowrap muted", text: c.status || "" }),
            h("td", { class: "nowrap mono dim", text: fmt.dateShort(c.createdDate) }),
            h("td", { class: "right" },
              c.isClosed ? h("span", { class: "chip neutral", text: "Closed" }) : null))))))),

      jira.length
        ? h("div", { class: "card rel-card" },
            h("div", { class: "art-head" },
              h("span", { class: "art-title", text: "Engineering tickets" }),
              h("span", { class: "cd-tab-count mono", text: String(jira.length) })),
            h("div", { class: "hint jira-warn" },
              "Internal reference only. Do not put a ticket ID in a customer-facing reply — describe the fix and the version it lands in instead."),
            h("div", { class: "art-rows" }, jira.map((j) => {
              const key = j.key || j.id || String(j);
              const url = typeof j.url === "string" && /^https?:\/\//.test(j.url) ? j.url : null;
              return h("div", { class: "art-row" },
                url
                  ? h("a", { class: "mono", href: url, target: "_blank", rel: "noopener noreferrer", text: key })
                  : h("span", { class: "mono", text: key }),
                h("span", { class: "art-val", text: j.summary || j.status || "" }),
                copyBtn(key, "Ticket key copied"));
            })))
        : null);
  }

  /* ---- draft ------------------------------------------------------------- */

  /**
   * A staging area, deliberately not a writer. The actual customer response is
   * composed elsewhere; what this tab owes you is somewhere to assemble text, a
   * skeleton to start from, and a copy that always works. Nothing here is sent.
   */
  const todayLong = () => new Intl.DateTimeFormat("en-US", {
    timeZone: fmt.TZ, weekday: "long", month: "long", day: "2-digit", year: "numeric",
  }).format(new Date());

  const TEMPLATES = {
    INTRO: (c) => [
      `Hello ${c.contactName || "there"},`,
      "",
      `Thank you for contacting Rubrik Support. My name is ${c.owner || "[name]"} and I will be the engineer working with you on case ${c.caseNumber}, "${c.subject || ""}".`,
      "",
      "So that we are aligned, here is my understanding:",
      "  - [the problem, in one sentence]",
      "  - [impact: what is not working, and for whom]",
      "  - [what has already been tried]",
      "",
      "To take the next step I will need [specific logs / cluster ID / time window].",
      "",
      `I will follow up with you by 6:00 PM EST today, ${todayLong()}.`,
      "",
      "Best regards,",
      c.owner || "",
    ].join("\n"),

    UPDATE: (c) => [
      `Hello ${c.contactName || "there"},`,
      "",
      `An update on case ${c.caseNumber}:`,
      "",
      "  - What we found: [finding]",
      "  - What it means: [impact in the customer's terms]",
      "  - What happens next: [action, and who owns it]",
      "",
      `I will follow up with you by 6:00 PM EST today, ${todayLong()}.`,
      "",
      "Best regards,",
      c.owner || "",
    ].join("\n"),

    CLOSURE: (c) => [
      `Hello ${c.contactName || "there"},`,
      "",
      `I believe we can now close case ${c.caseNumber}, "${c.subject || ""}".`,
      "",
      "  - Root cause: [cause]",
      "  - Resolution: [what changed, and in which version]",
      "  - Preventing recurrence: [guidance]",
      "",
      "If you are happy with the outcome I will close the case. If anything is still outstanding, reply here and it stays open.",
      "",
      "Best regards,",
      c.owner || "",
    ].join("\n"),
  };

  const summaryText = (c) => [
    `Case ${c.caseNumber} — ${c.subject || ""}`,
    `Account: ${c.account || "—"}   Contact: ${c.contactName || "—"}`,
    `Priority: ${c.priority || "—"}   Status: ${c.status || "—"}`,
    `Opened: ${fmt.dateTime(c.createdDate)}`,
    c.nextCommitment?.dueAt
      ? `Next commitment: ${fmt.dateTime(c.nextCommitment.dueAt)}`
      : "Next commitment: none parsed",
    `QView: ${location.origin}/case/${c.caseNumber}`,
  ].join("\n");

  function paintDraft() {
    const c = state.detail.case;
    const key = `${KEY_DRAFT}.${caseNumber}`;

    const meta = h("div", { class: "draft-meta" });
    const area = h("textarea", {
      class: "input draft-area",
      spellcheck: "true",
      placeholder: "Stage your reply here. Nothing is sent from this page — it holds text and copies it.",
    });
    area.value = store.get(key, "");

    const paintMeta = () => {
      const v = area.value;
      const words = v.trim() ? v.trim().split(/\s+/).length : 0;
      mount(meta,
        h("span", { class: "dim", text: `${v.length} characters · ${words} words` }),
        h("div", { class: "spacer" }),
        h("span", { class: "dim", text: v ? "Saved in this browser" : "Nothing staged yet" }));
    };
    area.oninput = debounce(() => { store.set(key, area.value); paintMeta(); }, 300);
    paintMeta();

    const insert = (name) => {
      if (area.value.trim() &&
          !confirm(`Replace the ${area.value.length} characters already staged with the ${name} skeleton?`)) return;
      area.value = TEMPLATES[name](c);
      store.set(key, area.value);
      paintMeta();
      area.focus();
      area.setSelectionRange(0, 0);
      toast(`${name} skeleton inserted`, "ok");
    };

    mount(bodyHost,
      h("div", { class: "card draft-card" },
        h("div", { class: "art-head" },
          h("span", { class: "art-title", text: "Draft" }),
          h("div", { class: "spacer" }),
          button("INTRO", { small: true, onclick: () => insert("INTRO") }),
          button("UPDATE", { small: true, onclick: () => insert("UPDATE") }),
          button("CLOSURE", { small: true, onclick: () => insert("CLOSURE") })),

        h("div", { class: "hint", style: { marginBottom: "10px" } },
          "This tab stages and copies text. It does not write the reply for you and it never sends anything — paste the finished version into Salesforce yourself."),

        area,
        meta,

        h("div", { class: "draft-actions" },
          button("Copy draft", {
            kind: "primary", small: true,
            onclick: () => {
              if (!area.value.trim()) { toast("Nothing to copy"); return; }
              copyToast(area.value, "Draft copied");
            },
          }),
          button("Copy case summary", {
            small: true,
            title: "Case number, account, status and the next deadline",
            onclick: () => copyToast(summaryText(c), "Summary copied"),
          }),
          h("div", { class: "spacer" }),
          button("Clear", {
            small: true, kind: "danger",
            onclick: () => {
              if (!area.value) return;
              if (!confirm("Discard the staged draft for this case?")) return;
              area.value = "";
              store.remove(key);
              paintMeta();
            },
          }))));
  }

  /* ---------------------------------------------------------- live clocks */

  function tickCountdowns() {
    for (const el of $$("[data-countdown]", host)) {
      const at = el.dataset.countdown;
      el.textContent = fmt.countdown(at);
      const tone = dueTone(at);
      el.classList.toggle("red", tone === "red");
      el.classList.toggle("amber", tone === "amber");
    }
  }
  const timer = setInterval(tickCountdowns, 30000);

  /* ------------------------------------------------------------- keyboard */

  shell.setPageKeys((e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    const n = TABS.findIndex((_, i) => String(i + 1) === e.key);
    if (n >= 0) { selectTab(TABS[n].id); return true; }

    if (e.key === "[") { goRelative("prev"); return true; }
    if (e.key === "]") { goRelative("next"); return true; }
    if (e.key === "o") {
      window.open(`/go/case/${encodeURIComponent(caseNumber)}`, "_blank", "noopener");
      return true;
    }
    if (e.key === "f") {
      if (state.tab !== "timeline") selectTab("timeline");
      const el = $(".queue-find", bodyHost);
      if (el) { el.focus(); el.select(); }
      return true;
    }
    return false;
  });

  /* A related case is an internal navigation, not a page load. */
  on(bodyHost, "click", "a[href^='/case/']", (e, el) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(el.getAttribute("href"));
  });

  load();

  return () => clearInterval(timer);
}
