/**
 * Patterns — the same failure, seen three times, without going looking.
 *
 * The server clusters the cache three ways and returns all three in one call:
 * by extracted error signature, by product area, and by account. Each cluster
 * carries a total, an open count, and up to twenty member cases.
 *
 * What the page adds is the judgement about which clusters are worth a human
 * looking at, and it makes that judgement visible rather than silent:
 *
 *   - Signatures are ranked by open cases first, then by total. A signature
 *     with six closed cases is history; a signature with two open ones is
 *     today. Sorting purely by total would bury the second under the first.
 *   - Every cluster links to a Queue URL that returns exactly its members,
 *     using the `cases` parameter Phase 5 added, so a count can always be
 *     checked rather than taken on faith. Where a cluster is larger than the
 *     twenty cases the server returns, the card says so instead of quietly
 *     linking to a subset.
 *   - Accounts and product areas are clusters too, but weaker ones: three
 *     cases on one account may be one incident or three unrelated tickets. So
 *     they live in their own tabs, under the signature view rather than mixed
 *     into it.
 *
 * There is no threshold slider. The server already drops singletons for
 * signatures and accounts, which is the only threshold that matters — the
 * whole point of the page is repetition.
 */

import { h, mount } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as store from "../lib/store.js";
import { banner, button, emptyState, skeletonCards } from "../lib/ui.js";
import { oneLine } from "../lib/text.js";
import { pageHead, page } from "./_shared.js";
import { setQuery } from "../router.js";

/* ------------------------------------------------------------------ config */

const KEY_PREFS = "patterns.prefs";

const ICON_REFRESH = ["M20 11a8 8 0 10-2.3 5.7", "M20 5v6h-6"];

const TABS = [
  { id: "signatures", label: "Error signatures", empty: "No error signature appears on more than one case." },
  { id: "productAreas", label: "Product areas", empty: "No product area has more than one case." },
  { id: "accounts", label: "Accounts", empty: "No account has more than one case." },
];

const TAB_NOTE = {
  signatures:
    "Signatures are extracted from case text during sync. Two cases share a signature when the same error string was found in both — the strongest same-root-cause signal the cache has.",
  productAreas:
    "Every case has a product area, so these clusters are always large. Read them as workload distribution, not as incidents.",
  accounts:
    "Repeat cases on one account. Sometimes one incident filed several times, sometimes an account having a bad month — the case list below each is what tells them apart.",
};

const SORTS = [
  { id: "open", label: "Open first" },
  { id: "total", label: "Total" },
];

/* -------------------------------------------------------------------- util */

/**
 * A cluster's drill-through. `cases` takes a comma-separated list and the
 * Queue matches it exactly, so the link returns the cluster and nothing else.
 * Closed members are included deliberately — the reason to click a pattern is
 * usually to read how the last one was fixed.
 */
function clusterHref(cluster) {
  const nums = (cluster.cases || []).map((c) => c.caseNumber).filter(Boolean);
  if (!nums.length) return null;
  return "/?cases=" + encodeURIComponent(nums.join(",")) + "&status=all";
}

function barWidth(count, max) {
  if (!max) return 0;
  return Math.max(3, Math.round((count / max) * 100));
}

/* ------------------------------------------------------------------ pieces */

function memberChip(c) {
  return h("a", {
    class: "pt-member" + (c.isClosed ? " closed" : ""),
    href: "/case/" + encodeURIComponent(c.caseNumber),
    title: (c.subject || "") + (c.account ? " — " + c.account : ""),
  },
    h("span", { class: "mono", text: c.caseNumber }),
    c.priority ? h("span", { class: "pt-member-p", text: c.priority }) : null);
}

function clusterCard(cluster, max, tab) {
  const total = cluster.count || 0;
  const open = cluster.open_count || 0;
  const members = cluster.cases || [];
  const href = clusterHref(cluster);
  const partial = members.length < total;

  return h("article", { class: "pt-card" + (open > 1 ? " live" : "") },
    h("header", { class: "pt-head" },
      h("div", { class: "pt-key", title: cluster.key || "" },
        tab === "signatures"
          ? h("code", { class: "pt-sig", text: oneLine(cluster.key || "(no signature)", 150) })
          : h("strong", { text: cluster.key || "(unspecified)" })),
      h("div", { class: "pt-counts" },
        h("span", { class: "pt-total", text: String(total) }),
        h("span", { class: "pt-total-label", text: total === 1 ? "case" : "cases" }),
        open
          ? h("span", { class: "chip " + (open > 1 ? "p1" : "p2"), text: open + " open" })
          : h("span", { class: "chip ok", text: "all closed" }))),

    h("div", { class: "pt-bar" },
      h("div", { class: "pt-bar-fill", style: "width:" + barWidth(total, max) + "%" }),
      open
        ? h("div", { class: "pt-bar-open", style: "width:" + barWidth(open, max) + "%" })
        : null),

    h("div", { class: "pt-members" }, members.map(memberChip)),

    h("footer", { class: "pt-foot" },
      partial
        ? h("span", { class: "dim", text: "Showing " + members.length + " of " + total + " cases" })
        : null,
      h("span", { class: "spacer" }),
      href
        ? h("a", {
            class: "link",
            href,
            text: partial
              ? "Open these " + members.length + " in the Queue"
              : "Open all " + total + " in the Queue",
          })
        : null));
}

/* ------------------------------------------------------------------ render */

