/**
 * Escalations — the cases where somebody senior is watching.
 *
 * The population is exactly what the sidebar badge counts:
 * `is_closed = 0 AND (is_escalated = 1 OR priority IN ('P1','P0'))`. One fetch
 * of the open queue, filtered here, so the page and the badge cannot drift.
 *
 * The spec asks for engagement start, current phase, the last executive update
 * sent, and the next update due. None of those exist as fields in Salesforce
 * and there is no annotation table in the cache, so every one of them is
 * derived from data that is really there, and every one of them says on screen
 * what it was derived from:
 *
 *   engagement start   case creation. There is no escalation timestamp; the
 *                      cache records that a case IS escalated, not when it
 *                      became so. The card says "case opened", not
 *                      "escalated on", because the second would be a claim the
 *                      data cannot support.
 *   current phase      read off case status, with the raw status shown beside
 *                      it so the mapping is auditable rather than magic.
 *   last update sent   the most recent timeline entry that is mine, public and
 *                      outbound. That is a real customer-visible update from
 *                      me, which is the closest thing the cache has to an
 *                      executive update, and the actual text is shown so it can
 *                      be judged rather than trusted.
 *   next update due    that timestamp plus a cadence, configurable in Settings
 *                      (`escalationUpdateHours`, default 24). Where no update
 *                      has ever gone out, the cadence runs from case creation,
 *                      and the card says so.
 *
 * Timelines are fetched per case rather than in bulk because the population is
 * small by definition — if this list is long enough for that to matter, the
 * list itself is the problem.
 */

import { $$, h, mount } from "../lib/dom.js";
import { api } from "../lib/api.js";
import * as fmt from "../lib/fmt.js";
import { banner, button, skeletonCards, emptyState, copyBtn } from "../lib/ui.js";
import { htmlToText, oneLine } from "../lib/text.js";
import { pageHead, page } from "./_shared.js";

/* ------------------------------------------------------------------ config */

const TICK_MS = 30000;

const ICON_REFRESH = ["M20 11a8 8 0 10-2.3 5.7", "M20 5v6h-6"];

/** Fetching a timeline per case is fine for a handful and wrong for a hundred. */
const TIMELINE_CAP = 25;

const DEFAULT_CADENCE_HOURS = 24;

const PREVIEW_CHARS = 240;

/**
 * Status to phase. Deliberately a small, explicit table rather than a clever
 * matcher: an unrecognised status falls through to itself, which is honest,
 * where a fuzzy guess would quietly mislabel the one case that matters most.
 */
const PHASES = [
  { match: /^new$/i,                     phase: "Intake",                       tone: "p2" },
  { match: /working|in progress|active/i, phase: "Active investigation",         tone: "p2" },
  { match: /engineering|escalat|sustain/i, phase: "Engineering engaged",         tone: "p1" },
  { match: /waiting for customer/i,      phase: "Awaiting customer",            tone: "neutral" },
  { match: /resolved.*pending/i,         phase: "Pending customer confirmation", tone: "ok" },
  { match: /^closed/i,                   phase: "Closed",                       tone: "ok" },
];

function phaseOf(status) {
  const s = String(status || "");
  for (const p of PHASES) if (p.match.test(s)) return { phase: p.phase, tone: p.tone };
  return { phase: s || "Unknown", tone: "neutral" };
}

/* -------------------------------------------------------------------- util */

function lastOutboundUpdate(entries) {
  let best = null;
  for (const e of entries || []) {
    if (!e.isMine || !e.isPublic || e.isInbound) continue;
    if (!best || Date.parse(e.createdDate) > Date.parse(best.createdDate)) best = e;
  }
  return best;
}

function dueTone(msLeft) {
  if (msLeft < 0) return "red";
  if (msLeft <= 4 * 3600000) return "amber";
  return "";
}

/* ------------------------------------------------------------------ pieces */

function factRow(label, valueNode, hint) {
  return h("div", { class: "esc-fact" },
    h("div", { class: "esc-fact-label", text: label }),
    h("div", { class: "esc-fact-value" }, valueNode),
    hint ? h("div", { class: "esc-fact-hint", text: hint }) : null);
}

function updatePreview(entry) {
  if (!entry) return null;
  const text = oneLine(htmlToText(entry.body || ""), PREVIEW_CHARS);
  if (!text) return null;
  return h("blockquote", { class: "esc-quote" },
    entry.subject ? h("div", { class: "esc-quote-subject", text: entry.subject }) : null,
    h("p", { text }));
}

