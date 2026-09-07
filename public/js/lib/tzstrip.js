/**
 * The time zone strip's UI (v4 phase 7). Logic lives in tz.js; this wires it
 * to the DOM, scoped to the fixed `#tzStrip` container index.html already
 * has. Opened from the topbar clock (`#clocksToggle`), collapsed by default,
 * state remembered.
 */

import { h, mount, icon } from "./dom.js";
import * as store from "./store.js";
import * as tz from "./tz.js";
import { copyToast } from "./ui.js";

const KEY_ZONES = "tz.zones";
const KEY_COLLAPSED = "tz.collapsed";
const OWN_ZONE = "America/New_York";
const DEFAULT_ZONES = [
  { id: "America/New_York", label: "ET (mine)" },
  { id: "UTC", label: "UTC" },
  { id: "Asia/Kolkata", label: "IST" },
  { id: "America/Los_Angeles", label: "PT" },
];

function loadZones() {
  const saved = store.get(KEY_ZONES, null);
  return Array.isArray(saved) && saved.length ? saved : DEFAULT_ZONES;
}
function saveZones(zones) { store.set(KEY_ZONES, zones); }

const ALL_ZONES = tz.zoneList();

export function initTzStrip() {
  const toggle = document.getElementById("clocksToggle");
  const container = document.getElementById("tzStrip");
  if (!toggle || !container) return;

  const state = {
    zones: loadZones(),
    open: !store.get(KEY_COLLAPSED, true),
    scrubAt: null, // null = "now" (live); a Date once scrubbed
    pickerOpen: false,
  };

  let liveTimer = null;

  function currentMoment() {
    return state.scrubAt || new Date();
  }

  function setOpen(next) {
    state.open = next;
    container.hidden = !next;
    store.set(KEY_COLLAPSED, !next);
    if (next) { paint(); startLive(); } else stopLive();
  }

  function startLive() {
    stopLive();
    // A real bug caught by testing: repainting the whole strip on every tick
    // rebuilds the zone-picker's search input mid-search, silently reverting
    // an in-progress query back to the unfiltered list. Skipping the tick
    // while the picker is open fixes it; 30s (not 1s) is plenty for a clock
    // display anyway, matching this app's other "live" tick cadences.
    liveTimer = setInterval(() => { if (!state.scrubAt && !state.pickerOpen) paint(); }, 30000);
  }
  function stopLive() { if (liveTimer) clearInterval(liveTimer); liveTimer = null; }

  function addZone(zoneId, label) {
    if (state.zones.some((z) => z.id === zoneId)) return;
    state.zones.push({ id: zoneId, label: label || zoneId.split("/").pop().replace(/_/g, " ") });
    saveZones(state.zones);
    paint();
  }
  function removeZone(zoneId) {
    state.zones = state.zones.filter((z) => z.id !== zoneId);
    saveZones(state.zones);
    paint();
  }

  /** A 24h bar for one zone at the scrub reference day: coverage window
   * (mine, Mon-Fri 09:00-18:00 ET, per bizhours.js's own DAY_START/END),
   * that zone's own 09:00-18:00 local working hours, and weekend greying --
   * all as a single linear-gradient background so no extra DOM per band. */
  function barBackground(zoneId, refMoment) {
    // My coverage window, converted into this zone's percent-of-day position
    // by finding the instants of 9am/6pm ET on the reference day (binary
    // search, not offset algebra -- simplest correct approach given zones
    // with non-integer UTC offsets) and expressing them as a fraction of
    // *this zone's* local day.
    const pctOfDay = (d) => {
      const p = tz.partsIn(zoneId, d);
      return (p.hour * 60 + p.minute) / 1440;
    };
    // Find the instant of 09:00 and 18:00 ET on the reference (ET) day by
    // probing minute-by-minute is too slow; instead use each zone's own
    // formatter against a coarse binary search over a 24h window.
    function instantAtOwnHour(targetHour) {
      let lo = new Date(refMoment.getTime() - 20 * 3600000);
      let hi = new Date(refMoment.getTime() + 20 * 3600000);
      for (let i = 0; i < 30; i++) {
        const mid = new Date((lo.getTime() + hi.getTime()) / 2);
        const p = tz.partsIn(OWN_ZONE, mid);
        const midMinutes = p.hour * 60 + p.minute;
        if (midMinutes < targetHour * 60) lo = mid; else hi = mid;
      }
      return hi;
    }
    const coverStart = pctOfDay(instantAtOwnHour(9)) * 100;
    const coverEnd = pctOfDay(instantAtOwnHour(18)) * 100;

    const weekend = tz.isWeekendIn(zoneId, refMoment);
    const zoneWorkStart = (9 / 24) * 100;
    const zoneWorkEnd = (18 / 24) * 100;

    const stops = [];
    stops.push("var(--surface-3) 0%");
    if (!weekend) {
      // zone's own working hours -- a light tint
      stops.push(`var(--surface-3) ${zoneWorkStart}%`);
      stops.push(`color-mix(in srgb, var(--blue) 8%, var(--surface-3)) ${zoneWorkStart}%`);
      stops.push(`color-mix(in srgb, var(--blue) 8%, var(--surface-3)) ${zoneWorkEnd}%`);
      stops.push(`var(--surface-3) ${zoneWorkEnd}%`);
    }
    stops.push("var(--surface-3) 100%");
    let gradient = weekend
      ? "color-mix(in srgb, var(--text-4) 18%, var(--surface-3))"
      : `linear-gradient(to right, ${stops.join(", ")})`;

    // My coverage window overlay -- a stronger tint, on top conceptually
    // (rendered as a second gradient layer via multiple backgrounds).
    const covLo = Math.min(coverStart, coverEnd);
    const covHi = Math.max(coverStart, coverEnd);
    const coverGradient = `linear-gradient(to right, transparent 0%, transparent ${covLo}%, color-mix(in srgb, var(--green) 22%, transparent) ${covLo}%, color-mix(in srgb, var(--green) 22%, transparent) ${covHi}%, transparent ${covHi}%, transparent 100%)`;

    return coverGradient + ", " + gradient;
  }

  function rowFor(z) {
    const at = currentMoment();
    const p = tz.partsIn(z.id, at);
    const pct = ((p.hour * 60 + p.minute) / 1440) * 100;
    const isOwnToday = tz.partsIn(OWN_ZONE, at).day === tz.partsIn(OWN_ZONE, new Date()).day;

    return h("div", { class: "tz-row" },
      h("span", { class: "grab", text: "⠿" }),
      h("div", { class: "tz-row-label" },
        h("div", { class: "tz-row-name", text: z.label }),
        h("div", { class: "tz-row-abbr dim", text: tz.offsetLabel(z.id, at) })),
      h("div", { class: "tz-row-time" },
        h("div", { class: "mono tz-row-clock", text: tz.timeLabel(z.id, at) }),
        h("div", { class: "dim tz-row-date", text: tz.dateLabel(z.id, at) })),
      h("div", { class: "tz-bar", style: { background: barBackground(z.id, at) } },
        h("div", { class: "tz-bar-now", style: { left: pct + "%" } })),
      h("button", {
        class: "icon-btn tz-row-remove", type: "button", title: "Remove " + z.label,
        onclick: () => removeZone(z.id),
      }, icon(["M6 6l12 12", "M18 6L6 18"], 12)));
  }

  function zonePickerRow() {
    if (!state.pickerOpen) {
      return h("button", {
        class: "linkbtn", type: "button", text: "+ Add zone",
        onclick: () => { state.pickerOpen = true; paint(); },
      });
    }
    const input = h("input", {
      class: "input tz-picker-input", type: "text", placeholder: "Search time zones…", autofocus: true,
    });
    const results = h("div", { class: "tz-picker-results" });
    const renderResults = (q) => {
      const needle = q.trim().toLowerCase();
      const matches = (needle
        ? ALL_ZONES.filter((z) => z.toLowerCase().includes(needle))
        : ALL_ZONES
      ).slice(0, 40);
      mount(results, matches.map((z) => h("button", {
        class: "tz-picker-item", type: "button",
        onclick: () => { addZone(z); state.pickerOpen = false; paint(); },
      }, z.replace(/_/g, " "))));
    };
    renderResults("");
    input.addEventListener("input", (e) => renderResults(e.target.value));
    return h("div", { class: "tz-picker" },
      input,
      results,
      h("button", { class: "linkbtn", type: "button", text: "Cancel", onclick: () => { state.pickerOpen = false; paint(); } }));
  }

  function paint() {
    const at = currentMoment();
    const listHost = h("div", { class: "tz-rows" });

    mount(container,
      h("div", { class: "tz-strip-head" },
        h("button", {
          class: "btn sm", type: "button", text: "Now", disabled: !state.scrubAt || null,
          onclick: () => { state.scrubAt = null; paint(); },
        }),
        h("input", {
          type: "range", class: "tz-scrubber", min: 0, max: 1439, step: 5,
          value: (() => { const p = tz.partsIn(OWN_ZONE, at); return p.hour * 60 + p.minute; })(),
          oninput: (e) => {
            const mins = Number(e.target.value);
            const base = new Date(at);
            const dayStart = new Date(base); dayStart.setHours(0, 0, 0, 0);
            state.scrubAt = new Date(dayStart.getTime() + mins * 60000);
            paint();
          },
        }),
        h("span", { class: "dim mono", text: tz.timeLabel(OWN_ZONE, at) + " " + tz.offsetLabel(OWN_ZONE, at) + " (mine)" }),
        h("button", {
          class: "linkbtn", type: "button", text: "Copy as commitment phrase",
          onclick: () => copyToast(tz.commitmentPhrase(at, OWN_ZONE, OWN_ZONE), "Commitment phrase copied"),
        }),
        h("div", { class: "spacer" }),
        zonePickerRow(),
        h("button", {
          class: "icon-btn", type: "button", title: "Close",
          onclick: () => setOpen(false),
        }, icon(["M6 6l12 12", "M18 6L6 18"], 14))),
      listHost);

    mount(listHost, state.zones.map(rowFor));

    // Drag-reorder lifted from queue.js's openColumnPicker() -- see tz.js.
    tz.makeDraggableList(listHost, state.zones.map((z) => z.id), (id) => {
      const z = state.zones.find((zz) => zz.id === id);
      const row = rowFor(z);
      row.dataset.dragId = id;
      return row;
    }, (newOrder) => {
      state.zones = newOrder.map((id) => state.zones.find((z) => z.id === id));
      saveZones(state.zones);
    });
  }

  toggle.addEventListener("click", () => setOpen(!state.open));
  toggle.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!state.open); }
  });

  if (state.open) { container.hidden = false; paint(); startLive(); }
}