export function render(ctx, host, shell) {
  const q = ctx.query || {};
  const prefs = store.get(KEY_PREFS, {});

  const state = {
    data: null,
    loading: true,
    error: null,
    tab: TABS.some((t) => t.id === q.tab) ? q.tab : (prefs.tab || "signatures"),
    sort: SORTS.some((s) => s.id === q.sort) ? q.sort : (prefs.sort || "open"),
    openOnly: "open" in q ? q.open === "1" : !!prefs.openOnly,
  };

  const bodyHost = h("div", {});
  const bannerHost = h("div", {});
  let disposed = false;

  function savePrefs() {
    store.set(KEY_PREFS, { tab: state.tab, sort: state.sort, openOnly: state.openOnly });
  }

  /* ----------------------------------------------------------------- data */

  async function load() {
    state.loading = true;
    paint();
    try {
      const data = await api.patterns();
      if (disposed) return;
      state.data = data;
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    state.loading = false;
    paint();
  }

  /* -------------------------------------------------------------- toolbar */

  function tabs() {
    return h("div", { class: "pt-tabs" }, TABS.map((t) => {
      const list = state.data ? (state.data[t.id] || []) : [];
      return h("button", {
        class: "pt-tab" + (t.id === state.tab ? " on" : ""),
        type: "button",
        onclick: () => {
          state.tab = t.id; savePrefs();
          setQuery({ tab: t.id === "signatures" ? null : t.id });
          paint();
        },
      },
        h("span", { text: t.label }),
        state.data ? h("span", { class: "pt-tab-count mono", text: String(list.length) }) : null);
    }));
  }

  function toolbar() {
    return h("div", { class: "toolbar pt-toolbar" },
      h("div", { class: "tb-label", text: "Rank by" }),
      h("div", { class: "seg" }, SORTS.map((s) =>
        h("button", {
          class: "seg-btn" + (s.id === state.sort ? " on" : ""),
          type: "button",
          text: s.label,
          onclick: () => {
            state.sort = s.id; savePrefs();
            setQuery({ sort: s.id === "open" ? null : s.id });
            paint();
          },
        }))),
      h("label", { class: "checkline" },
        h("input", {
          type: "checkbox",
          checked: state.openOnly,
          onchange: (e) => {
            state.openOnly = e.target.checked; savePrefs();
            setQuery({ open: state.openOnly ? true : null });
            paint();
          },
        }),
        h("span", { text: "Only clusters with an open case" })),
      h("span", { class: "spacer" }));
  }

  /* ---------------------------------------------------------------- paint */

  function rowsFor(tab) {
    let rows = (state.data && state.data[tab]) || [];
    if (state.openOnly) rows = rows.filter((r) => (r.open_count || 0) > 0);
    return rows.slice().sort((a, b) => {
      if (state.sort === "open") {
        const d = (b.open_count || 0) - (a.open_count || 0);
        if (d) return d;
      }
      return (b.count || 0) - (a.count || 0);
    });
  }

  function paint() {
    if (state.loading) {
      mount(bodyHost, skeletonCards(3, "150px"));
      return;
    }
    if (state.error) {
      mount(bodyHost, emptyState({
        title: "Could not load patterns",
        message: state.error.message || "The server did not answer.",
        iconName: "alert",
        kind: "error",
        action: button("Try again", { kind: "primary", onclick: () => load() }),
      }));
      return;
    }

    const tabMeta = TABS.find((t) => t.id === state.tab) || TABS[0];
    const rows = rowsFor(state.tab);
    const all = (state.data && state.data[state.tab]) || [];
    const hidden = all.length - rows.length;
    const max = rows.reduce((m, r) => Math.max(m, r.count || 0), 0);
    const liveCount = rows.filter((r) => (r.open_count || 0) > 1).length;

    mount(bannerHost, liveCount
      ? banner("warn", liveCount === 1
          ? "One cluster has more than one case still open. That is the same failure happening now on more than one front."
          : liveCount + " clusters have more than one case still open. Those are the same failure happening now on more than one front.")
      : null);

    mount(bodyHost,
      tabs(),
      h("p", { class: "pt-note", text: TAB_NOTE[state.tab] || "" }),
      toolbar(),
      h("div", { class: "result-line" },
        h("strong", { text: String(rows.length) }),
        rows.length === 1 ? " cluster" : " clusters",
        hidden ? h("span", { class: "dim", text: " · " + hidden + " with nothing open, hidden" }) : null),
      rows.length
        ? h("div", { class: "pt-list" }, rows.map((r) => clusterCard(r, max, state.tab)))
        : emptyState({
            title: state.openOnly ? "No cluster has an open case" : "Nothing repeats yet",
            message: state.openOnly
              ? "Every recurring pattern in the cache is fully closed out. Untick the filter to review them as history."
              : tabMeta.empty + " Clusters of one are dropped server-side, because a single case is not a pattern.",
            iconName: state.openOnly ? "check" : "inbox",
            kind: state.openOnly ? "success" : "",
            action: state.openOnly
              ? button("Show all clusters", {
                  kind: "primary",
                  onclick: () => { state.openOnly = false; savePrefs(); setQuery({ open: null }); paint(); },
                })
              : null,
          }));
  }

  /* ----------------------------------------------------------------- boot */

  mount(host, page(
    pageHead(
      "Patterns",
      "The same error, product area or account showing up on more than one case.",
      [button("Refresh", { small: true, iconPaths: ICON_REFRESH, onclick: () => load() })]),
    bannerHost,
    bodyHost));

  paint();
  load();

  shell.setPageKeys((e) => {
    const idx = TABS.findIndex((t) => t.id === state.tab);
    if (e.key === "[" || e.key === "]") {
      const next = (idx + (e.key === "]" ? 1 : TABS.length - 1)) % TABS.length;
      state.tab = TABS[next].id; savePrefs();
      setQuery({ tab: state.tab === "signatures" ? null : state.tab });
      paint();
      return true;
    }
    return false;
  });

  return () => {
    disposed = true;
    shell.setPageKeys(null);
  };
}