function escCard(c, detail, now, cadenceHours) {
  const { phase, tone } = phaseOf(c.status);
  const last = detail && detail.lastUpdate;
  const anchor = last ? Date.parse(last.createdDate) : Date.parse(c.createdDate);
  const due = anchor + cadenceHours * 3600000;
  const left = due - now;
  const href = "/case/" + encodeURIComponent(c.caseNumber);
  const age = fmt.ageDays(c.createdDate, now);

  return h("article", { class: "esc-card" + (left < 0 ? " overdue" : "") },
    h("header", { class: "esc-head" },
      h("div", { class: "esc-head-l" },
        h("a", { class: "mono esc-num", href, text: c.caseNumber }),
        copyBtn(c.caseNumber, "Case number", "Copy case number"),
        h("span", { class: "chip " + fmt.priorityClass(c.priority), text: c.priority || "—" }),
        c.isEscalated
          ? h("span", { class: "chip p1", text: "ESCALATED" })
          : h("span", { class: "chip neutral", text: "BY PRIORITY" }),
        h("span", { class: "chip " + tone, text: phase })),
      h("div", { class: "esc-head-r" },
        h("div", {
          class: "esc-due " + dueTone(left),
          "data-due": String(due),
          text: fmt.countdown(due, now),
        }),
        h("div", { class: "esc-due-label", text: left < 0 ? "update overdue" : "to next update" }))),

    h("a", { class: "esc-subject", href, title: c.subject || "", text: c.subject || "(no subject)" }),
    h("div", { class: "esc-account" },
      h("strong", { text: c.account || "—" }),
      c.contactName ? h("span", { class: "dim", text: " · " + c.contactName }) : null,
      c.productArea ? h("span", { class: "dim", text: " · " + c.productArea }) : null),

    h("div", { class: "esc-facts" },
      factRow("Engagement start",
        h("span", { title: fmt.dateTime(c.createdDate) },
          h("strong", { text: fmt.dateTimeShort(c.createdDate) }),
          h("span", { class: "dim", text: " · " + (age.days === null ? "" : age.days + "d ago") })),
        "case opened; the cache has no separate escalation timestamp"),

      factRow("Current phase",
        h("span", {}, h("strong", { text: phase })),
        "derived from status “" + (c.status || "—") + "”"),

      factRow("Last update sent",
        last
          ? h("span", { title: fmt.dateTime(last.createdDate) },
              h("strong", { text: fmt.dateTimeShort(last.createdDate) }),
              h("span", { class: "dim", text: " · " + fmt.relative(last.createdDate, now) }))
          : detail
          ? h("span", { class: "dim red", text: "none on record" })
          : h("span", { class: "dim", text: "loading…" }),
        last
          ? "most recent public outbound " + (last.source === "email" ? "email" : "comment") + " from me"
          : detail
          ? "no public outbound message from me in the cached history"
          : null),

      factRow("Next update due",
        h("span", { title: fmt.dateTime(due) },
          h("strong", { text: fmt.dateTimeShort(due) }),
          h("span", { class: "dim", text: " · every " + cadenceHours + "h" })),
        last ? null : "counted from case creation, because nothing has gone out yet"),

      c.nextCommitment
        ? factRow("Live commitment",
            h("a", { class: "link", href: "/commitments?q=" + encodeURIComponent(c.caseNumber) },
              c.nextCommitment.dueAt ? fmt.dateTimeShort(c.nextCommitment.dueAt) : "no date set"),
            "a follow-up deadline is already promised on this case")
        : null),

    updatePreview(last));
}

/* ------------------------------------------------------------------ render */

