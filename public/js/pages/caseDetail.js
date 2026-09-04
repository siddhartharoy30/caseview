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

import { $, $$, h, mount, on, icon, debounce } from "../lib/dom.js";
import { api, ApiError } from "../lib/api.js";
import * as store from "../lib/store.js";
import * as fmt from "../lib/fmt.js";
import {
  toast, emptyState, banner, button, skeletonRows, copyBtn, copyToast,
} from "../lib/ui.js";
import { htmlToText, splitQuoted, textNodes } from "../lib/text.js";
import {
  scoreMeter, bandChip, bandExplain,
  tone as iqsTone, KEYWORD_LABEL, KEYWORD_HINT,
} from "../lib/iqs.js";
import { page } from "./_shared.js";
import { navigate, setQuery } from "../router.js";

/* ------------------------------------------------------------------ config */

const KEY_ORDER  = "queue.order";
const KEY_DRAFT  = "case.draft";
const KEY_TLPREF = "case.timelinePrefs";

const FOLD_LINES = 14;    // bodies longer than this fold, with the line count shown
const FOLD_CHARS = 1100;

const ICON_OUT  = ["M14 4h6v6", "M20 4l-8 8", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"];
const ICON_PREV = ["M15 5l-7 7 7 7"];
const ICON_NEXT = ["M9 5l7 7-7 7"];

/*
 * Quality goes last rather than next to Timeline, and that is a deliberate
 * cost. The number-key shortcut is the tab's index, so any insertion silently
 * remaps every shortcut after it — muscle memory for "5 is Draft" would break
 * for a tab that is read occasionally, not constantly. Appending keeps 1..5
 * where they were and gives Quality 6.
 */
const TABS = [
  { id: "timeline",    label: "Timeline" },
  { id: "artifacts",   label: "Artifacts" },
  { id: "commitments", label: "Commitments" },
  { id: "related",     label: "Related" },
  { id: "draft",       label: "Draft" },
  { id: "iqs",         label: "Quality" },
];

const COMMITMENT_TONE = {
  active: "",
  met: "ok",
  breached: "p0",
  unparsed: "purple",
  superseded: "neutral",
  dismissed: "neutral",
};

/* ----------------------------------------------------------------- helpers */

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
    iqs: null,
    iqsOpen: new Set(),
    draftKeyword: null,     // null = auto-detect, else an override
    draftScore: null,       // last predicted score for the staged text, or null
    draftScoring: false,
    draftBusy: false,       // generating or repairing — guards against overlap
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
    /*
     * The badge here is the score, not a count of anything — it is the one
     * number worth seeing without opening the tab. An unscorable case shows no
     * badge rather than a zero, because zero is a score and "nothing of mine
     * to score" is not.
     */
    if (id === "iqs") {
      const s = state.iqs?.score ?? state.detail?.case?.iqs;
      return s && s.overall !== null && s.overall !== undefined ? Math.round(s.overall) : null;
    }
    return null;
  }

  /** Only the quality badge is tinted; a count of comments has no good or bad. */
  function tabCountTone(id) {
    if (id !== "iqs") return "";
    const s = state.iqs?.score ?? state.detail?.case?.iqs;
    return s?.band ? `t-${iqsTone(s.band)}` : "";
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
      n === null ? null : h("span", { class: `cd-tab-count mono ${tabCountTone(t.id)}`, text: String(n) }));
    }));
  }

  function selectTab(id) {
    if (state.tab === id) return;
    state.tab = id;
    setQuery({ tab: id === "timeline" ? null : id });
    paintTabs();
    paintBody();
  }

  /**
   * Jump to a comment in the timeline and make it obvious which one.
   *
   * Two tabs cite comments by id — Commitments points at the sentence that made
   * the promise, Quality points at the sentence that cost points — and an
   * evidence link that lands you on a filtered timeline with the target hidden
   * is worse than no link. So the filters are cleared and the folds opened
   * before the scroll, and a missing id says so rather than scrolling nowhere.
   */
  function jumpToComment(commentId, missingMessage) {
    const inTimeline = new Set((state.timeline?.entries || []).map((e) => e.id));
    if (!commentId || !inTimeline.has(commentId)) {
      toast(missingMessage || "That comment is not in the cached timeline");
      return;
    }
    state.find = "";
    state.vis = "all";
    state.src = "all";
    state.expandAll = true;
    setQuery({ q: null });
    selectTab("timeline");
    requestAnimationFrame(() => {
      const el = document.getElementById(`tl-${commentId}`);
      if (!el) return;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("tl-flash");
      setTimeout(() => el.classList.remove("tl-flash"), 1600);
    });
  }

  /* ----------------------------------------------------------- tab bodies */

  function paintBody() {
    if (state.tab === "timeline")    return paintTimeline();
    if (state.tab === "artifacts")   return paintArtifacts();
    if (state.tab === "commitments") return paintCommitments();
    if (state.tab === "related")     return paintRelated();
    if (state.tab === "draft")       return paintDraft();
    if (state.tab === "iqs")         return paintQuality();
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

    const jumpToSource = (cm) =>
      jumpToComment(cm.sourceCommentId, "The comment this came from is not in the cached timeline");

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

  const KEYWORD_OPTIONS = ["INTRO", "UPDATE", "FOLLOWUP", "CLOSURE"];

  /** A yes/no read for one WWW component, shown next to the predicted score. */
  function wwwPill(label, ok) {
    return h("span", { class: `chip ${ok ? "ok" : "neutral"}`, text: `${label} ${ok ? "✓" : "✗"}` });
  }

  /**
   * Known artifacts for the case, fetched independently of the Artifacts tab
   * (a visitor who never opens that tab should still see this) but sharing
   * its cache once loaded, so opening Artifacts afterward does not re-fetch.
   */
  async function ensureArtifacts(onLoaded) {
    if (state.artifacts) return onLoaded();
    try {
      state.artifacts = await api.artifacts(caseNumber);
    } catch {
      return; // advisory only — the draft tab works fine without this line
    }
    if (state.tab === "draft") onLoaded();
  }

  const ICON_SPIN = ["M20 11a8 8 0 10-.6 4", "M20 4v7h-7"]; // same shape as the topbar sync spinner

  /**
   * What to say while an AI call is in flight, in the order it is actually
   * true. Both are real pipeline stages -- drafting really does read history
   * before writing, and repair really does re-score between the mechanical
   * pass and the model pass -- not a fake progress bar. The caption sits on
   * the last stage rather than looping, because a request that runs long is
   * "still finishing the last thing," not "starting over."
   */
  const BUSY_STAGES = {
    generate: ["Reading the case history…", "Applying the IQS rubric…", "Drafting the reply…", "Running the self-check…"],
    repair: ["Fixing flagged phrases…", "Re-scoring the draft…", "Rewriting what's left…"],
  };
  const BUSY_STEP_MS = 1100;

  function paintDraft() {
    const c = state.detail.case;
    const key = `${KEY_DRAFT}.${caseNumber}`;

    const meta = h("div", { class: "draft-meta" });
    const scoreHost = h("div", { class: "draft-score-host" });
    const artifactsHost = h("div", {});
    const area = h("textarea", {
      class: "input draft-area",
      spellcheck: "true",
      placeholder: "Stage your reply here, or generate one with AI below. Nothing is sent from this page — it holds text and copies it.",
    });
    area.value = store.get(key, "");

    const captionText = h("span", { class: "draft-busy-caption-text", "aria-live": "polite" });
    const busyOverlay = h("div", { class: "draft-busy", "aria-busy": "true", hidden: true },
      h("div", { class: "draft-busy-lines" },
        h("div", { class: "draft-busy-line", style: { width: "34%" } }),
        h("div", { class: "draft-busy-line", style: { width: "91%" } }),
        h("div", { class: "draft-busy-line", style: { width: "82%" } }),
        h("div", { class: "draft-busy-lastline" },
          h("div", { class: "draft-busy-line", style: { width: "23%" } }),
          h("span", { class: "draft-busy-caret" }))),
      h("div", { class: "draft-busy-caption" },
        icon(ICON_SPIN, 14),
        captionText));

    let busyTimer = null;

    /**
     * Shown while area.value is stale (mid-generation) so nothing reads as
     * "hung" -- the earlier version of this tab had no feedback at all here,
     * which for a 3-8 second model call looked exactly like a frozen page.
     * The textarea itself stays underneath (dimmed, read-only) rather than
     * being replaced, so its scrollbar and size never jump when the overlay
     * comes down.
     */
    function setBusy(kind) {
      const stages = BUSY_STAGES[kind];
      let i = 0;
      captionText.textContent = stages[0];
      area.classList.add("is-busy");
      area.readOnly = true;
      busyOverlay.hidden = false;
      clearInterval(busyTimer);
      busyTimer = setInterval(() => {
        if (i < stages.length - 1) captionText.textContent = stages[++i];
      }, BUSY_STEP_MS);
    }

    function clearBusy() {
      clearInterval(busyTimer);
      busyTimer = null;
      area.classList.remove("is-busy");
      area.readOnly = false;
      busyOverlay.hidden = true;
    }

    const paintMeta = () => {
      const v = area.value;
      const words = v.trim() ? v.trim().split(/\s+/).length : 0;
      mount(meta,
        h("span", { class: "dim", text: `${v.length} characters · ${words} words` }),
        h("div", { class: "spacer" }),
        h("span", { class: "dim", text: v ? "Saved in this browser" : "Nothing staged yet" }));
    };
    paintMeta();

    /**
     * Phase 5's gate: whatever is staged gets scored before Copy, the same
     * way regardless of whether it came from AI, a skeleton, or typing.
     * Layer 1 only — free and instant, so this can run on every pause in
     * typing without a second thought about cost.
     */
    function paintScorePanel() {
      if (state.draftScoring) {
        mount(scoreHost, h("div", { class: "hint", text: "Scoring…" }));
        return;
      }
      const score = state.draftScore;
      if (!score) {
        mount(scoreHost, h("div", { class: "hint", text: "Stage a couple of sentences to see a predicted score." }));
        return;
      }
      const scoped = score.overall !== null && score.overall !== undefined;
      const draftWww = score.comments.find((cm) => cm.id === "draft-preview");
      const draftViolations = score.violations.filter((v) => v.commentId === "draft-preview");

      mount(scoreHost,
        h("div", { class: `card draft-score-card t-${scoped ? iqsTone(score.band) : "none"}` },
          h("div", { class: "draft-score-top" },
            scoreMeter(score.overall, score.band, { width: 90 }),
            scoped ? bandChip(score.band) : h("span", { class: "dim", text: "Not enough to score" }),
            h("span", {
              class: "chip neutral", title: KEYWORD_HINT[score.keyword] || "",
              text: `Scored as ${KEYWORD_LABEL[score.keyword] || score.keyword}`,
            }),
            h("div", { class: "spacer" }),
            h("span", { class: "hint", text: "Predicted, Layer 1 — free, nothing sent" })),

          draftWww ? h("div", { class: "draft-www-row" },
            wwwPill("What", draftWww.what),
            wwwPill("Why", draftWww.why),
            wwwPill("When", draftWww.when || draftWww.whenWaived)) : null,

          draftViolations.length ? h("div", { class: "draft-viols" }, draftViolations.map((v) =>
            h("div", { class: "draft-viol" },
              h("code", { class: "iqs-viol-match", text: `“${v.match}”` }),
              h("span", { class: "dim", text: " → " }),
              h("span", { text: v.replacement })))) : null));
    }

    const hasIssues = () => {
      const score = state.draftScore;
      if (!score) return false;
      const draftWww = score.comments.find((cm) => cm.id === "draft-preview");
      const missingWww = draftWww && (!draftWww.what || !draftWww.why || (!draftWww.when && !draftWww.whenWaived));
      return score.violations.some((v) => v.commentId === "draft-preview") || !!missingWww;
    };

    const requestScore = debounce(async () => {
      const text = area.value;
      if (text.trim().length < 20) {
        state.draftScore = null;
        paintScorePanel();
        repairBtn.hidden = true;
        return;
      }
      state.draftScoring = true;
      paintScorePanel();
      try {
        const { score } = await api.draftScore(caseNumber, text, state.draftKeyword || undefined);
        state.draftScore = score;
      } catch {
        state.draftScore = null;
      }
      state.draftScoring = false;
      paintScorePanel();
      repairBtn.hidden = !hasIssues();
    }, 500);

    area.oninput = () => { store.set(key, area.value); paintMeta(); requestScore(); };

    const insert = (name) => {
      if (area.value.trim() &&
          !confirm(`Replace the ${area.value.length} characters already staged with the ${name} skeleton?`)) return;
      area.value = TEMPLATES[name](c);
      store.set(key, area.value);
      paintMeta();
      area.focus();
      area.setSelectionRange(0, 0);
      toast(`${name} skeleton inserted`, "ok");
      requestScore();
    };

    const keywordSelect = h("select", {
      class: "input draft-kw-select",
      title: "Which response type to draft and score as — leave on Auto unless the detected one is wrong for this case",
      onchange: (e) => {
        state.draftKeyword = e.target.value || null;
        requestScore();
      },
    },
      h("option", { value: "", text: "Auto-detect", selected: !state.draftKeyword }),
      ...KEYWORD_OPTIONS.map((k) =>
        h("option", { value: k, text: KEYWORD_LABEL[k], selected: state.draftKeyword === k })));

    const generateBtn = button("Generate with AI", {
      small: true, kind: "primary",
      title: "Draft a reply with Claude, using the case history and rubric",
      onclick: async () => {
        if (state.draftBusy) return;
        if (area.value.trim() &&
            !confirm(`Replace the ${area.value.length} characters already staged with an AI-generated draft?`)) return;
        state.draftBusy = true;
        generateBtn.disabled = true;
        generateBtn.textContent = "Drafting…";
        repairBtn.disabled = true;
        setBusy("generate");
        try {
          const result = await api.suggestReply(caseNumber, true, state.draftKeyword || undefined);
          area.value = result.draft;
          store.set(key, area.value);
          paintMeta();
          toast(`${KEYWORD_LABEL[result.keyword] || result.keyword} draft generated`, "ok");
          requestScore();
        } catch (err) {
          toast(err.message || "Could not generate a draft", "error");
        } finally {
          clearBusy();
          state.draftBusy = false;
          generateBtn.disabled = false;
          generateBtn.textContent = "Generate with AI";
        }
      },
    });

    const repairBtn = button("Auto-repair", {
      small: true,
      title: "Fix banned phrases by direct substitution, then ask AI to fix anything left (a missing What/Why/When, a weak dimension) — free unless a structural gap remains",
      onclick: async () => {
        if (state.draftBusy || !area.value.trim()) return;
        state.draftBusy = true;
        generateBtn.disabled = true;
        repairBtn.disabled = true;
        repairBtn.textContent = "Repairing…";
        setBusy("repair");
        try {
          const keyword = state.draftKeyword || state.draftScore?.keyword || "UPDATE";
          const result = await api.repairDraft(caseNumber, area.value, keyword);
          area.value = result.text;
          store.set(key, area.value);
          state.draftScore = result.score;
          paintMeta();
          paintScorePanel();
          repairBtn.hidden = !hasIssues();
          toast(
            result.modelCalled
              ? `Repaired — ${result.mechanicalFixes} phrase fix(es) + an AI rewrite`
              : `Repaired — ${result.mechanicalFixes} phrase fix(es), no AI needed`,
            "ok",
          );
        } catch (err) {
          toast(err.message || "Could not repair the draft", "error");
        } finally {
          clearBusy();
          state.draftBusy = false;
          generateBtn.disabled = false;
          repairBtn.disabled = false;
          repairBtn.textContent = "Auto-repair";
        }
      },
    });
    repairBtn.hidden = !hasIssues();

    ensureArtifacts(() => {
      const lines = (state.artifacts?.groups || []).flatMap((g) => g.values.map((v) => `${g.label}: ${v}`));
      mount(artifactsHost, lines.length
        ? h("div", { class: "hint draft-artifacts", title: lines.join("\n") },
            `On file for this case: ${lines.slice(0, 4).join(" · ")}${lines.length > 4 ? ` · +${lines.length - 4} more` : ""}`)
        : null);
    });

    mount(bodyHost,
      h("div", { class: "card draft-card" },
        h("div", { class: "art-head" },
          h("span", { class: "art-title", text: "Draft" }),
          h("div", { class: "spacer" }),
          keywordSelect,
          generateBtn,
          button("INTRO", { small: true, onclick: () => insert("INTRO") }),
          button("UPDATE", { small: true, onclick: () => insert("UPDATE") }),
          button("CLOSURE", { small: true, onclick: () => insert("CLOSURE") })),

        h("div", { class: "hint", style: { marginBottom: "10px" } },
          "This tab stages and copies text. It does not write the reply for you and it never sends anything — paste the finished version into Salesforce yourself."),

        artifactsHost,

        h("div", { class: "draft-area-wrap" }, area, busyOverlay),
        meta,
        scoreHost,

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
          repairBtn,
          h("div", { class: "spacer" }),
          button("Clear", {
            small: true, kind: "danger",
            onclick: () => {
              if (!area.value) return;
              if (!confirm("Discard the staged draft for this case?")) return;
              area.value = "";
              store.remove(key);
              paintMeta();
              state.draftScore = null;
              paintScorePanel();
              repairBtn.hidden = true;
            },
          }))));

    paintScorePanel();
    if (area.value.trim().length >= 20) requestScore();
  }

  /* ---- quality ----------------------------------------------------------- */

  /**
   * The local IQS estimate, shown as an argument rather than a verdict.
   *
   * This is a machine reading regular expressions over my own words, and it is
   * wrong sometimes. A bare number would be useless for that reason — the point
   * of the tab is not "you scored 61", it is "here is the sentence that cost you
   * the four points, decide whether you agree". So every dimension can be opened
   * to the individual signals, every signal that fired carries the quote it
   * fired on, and every deduction links to the comment it came from.
   *
   * Nothing here is customer-facing and nothing here is sent anywhere. It reads
   * one cached row that was written by a pure function on the last sync.
   */

  const MARK_FULL = ["M4 12.5l5 5L20 6.5"];
  const MARK_PART = ["M5 12h14"];
  const MARK_NONE = ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"];

  /** Points, to one decimal, without a pointless ".0". */
  const pts = (n) => String(Math.round((Number(n) || 0) * 10) / 10);

  function signalRow(sig) {
    const w = Number(sig.weight) || 0;
    const state_ = w >= 0.999 ? "full" : w <= 0.001 ? "none" : "part";
    const marks = { full: MARK_FULL, part: MARK_PART, none: MARK_NONE };

    return h("li", { class: `iqs-sig s-${state_}` },
      h("span", { class: "iqs-sig-mark" }, icon(marks[state_], 14)),

      h("div", { class: "iqs-sig-main" },
        h("div", { class: "iqs-sig-label", text: sig.label }),
        sig.note ? h("div", { class: "iqs-sig-note", text: sig.note }) : null,
        // Evidence is my own prose, quoted back at me. Text nodes only.
        sig.evidence ? textNodes(sig.evidence, "", "iqs-sig-ev") : null),

      h("span", {
        class: "iqs-sig-w mono",
        title: state_ === "full" ? "Full credit for this signal"
          : state_ === "none" ? "This signal did not fire"
          : "Partial credit — the signal fired weakly",
        text: state_ === "full" ? "1.0" : state_ === "none" ? "0" : w.toFixed(2).replace(/^0/, ""),
      }));
  }

  function dimensionCard(dim, scopeNotes) {
    const open = state.iqsOpen.has(dim.id);
    const pct = Math.round(Math.max(0, Math.min(100, (Number(dim.fraction) || 0) * 100)) * 10) / 10;

    /*
     * Counted at full credit only. Weights are fractional, so a count of
     * "anything above zero" would have printed 3/3 next to a Not Meeting
     * badge — technically true and completely misleading. The partials are
     * still acknowledged, in the tooltip and in the bar.
     */
    const w = dim.signals.map((s) => Number(s.weight) || 0);
    const full = w.filter((n) => n >= 0.999).length;
    const part = w.filter((n) => n > 0.001 && n < 0.999).length;
    const firedTitle = [
      `${full} at full credit`,
      part ? `${part} partial` : null,
      w.length - full - part ? `${w.length - full - part} not found` : null,
    ].filter(Boolean).join(", ");

    return h("div", { class: `card iqs-dim t-${iqsTone(dim.band)}${open ? " is-open" : ""}` },
      h("button", {
        class: "iqs-dim-head", type: "button",
        "aria-expanded": open ? "true" : "false",
        title: open ? "Hide the signals behind this score" : "Show the signals behind this score",
        onclick: () => {
          if (open) state.iqsOpen.delete(dim.id); else state.iqsOpen.add(dim.id);
          paintQuality();
        },
      },
        h("span", { class: "iqs-caret" }, icon(["M9 5l7 7-7 7"], 13)),
        h("span", { class: "iqs-dim-label", text: dim.label }),
        bandChip(dim.band),
        h("div", { class: "spacer" }),
        h("span", { class: "iqs-dim-sig dim", title: firedTitle, text: `${full}/${w.length} signals` }),
        h("span", { class: "iqs-dim-score mono", text: `${pts(dim.earned)} / ${pts(dim.max)}` }),
        h("span", { class: "bar-track iqs-dim-track" },
          h("span", { class: "bar-fill", style: { width: `${pct}%` } }))),

      h("div", { class: "iqs-dim-basis" },
        h("span", { text: dim.basis }),
        scopeNotes?.[dim.scope]
          ? h("span", { class: "dim", text: ` — ${scopeNotes[dim.scope]}` })
          : null),

      open ? h("ul", { class: "iqs-signals" }, dim.signals.map(signalRow)) : null);
  }

  function wwwTable(comments) {
    const cell = (ok, waived) => {
      if (waived) return h("td", { class: "iqs-www-cell" }, h("span", { class: "chip neutral", text: "waived" }));
      return h("td", { class: `iqs-www-cell ${ok ? "yes" : "no"}` },
        icon(ok ? MARK_FULL : MARK_NONE, 14));
    };

    return h("div", { class: "card iqs-card" },
      h("div", { class: "art-head" },
        h("span", { class: "art-title", text: "What / Why / When" }),
        h("span", { class: "cd-tab-count mono", text: String(comments.length) }),
        h("div", { class: "spacer" }),
        h("span", { class: "hint", text: "Every comment of mine, scored out of 3" })),

      h("div", { class: "iqs-www-scroll" },
        h("table", { class: "tbl iqs-www" },
          /*
           * "Posted", not "When" — the third-from-last column is also a
           * "When", and it means something entirely different (the WWW
           * signal, not a timestamp). Two identical headers over unrelated
           * columns is the kind of thing that reads fine to whoever wrote it.
           * "Posted" also covers internal comments, which are never sent.
           */
          h("thead", {}, h("tr", {},
            h("th", { text: "Posted" }),
            h("th", { text: "Visibility" }),
            h("th", { class: "right", text: "What" }),
            h("th", { class: "right", text: "Why" }),
            h("th", { class: "right", text: "When" }),
            h("th", { class: "right", text: "Score" }),
            h("th", { text: "Opening line" }))),

          h("tbody", {}, comments.map((cm) => h("tr", {
            class: "row iqs-www-row",
            title: "Open this comment in the timeline",
            onclick: () => jumpToComment(cm.id, "That comment is not in the cached timeline"),
          },
            h("td", { class: "nowrap mono dim", text: fmt.dateTimeShort(cm.createdDate) }),
            h("td", { class: "nowrap" },
              h("span", { class: `chip ${cm.isPublic ? "neutral" : "purple"}`,
                text: cm.isPublic ? "Public" : "Internal" }),
              cm.source === "email" ? h("span", { class: "chip neutral", text: "Email" }) : null),
            cell(cm.what, false),
            cell(cm.why, false),
            cell(cm.when, cm.whenWaived),
            h("td", { class: "right mono", text: `${pts(cm.earned)}/3` }),
            h("td", { class: "iqs-www-ex" },
              cm.excerpt ? textNodes(cm.excerpt, "", "iqs-ex") : h("span", { class: "dim", text: "—" }))))))));
  }

  function violationsCard(violations) {
    return h("div", { class: "card iqs-card iqs-viol-card" },
      h("div", { class: "art-head" },
        h("span", { class: "art-title", text: "Language deductions" }),
        h("span", { class: "cd-tab-count mono t-bad", text: String(violations.length) }),
        h("div", { class: "spacer" }),
        h("span", { class: "hint", text: "Phrases the rubric marks down, and what to write instead" })),

      h("div", { class: "iqs-viols" }, violations.map((v) => h("div", { class: "iqs-viol" },
        h("div", { class: "iqs-viol-top" },
          h("span", { class: "chip iqs-band t-bad", text: v.label }),
          h("code", { class: "iqs-viol-match", text: `“${v.match}”` }),
          h("div", { class: "spacer" }),
          h("span", { class: "mono dim nowrap", text: fmt.dateTimeShort(v.createdDate) }),
          h("button", {
            class: "linkbtn", type: "button", text: "jump to comment",
            onclick: () => jumpToComment(v.commentId, "That comment is not in the cached timeline"),
          })),

        v.excerpt ? textNodes(v.excerpt, "", "iqs-viol-ex") : null,

        h("div", { class: "iqs-viol-fix" },
          h("span", { class: "iqs-viol-fix-tag", text: "Instead" }),
          h("span", { text: v.replacement }))))));
  }

  async function paintQuality() {
    if (!state.iqs) {
      mount(bodyHost, skeletonRows(6, [160, 240, 240, 120]));
      try {
        state.iqs = await api.iqs(caseNumber);
        paintTabs();
      } catch (err) {
        mount(bodyHost, banner("error", err.message || "Could not load the quality score",
          button("Retry", { small: true, onclick: () => paintQuality() })));
        return;
      }
      if (state.tab !== "iqs") return;   // the tab changed while fetching
    }

    const score = state.iqs.score;
    const rubric = state.iqs.rubric || {};
    const scoped = score.overall !== null && score.overall !== undefined;

    /*
     * A dimension that does not apply to this response type is absent from the
     * score, not zero in it — a follow-up is not marked down for failing to
     * restate the business impact. Naming the absent ones is the only way the
     * denominator makes sense, so they are listed rather than silently missing.
     */
    const scoredIds = new Set(score.dimensions.map((d) => d.id));
    const notApplicable = (rubric.dimensions || []).filter((d) => !scoredIds.has(d.id));

    const kwLabel = KEYWORD_LABEL[score.keyword] || score.keyword;

    const header = h("div", { class: `card iqs-hero t-${scoped ? iqsTone(score.band) : "none"}` },
      h("div", { class: "iqs-hero-left" },
        h("div", { class: "iqs-hero-meter" }, scoreMeter(score.overall, score.band, { width: 168 })),
        h("div", {
          class: "iqs-hero-of",
          // The headline rounds; the tenth lives here rather than being lost.
          title: scoped ? `Exactly ${pts(score.overall)} of 100` : "",
          text: "out of 100 applicable points",
        })),

      h("div", { class: "iqs-hero-right" },
        h("div", { class: "iqs-hero-chips" },
          bandChip(score.band),
          h("span", {
            class: "chip neutral",
            title: KEYWORD_HINT[score.keyword] || "",
            text: `Scored as ${kwLabel}`,
          }),
          h("span", {
            class: "chip neutral",
            title: "Comments of mine the scorer could read on this case",
            text: `${score.ownerComments} of my comments`,
          })),

        /*
         * The derivation, not the result — the result is the 34px number to
         * the left. It deliberately stops before an equals sign: the headline
         * is rounded and the operands are exact, so a total here would either
         * disagree with the number beside it or fail to add up.
         */
        h("div", { class: "iqs-hero-sum", title: bandExplain(score.overall, score.band, rubric.bands) },
          scoped
            ? h("span", {},
                h("span", { class: "mono", text: pts(score.base) }),
                h("span", { class: "dim", text: " dimensions" }),
                score.penalty > 0
                  ? h("span", {},
                      h("span", { class: "dim", text: "  −  " }),
                      h("span", { class: "mono t-bad", text: pts(score.penalty) }),
                      h("span", { class: "dim", text: " language" }))
                  : h("span", { class: "dim", text: "  ·  no language deductions" }))
            : h("span", { class: "dim", text: "No score — see below" })),

        h("div", { class: "iqs-hero-meta hint" },
          // Rubric and scorer, named apart. When a score looks wrong the first
          // question is which of the two moved, and a slash-joined pair makes
          // that a guess. Scorer is omitted for rows stored before it was
          // recorded rather than printed as "undefined".
          `Rubric ${score.rubricVersion}`
          + (score.scorerVersion ? ` · scorer ${score.scorerVersion}` : "")
          + ` · scored locally ${fmt.dateTime(score.scoredAt)} · no API call, no model`)));

    if (!scoped) {
      mount(bodyHost,
        header,
        (score.notes || []).map((n) => banner("info", n)),
        emptyState({
          title: "Nothing of mine to score yet",
          message: "The rubric grades what I wrote. This case has no comment from me in the cache, so a number here would be a number about somebody else's work.",
          iconName: "inbox",
          action: button("Open Timeline", { small: true, onclick: () => selectTab("timeline") }),
        }));
      return;
    }

    const allOpen = score.dimensions.length > 0 && score.dimensions.every((d) => state.iqsOpen.has(d.id));

    mount(bodyHost,
      header,

      (score.notes || []).map((n) => banner("info", n)),

      h("div", { class: "iqs-sec-head" },
        h("span", { class: "art-title", text: "Dimensions" }),
        h("div", { class: "spacer" }),
        h("button", {
          class: "linkbtn", type: "button",
          text: allOpen ? "Collapse all" : "Expand all",
          onclick: () => {
            if (allOpen) state.iqsOpen.clear();
            else for (const d of score.dimensions) state.iqsOpen.add(d.id);
            paintQuality();
          },
        })),

      h("div", { class: "iqs-dims" }, score.dimensions.map((d) => dimensionCard(d, rubric.scopeNotes))),

      notApplicable.length
        ? h("div", { class: "hint iqs-na" },
            // "this", not "a" — two of the four keyword labels start with a
            // vowel, so a hardcoded article gets "a update" and "a intro"
            // wrong. Sidestepping the article is cheaper than choosing one.
            `Not scored for this ${kwLabel.toLowerCase()}: ${notApplicable.map((d) => d.label).join(", ")}. `
            + "These drop out of the denominator rather than scoring zero.")
        : null,

      score.violations.length ? violationsCard(score.violations) : null,

      score.comments.length ? wwwTable(score.comments) : null,

      h("div", { class: "hint iqs-foot" },
        "This is QView's own estimate, produced by pattern matching on the cached case — not an official IQS result and not visible to anyone else. "
        + "Where it disagrees with you, it is the estimate that is probably wrong; the evidence above is there so you can tell which."));
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
