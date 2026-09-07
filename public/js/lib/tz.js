/**
 * Time zone strip (v4 phase 7) -- a Savvy-Time-style scrub bar, sourced
 * entirely from `Intl`, never SavvyCal. `Intl.supportedValuesOf("timeZone")`
 * is the full IANA list with no network call, no key, no dependency, and it
 * is correct across DST transitions because the browser's own tz database
 * backs it -- see docs/PLAN_V4.md for the SavvyCal-vs-Intl note.
 *
 * Deliberately does not touch `fmt.clockEastern`/`fmt.clockUtc` -- app.js's
 * `withinActiveWindow()` parses `fmt.clockEastern(now)`'s exact output, so
 * this module builds its own formatters instead of reusing or changing
 * those two.
 */

export function zoneList() {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["America/New_York", "UTC", "Asia/Kolkata", "America/Los_Angeles"];
  }
}

const partsCache = new Map();

function formatterFor(zone, opts) {
  const key = zone + "|" + JSON.stringify(opts);
  let f = partsCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...opts });
    partsCache.set(key, f);
  }
  return f;
}

/** { hour, minute, weekday(1-7, Mon=1), day, month, year } in `zone` at `at`. */
export function partsIn(zone, at) {
  const f = formatterFor(zone, {
    hour: "numeric", minute: "2-digit", hour12: false,
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
  const parts = Object.fromEntries(f.formatToParts(at).map((p) => [p.type, p.value]));
  const WEEKDAY_NUM = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekdayShort: parts.weekday,
    weekdayNum: WEEKDAY_NUM[parts.weekday] ?? 0,
    day: Number(parts.day),
    month: parts.month,
    year: Number(parts.year),
  };
}

/** "9:41 AM" in `zone`. */
export function timeLabel(zone, at) {
  return formatterFor(zone, { hour: "numeric", minute: "2-digit", hour12: true }).format(at);
}

/** "GMT-4" or, for zones with a recognized abbreviation, "EST"/"PDT" etc. --
 * whatever Intl itself resolves, so no table of abbreviations to maintain. */
export function offsetLabel(zone, at) {
  const f = formatterFor(zone, { timeZoneName: "short", hour: "numeric" });
  const part = f.formatToParts(at).find((p) => p.type === "timeZoneName");
  return part ? part.value : "";
}

export function dateLabel(zone, at) {
  return formatterFor(zone, { weekday: "short", month: "short", day: "numeric" }).format(at);
}

export function isWeekendIn(zone, at) {
  const wd = partsIn(zone, at).weekdayNum;
  return wd === 6 || wd === 7;
}

/**
 * The exact phrasing `commitments.ts`'s parser (and this project's own
 * outbound replies) treat as canonical: "6:00 PM EST on Monday, September 7,
 * 2026" for a future date, or "6:00 PM EST today, Monday, September 7, 2026"
 * when the scrubbed moment falls on the same calendar day as now -- in the
 * *support engineer's own* zone, since "today" is measured from where the
 * promise is being made, not from the zone being viewed.
 */
export function commitmentPhrase(at, zone, ownZone) {
  const timeF = formatterFor(zone, { hour: "numeric", minute: "2-digit", hour12: true });
  const time = timeF.format(at);
  const offset = offsetLabel(zone, at);
  const p = partsIn(zone, at);
  const weekdayFull = formatterFor(zone, { weekday: "long" }).format(at);
  const monthFull = formatterFor(zone, { month: "long" }).format(at);

  const isToday = partsIn(ownZone, at).day === partsIn(ownZone, Date.now()).day
    && partsIn(ownZone, at).month === partsIn(ownZone, Date.now()).month
    && partsIn(ownZone, at).year === partsIn(ownZone, Date.now()).year;

  const dateClause = `${weekdayFull}, ${monthFull} ${p.day}, ${p.year}`;
  return isToday
    ? `${time} ${offset} today, ${dateClause}.`
    : `${time} ${offset} on ${dateClause}.`;
}

/* -------------------------------------------------------- drag reorder --
 * Lifted from queue.js's openColumnPicker() (the app's one existing
 * HTML5-draggable + dataTransfer implementation) into a shared, generic
 * helper so this is the second use of one technique, not a third
 * hand-rolled copy. */
export function makeDraggableList(container, items, renderItem, onReorder) {
  function rebuild() {
    const nodes = items.map((id) => {
      const row = renderItem(id);
      row.draggable = true;
      row.dataset.dragId = id;
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", id);
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        for (const n of container.querySelectorAll("[data-drag-id]")) n.classList.remove("drag-over");
      });
      row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drag-over"); });
      row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = e.dataTransfer.getData("text/plain");
        if (!from || from === id) return;
        items.splice(items.indexOf(from), 1);
        items.splice(items.indexOf(id), 0, from);
        onReorder(items.slice());
        rebuild();
      });
      return row;
    });
    container.replaceChildren(...nodes);
  }
  rebuild();
  return { rebuild };
}