export function render(ctx, host, shell) {
  const state = {
    rows: [],
    details: new Map(),   // caseNumber -> { lastUpdate }
    cadence: DEFAULT_CADENCE_HOURS,
    loading: true,
    error: null,
    truncated: 0,
    sync: null,
  };

  const bodyHost = h("div", {});
  const bannerHost = h("div", {});
  let ticker = null;
  let disposed = false;

  /* ----------------------------------------------------------------- data */

  function isEscalation(c) {
    return !c.isClosed && (c.isEscalated || c.priority === "P0" || c.priority === "P1");
  }

  async function load({ quiet } = {}) {
    if (!quiet) { state.loading = true; paint(); }
    try {
      const [cases, settings] = await Promise.all([
        api.cases({ status: "open" }),
        api.settings().catch(() => null),
      ]);
      if (disposed) return;
      state.rows = (cases.cases || []).filter(isEscalation);
      state.sync = cases.sync || null;
      const configured = settings && settings.settings
        ? Number(settings.settings.escalationUpdateHours)
        : NaN;
      state.cadence = Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_CADENCE_HOURS;
      state.error = null;
    } catch (err) {
      state.error = err;
    }
    state.loading = false;
    paint();
    loadDetails();
  }

  /** Timelines arrive after the cards, so the page is useful before they land. */
  async function loadDetails() {
    const targets = state.rows.slice(0, TIMELINE_CAP);
    state.truncated = state.rows.length - targets.length;
    await Promise.all(targets.map(async (c) => {
      if (state.details.has(c.caseNumber)) return;
      try {
        const tl = await api.timeline(c.caseNumber);
        state.details.set(c.caseNumber, { lastUpdate: lastOutboundUpdate(tl.entries) });
      } catch {
        // A timeline that will not load is not a reason to lose the card; the
        // fact row stays on "loading…" and the rest of the case still reads.
      }
    }));
    if (!disposed) paint();
  }

  /* ---------------------------------------------------------------- paint */

  function paint() {
    if (state.loading) {
      mount(bodyHost, skeletonCards(2, "260px"));
      return;
    }
    if (state.error) {
      mount(bodyHost, emptyState({
        title: "Could not load escalations",
        message: state.error.message || "The server did not answer.",
        iconName: "alert",
        kind: "error",
        action: button("Try again", { kind: "primary", onclick: () => load() }),
      }));
      return;
    }

    const now = Date.now();
    const rows = state.rows.slice().sort((a, b) => {
      // Overdue updates first, then by how soon the next one is owed.
      const da = state.details.get(a.caseNumber);
      const db = state.details.get(b.caseNumber);
      const aa = (da && da.lastUpdate ? Date.parse(da.lastUpdate.createdDate) : Date.parse(a.createdDate));
      const bb = (db && db.lastUpdate ? Date.parse(db.lastUpdate.createdDate) : Date.parse(b.createdDate));
      return aa - bb;
    });

    const overdue = rows.filter((c) => {
      const d = state.details.get(c.caseNumber);
      const anchor = d && d.lastUpdate ? Date.parse(d.lastUpdate.createdDate) : Date.parse(c.createdDate);
      return anchor + state.cadence * 3600000 < now;
    }).length;

    mount(bannerHost,
      overdue
        ? banner("warn",
            overdue === 1
              ? "One escalation is past its update cadence. The countdown is a local convention, not a Salesforce field — the cadence is set in Settings."
              : overdue + " escalations are past their update cadence. The countdown is a local convention, not a Salesforce field — the cadence is set in Settings.")
        : null,
      state.truncated
        ? banner("warn", "Showing detail for the first " + TIMELINE_CAP + " escalations; " +
            state.truncated + " more are listed without their last-update history.")
        : null);

    mount(bodyHost,
      h("div", { class: "result-line esc-summary" },
        rows.length === 0
          ? "No active escalations"
          : rows.length + (rows.length === 1 ? " active escalation" : " active escalations"),
        h("span", { class: "dim", text: " · update cadence every " + state.cadence + "h" }),
        h("span", { class: "spacer" }),
        h("a", { class: "link", href: "/settings", text: "Change cadence" })),
      rows.length
        ? h("div", { class: "esc-list" },
            rows.map((c) => escCard(c, state.details.get(c.caseNumber), now, state.cadence)))
        : emptyState({
            title: "No active escalations",
            message: "Nothing open is flagged escalated or sitting at P0/P1. This is the same population the sidebar badge counts, so an empty page here means an empty badge there.",
            iconName: "check",
            kind: "success",
          }));
  }

  /* --------------------------------------------------------------- ticker */

  function tick() {
    const now = Date.now();
    for (const el of $$("[data-due]", bodyHost)) {
      const due = Number(el.dataset.due);
      el.textContent = fmt.countdown(due, now);
      const tone = dueTone(due - now);
      el.classList.toggle("red", tone === "red");
      el.classList.toggle("amber", tone === "amber");
      const card = el.closest(".esc-card");
      if (card) card.classList.toggle("overdue", due - now < 0);
    }
  }

  /* ----------------------------------------------------------------- boot */

  mount(host, page(
    pageHead(
      "Escalations",
      "Open cases flagged escalated or running at P0/P1, with the update clock.",
      [button("Refresh", { small: true, iconPaths: ICON_REFRESH, onclick: () => load() })]),
    bannerHost,
    bodyHost));

  paint();
  load();
  ticker = setInterval(tick, TICK_MS);

  return () => {
    disposed = true;
    if (ticker) clearInterval(ticker);
  };
}
