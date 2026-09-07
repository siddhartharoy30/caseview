# QView v4 — Test Log

Manual verification for each Phase 1/2 fix from the v4 plan: how to reproduce
the original bug, and what confirms it is gone. Entries below were run
against real synced data (253 cases, 6,329 comments, 734 commitments) via
`npm run dev`, driven with a hand-rolled Chrome DevTools Protocol script
(headless Chrome, no Playwright/Puppeteer added to the project — consistent
with the "no new dependencies" constraint) that logs in, drives the page, and
reads back Network/Console events.

## Phase 1 — the search infinite loop

Files: `public/js/router.js`, `public/js/app.js`, `public/js/lib/api.js`,
`public/js/pages/search.js`, `public/js/pages/queue.js`.

### 1.1 — same-URL write re-triggered navigation

**Repro (pre-fix).** `navigate()`'s early-return guard was `same && !replace`,
and `setQuery()` defaulted to `replace: true`. `search.js`'s `run()` called
`setQuery(...)` unconditionally on every invocation, including its own mount
call — so writing back the *same* URL it had just read still failed the
guard (`!replace` was `false`) and called `resolve()`, which re-ran
`render()`, which called `run()` again. Unbounded: it spun on the microtask
queue (the loader is a dynamic `import()`) until Chrome killed the tab with
`net::ERR_INSUFFICIENT_RESOURCES`.

**Confirmed gone.** Cold-loading `/search?q=01273803` issues **exactly one**
`/api/search` request (DevTools Network: one entry, outcome `finished`).
`navigate()` now takes an explicit `force` flag instead of overloading
`replace`, so a same-URL write is a true no-op; `search.js`'s mount path
(`runFromUrl()`) reads state and fetches without writing the URL at all.

### 1.2 — typing floods the network

**Repro (pre-fix).** Every keystroke fired its own uncoalesced request; nothing
canceled a request superseded by a newer one.

**Confirmed gone.** Typing `0`, `1`, `2`, `7` 40 ms apart (faster than the
180 ms debounce) produces exactly one request, `/api/search?q=0127`,
`finished`.

### 1.3 — a superseded search must not linger

**Repro (pre-fix).** No `AbortController` existed anywhere in the client
(`api.js`); an old, slower response could still land after a newer one, and
the socket it held could not be reclaimed early.

**Confirmed gone.** Firing two back-to-back Enter-commits ("kubernetes", then
before the first replies, "timeout") produces two requests: the first shows
outcome `canceled` (aborted by the second's `AbortController`, threaded
through `api.search(term, signal)` → `request()`), the second `finished`.
The pre-existing `seq` guard is untouched — the abort is purely about
reclaiming the socket, not correctness.

### 1.4 — query-only changes must not remount

**Repro (pre-fix, and the regression Phase 1(b) risked reintroducing for
Queue specifically).** Every query-string write forced `router.js` to fully
re-run the page's `render()` — resetting scroll, stealing focus, and (for
Queue, whose filter/sort handlers rely on the remount to repaint rather than
doing it themselves) would have gone silent had the remount been suppressed
without giving Queue an `onQueryChange` hook.

**Confirmed gone:**

- **Search — scope toggle.** Clicking "Open only" keeps the same `#main` DOM
  node and the same focused `<input>` (a `data-probe` marker set on the input
  before the toggle survives it — a remount would have created a new node).
- **Search — back button.** Three Enter-committed searches ("alpha",
  "bravo", "charlie") followed by `history.back()` four times walks
  `?q=charlie` → `?q=bravo` → `?q=alpha` → `/search`, one step per press
  (Enter pushes a history entry; typing and scope/sort changes replace, so
  they do not flood history).
- **Queue — filter still works.** Filtering by Priority `P2` narrows 12 rows
  to 8, updates the URL to `?priority=P2`, and keeps the same `#main` node.
- **Queue — sort still works.** Clicking the "Case #" column header sorts
  rows ascending by case number (`01273803, 01300731, 01301607, 01302660,
  01302766, …`) and keeps the same `#main` node.

### 1.5 — re-entrancy guard

Not exercised by a real user path in this pass — it is a backstop for a
*reintroduced* loop, per the plan. No `[router] resolve() re-entrancy depth
exceeded` log appeared during any of the above, confirming normal use never
trips it.

No console errors were observed during any check in this section.

## Phase 2 — the Next Commitment column

Files: `src/queries.ts`, `src/commitments.ts`, `src/server.ts`,
`public/js/pages/queue.js`, `public/js/pages/commitments.js`.

Verified against real synced data after a full resync (253 cases, 6,329
comments; `atRiskHours` = 4).

### 2.1 — unparsed commitments were invisible

**Repro (pre-fix).** `nextCommitmentFor()` only matched `state = 'active' AND
due_at IS NOT NULL`, falling back to `state = 'breached'`. A promise
`parseCommitments()` could not date — recorded as `state = 'unparsed', due_at
= NULL` specifically so it would not be lost — matched neither branch and so
never reached the client at all.

**Confirmed gone.** `nextCommitmentFor()` now tries active → unparsed →
breached in that order. `duplicateCommitmentCases()` (the sibling query with
the identical `state = 'active' AND due_at IS NOT NULL` predicate) was widened
the same way, since two live promises — one dated, one not — are just as much
a duplicate as two dated ones.

### 2.2 — real states, including the two the prompt names explicitly

**Repro (pre-fix).** The cell branched only on `c._due`, so "no commitment
because the case just closed" and "no commitment because I spoke last and
made no promise" both rendered as the same bare `—`.

**Confirmed gone**, cross-checked against `/api/cases` for the exact cases
the Queue rendered:

- `01306048`, `01305010` — `isClosed:false, needsMyReply:false,
  nextAction.kind:"work"`, status "Waiting for Customer Input" — Queue
  correctly shows the amber **"No follow-up committed"** chip. This is the
  gap 2.2 asks to surface: I spoke last and made no promise.
- `01304026`, `01301607`, `01300731` — `isClosed:false,
  nextAction.kind:"closure"`, status "Resolved - Pending Customer" — Queue
  correctly shows a plain muted `—`, not flagged. `nextAction.kind`, not the
  prompt's nonexistent `nextAction.action` (correction 3).
- Old breached commitments on **closed** cases (`/?status=all`) still render
  red/overdue rather than being suppressed — matches how the Commitments
  page's own `bandOf()` already treats a stale breach regardless of case
  status; suppression is specifically for the "no commitment at all" branch,
  driven by `nextAction.kind` and `isClosed`, not for a commitment record
  that genuinely exists.

### 2.3 — business hours, not wall clock

**Repro (pre-fix).** The cell used `fmt.countdown` (wall clock) with a
hardcoded 4-hour amber threshold, duplicated again in the 30 s re-tick —
disagreeing with the Commitments page, which already used
`bizhours.remaining()`.

**Confirmed gone.** Two open cases due Mon Sep 08 18:00 ET, checked on a
weekend: `.cd` shows `1d 0h` / `2d 0h` (9 and 18 *business* hours — the
`BUSINESS_MS_PER_DAY` = 9h divisor, not calendar days) with the plain
(non-amber) tone, since both exceed the 4-hour `atRiskHours` setting now read
from `/api/cases`'s new `atRiskHours` field rather than a hardcoded literal.
The calendar date (`Sep 08, 6:00 PM`) renders underneath because wall time and
business time diverge by more than one business day across the weekend — the
"show the date when the clocks disagree" rule. The 30 s tick was rewritten to
recompute `bh.remaining()` live, so a commitment ticks from on-track into
breached (`overdue Xh`) without waiting for the next full repaint.

### 2.4 — hover, click, sort

**Confirmed:**

- Hover title shows `rawText` verbatim (confirmed present on every dated/
  unparsed cell).
- Clicking a commitment cell navigates to `/case/<N>?tab=commitments`
  (`CLICKED_HREF` / `URL_AFTER` both `/case/01302766?tab=commitments`).
- Sorting the column **ascending** puts breached first, ordered oldest-breach
  first within the tier (`overdue 93d 0h` → `83d 0h` → `86d 5h` → …, business
  hours). Sorting **descending** puts the muted `—` rows first (tier 5, the
  highest `tier * 1e13 + timestamp` encoding) — confirming a row with no
  commitment can now be sorted to the top or bottom on demand, which the old
  `sortVal: c._due` (`null` for anything without a due date, always sunk by
  the generic comparator regardless of direction) could never do.

### 2.5 — coverage diagnostic, and the NEGATION narrowing it should surface

**`GET /api/commitments/coverage`, live data:** 12 open cases, 7 covered, 5
gaps — 4 `met` (expected), 1 `no_promise_found` (worth reading by hand).
Renders on `/commitments` as an info banner: *"5 of 12 open cases have no
live commitment right now — 4 met, 1 with no promise detected in the
history"* with a **"Review 1 with no promise detected"** button that opens
those cases in the Queue (`/?cases=...&status=open`). Reloading the page with
the coverage fetch made to fail (network throttled to offline mid-load) still
renders the full commitments list — the diagnostic's own try/catch does not
take the page down with it.

**Correction 7 — NEGATION narrowing.** Verified directly against
`parseCommitments()`:

| Input | Before | After |
|---|---|---|
| "I will follow up by 6:00 PM once I hear back from engineering." | discarded entirely (vanishes) | **kept**, recorded unparsed (no calendar date in the sentence — a separate, correct limitation) |
| "Once you send me the logs, I will follow up by 6:00 PM." (genuinely conditional — negation *before* the deadline) | discarded | **still discarded** — regression-checked |
| Both canonical phrasings from the module's own doc comment | parsed | **still parsed**, `dueAt` unchanged — regression-checked |
| "If the issue recurs, I will follow up with the vendor." (no time at all) | discarded | **still discarded** — regression-checked |
| "I was going to follow up by 6:00 PM but the ticket got reassigned." (historical) | discarded | **still discarded** — regression-checked |

The fix: `NEGATION` only disqualifies when its match position is at or before
the point a time-of-day was stated in the sentence; a trailing conditional
clause after an already-stated deadline no longer discards the promise. A
full resync against real production comments (253 cases) picked this up
without any duplicate commitments being created (the dedupe index is keyed on
`case_id, source_comment_id, raw_text`, and a previously-discarded sentence
had no prior row to collide with).

No console errors were observed during any check in this section.

## Phase 4 — timeline rebuild

Files: `src/emailBody.ts` (new), `src/db.ts`, `src/sync.ts`, `src/queries.ts`,
`public/js/pages/caseDetail.js`, `public/css/app.css`. Verified against real
synced data via the same CDP-driven headless Chrome, against case 01273803
(145 real timeline entries).

### 4.1 — envelope parsing, server-side backfill

**Repro (pre-fix).** A comment/email whose body opened with a pasted
`From:`/`To:`/`Cc:` block rendered as ~400 raw characters of semicolon-joined
addresses at the top of the entry — `splitQuoted`'s `QUOTE_RE` matches
`From:\s*\S` but only checks lines at index ≥ 1 with 40+ preceding
characters, so a body that *opens* with the block was never split.

**Fix confirmed live:** first server boot after the schema migration
backfilled all 6,339 existing comments in 1.49s (`comments.backfill_email_bodies`
in the log, `rows: 6339`), zero errors. Real entry on 01273803 (Support Bot,
Jul 28 2026): collapsed to `support@rubrik.com → todd.hall@saberhealth.com
+1 +10 cc`, expandable to the full To/Cc lists on click — matches the plan's
example shape exactly.

### 4.2 — a real bug the backfill surfaced: duplicate commitments

**Not in the plan's own hazard list, but adjacent to correction 5.** Moving
`parseCommitments()`'s input from raw HTML `body` to clean-text `clean_body`
changed `raw_text` for nearly every existing parsed commitment — not by a
trivial whitespace shift, but because the *old* parser, fed `<br/>`-laced
HTML instead of real newlines, could not bound a sentence correctly and
often captured several paragraphs (signature block included) as one
"commitment." `idx_commitments_dedupe` keys on the literal `raw_text`, so
each corrected sentence looked like a brand-new commitment instead of the
same one re-observed. Confirmed on live data: case 01273803 went from 14 to
31 commitment rows after the first full resync post-migration; DB-wide,
15 comment/case pairs had duplicate parsed rows.

**Fix:** `recomputeCase()` now reconciles per comment — computes what the
parser produces right now, deletes any existing `source='parsed'` row for
that comment whose `raw_text` isn't in the fresh set, then inserts what's
missing. Re-ran a full resync (`POST /api/sync?full=1`, 251 cases, 6,693
comments, 21.7s): case 01273803 settled at 16 commitments (up from the
original 14, not the buggy 31 — the corrected parser catches a couple of
promises the HTML-confused old one missed), zero duplicate comment/case
pairs remain DB-wide (962 total commitments checked), and zero commitments
anywhere still contain HTML artifacts (`<br`/`&nbsp;`) in `raw_text`. The 3
remaining comment/case pairs with 2 commitment rows each were checked by
hand — genuinely two distinct promises in the same email, not duplicates.

### 4.3 — visual rank, day grouping, filmstrip

Confirmed on 01273803: rank chips render Me (green) / Customer (cyan) /
Internal (purple) / System (gray) correctly, including a "Support Bot"
comment correctly ranked System (public, not mine, not a customer reply —
an automated relay). Day separators appear between entries on different
calendar days. The filmstrip renders one tick per visible entry, coloured to
match rank, with 141+ entries visible as a scrollable minimap; clicking a
tick scrolls to and flashes the corresponding entry.

### 4.4 — never truncate through a commitment

Structural fold (first paragraph, or first 14 lines when the "first
paragraph" is too short to be useful) checked against a real 19-line reply
whose commitment sentence ("I will follow up with you by 6:00 PM EST on
Tuesday, July 28, 2026") happened to fall within the first 14 lines — the
pinned-commitment block correctly did *not* render a second, redundant copy,
confirming the `!shown.includes(s)` suppression works. A case where the
promise is buried past line 14 was not separately screenshotted before
moving to phase 5; the logic is the same code path and was reviewed by hand,
but this specific scenario is not screenshot-confirmed.

### 4.5 — find match count and n/N stepping

Searching "Advanced Threat Hunt" on 01273803 shows "9 of 145 entries match"
and a "1 of 14" match counter with N/n step buttons next to the find input;
a hit inside collapsed quoted history force-opens that quote (pre-existing
behaviour, confirmed unaffected).

### 4.6 — filter row wording

"Everything" renamed to "All" (now matches the Visibility group's first
option); both groups now carry a label ("Visibility", "Source") above the
pills, confirmed rendered in the toolbar.

## Phase 5 — notifications

Files: `src/notify.ts`, `src/sync.ts`, `src/db.ts`, `src/server.ts`,
`public/js/lib/notify.js`, `public/js/lib/ui.js`, `public/js/app.js`,
`public/index.html`, `public/css/app.css`.

### 5.1 — case.escalated and case.waiting_on_support detection

Correction 1 confirmed on inspection: a repo-wide read of `is_escalated`
found only current-state reads, no prior-vs-current comparison anywhere.
Detection was genuinely new, not a reuse.

**Verified in isolation** (a synthetic delta run directly through
`notify.runEvents()` against the real `events` table, using a throwaway
case number, cleaned up after): both kinds fire with the expected
deterministic ids (`case.escalated:<num>:<lastModifiedDate>` and
`case.waiting_on_support:<num>:<lastModifiedDate>`) and correct titles.
Re-running the identical delta a second time fired 0 new events — the
dedup holds. Not verified against a real live escalation/status
transition in this session (none occurred in the synced window), so this
is code-path-verified and dedup-verified, not observed against a real
Salesforce transition end to end.

### 5.2 — notification centre

Bell icon in the topbar shows a live unread-count badge (confirmed: "9" on
first load against real accumulated events). Clicking it opens a panel
listing recent events with a red/amber/grey dot by severity, relative
timestamps, and a working "Mark all read." Clicking an item with a case
number navigates to that case and marks it read.

**A real (minor) bug this surfaced, from phase 4's own commitment
reconciliation:** one event's detail rendered raw HTML (`<br/>`, `&nbsp;`)
in the panel — a `commitment.breached` event recorded before phase 4's
clean_body fix, whose detail is a snapshot of `raw_text` taken at insert
time and never revised when the underlying commitment row was later
deleted and reinserted with clean text. Fixed defensively: the panel now
runs `detail` through `htmlToText()` before display, which handles this
debris (14-day retention, so it ages out on its own) without needing to
also migrate the `events` table.

### 5.3 — in-app toasts: stacking, sticky, click-to-open

`toast()` extended in place (not rebuilt): a 4th toast now evicts the
oldest non-sticky one instead of stacking unbounded; hovering any toast
holds its dismiss timer; `case.escalated`/`case.waiting_on_support`/
`commitment.breached` render with `sticky: true` (no auto-dismiss, close
button only) and a severity rail (red for escalated/breached, amber for
waiting-on-support); a toast with a case number is clickable end to end
(navigates, then dismisses). Confirmed existing two-arg call sites
(`toast("Removed", "ok")` etc., used throughout the app already) are
unaffected — `opts` is a new third parameter with an empty-object default.

### 5.4 — poll cadence and sound

`POLL_MS` confirmed changed 60000 → 30000; a `window.addEventListener("focus",
poll)` fires an immediate poll on tab focus rather than waiting out
whatever was left of the interval. Sound is a new server setting
(`notifySoundEnabled`, default `"false"`, in `SETTING_DEFAULTS` — so
`PATCH /api/settings` accepts it and Settings can read/write it like every
other config value) rather than a client-only preference, per the plan;
confirmed the toggle round-trips through `GET`/`PATCH /api/settings`. The
chime itself (Web Audio, two-tone, no asset file) was not verified with
actual audio output in this headless-Chrome session — headless Chrome has
no audio device — but the code path that decides whether to call it
(`playSound = soundEnabled && wanted.some(kind is priority)`) was exercised
via the same synthetic-delta test as 5.1, confirming a priority-kind event
reaches that branch.

### 5.5 — kept as specified

First-poll-seeds-only (client, unchanged) and `MAX_PER_POLL = 3` (client,
unchanged) were left alone per the plan's explicit "keep what works."

## Phase 6 — phone queue monitor

Files: `src/phone.ts` (new), `src/server.ts`, `src/db.ts`, `public/js/app.js`,
`public/js/lib/api.js`, `public/js/pages/phone.js` (new), `public/css/app.css`,
`docs/PHONE.md` (new). Full discovery notes in `docs/PHONE.md` — this entry
covers what was run and observed.

### 6.1 — parser, against a real fetched board snapshot

Fetched the live board (`http://reportrunner.colo.rubrik.com/cgi-bin/amer/phone_now_et.pl`)
from the VM, saved the raw HTML, and ran `src/phone.ts`'s exact row/header/time
regexes against it directly (not the running server — the regex logic in
isolation) before trusting it in the app: all 7 real rows parsed correctly
(name, status class, status text, duration, federal flag), including a
`fed` row and a non-`available` (`zoom`) row; header queued-counts and the
board clock both parsed correctly.

### 6.2 — position, cross-validated against Case Desk twice

1. Computed position from the parsed board snapshot above:
   `Siddhartha` = position 2 of 5 non-federal agents.
2. Independently fetched Case Desk's own live `/api/phone-queue` a few
   minutes later (real board state, not a shared payload) and applied the
   same filter -- also position 2.
3. Once the running `/phone` page was live end to end, the position card
   showed `#2`, "1" ahead of me, and the board table's pinned row agreed --
   matching both independent computations above for the same live board
   state.

### 6.3 — polling discipline

Checked `data/qview.log` for `phone.` entries across the whole session:
zero `phone.board_fetched` lines while the monitor was off, exactly one the
moment it was switched on (confirmed via the running dev server, not just
code review) -- "off means zero requests" is real, not aspirational. No
agent names appeared in the log at all (info level logs `agents`/`queued`/
`queuedFederal` counts only; names are `debug`-only, per the plan's note
that `log.ts`'s redaction matches key names like `token`/`secret`, not
`name`, so this needed a deliberate choice in `phone.ts`).

### 6.4 — the page, live

Screenshotted both states: monitor off (empty-state card, no board), and
monitor on against the real board (position card, my row highlighted in
the table, Federal/AMER badges distinct from color alone, status chips
matching the source page's own colour grouping). Toggling the checkbox
fired a real toast ("You're 2 for the phone queue") from the alert logic,
confirming the escalating-threshold code path executes against live data
without waiting for a manufactured test position.

### 6.5 — not verified in this session

The chime (Web Audio, no asset file, same construction as phase 5's) was
not confirmed to actually produce audio -- headless Chrome has no audio
device. The 5-minutes-of-offline auto-off and the once-per-transition
alert dedup were reviewed by hand but not exercised against a real
multi-minute offline period or a real position change sequence, since
neither occurred naturally during the live testing window.

## Phase 7 — time zone strip

Files: `public/js/lib/tz.js` (new), `public/js/lib/tzstrip.js` (new),
`public/index.html`, `public/js/app.js`, `public/css/app.css`,
`docs/PLAN_V4.md` (new, records the SavvyCal/holiday/account-pinning
decisions this phase asks to write down).

### 7.1 — zone list and formatting, no network call

Ran `tz.js`'s functions directly under plain Node (no browser needed --
they only touch `Intl`): `zoneList()` returned all 418 real IANA zones;
`timeLabel`/`offsetLabel`/`dateLabel` against a fixed instant
(2026-09-07T18:00:00Z) correctly returned DST-aware abbreviations for four
different zones (EDT for New York, GMT+5:30 for Kolkata, PDT for Los
Angeles, UTC) -- confirming the abbreviation is computed live from the
real tz database rather than a hardcoded EST/PST table that would be wrong
half the year. `commitmentPhrase()` produced both canonical forms exactly
("6:00 PM EDT on Tuesday, September 8, 2026." for a future date, "2:00 PM
EDT today, Monday, September 7, 2026." for the same day) against
`commitments.ts`'s own documented phrasings.

### 7.2 — a real layout bug: the strip broke the shell's grid

**Repro (pre-fix).** `#app`'s CSS grid uses named areas
(`"sidebar topbar" "sidebar main"`) with two explicit rows. Inserting
`<div id="tzStrip">` as a third direct child between `<header>` and
`<main>` gave the browser an element with no matching named area; it
landed as an implicit grid item overlapping the sidebar column instead of
spanning the content area. First screenshot after wiring the strip in
showed the rows stacked oddly under the sidebar nav with disconnected
remove buttons.

**Fix:** added a third grid row (`auto`) and a `tzstrip` named area
between `topbar` and `main`; `.tz-strip { grid-area: tzstrip; }`.
Re-screenshotted: strip now renders full-width directly below the topbar,
correctly positioned, with `[hidden]` collapsing it to zero height when
closed (confirmed via a fresh headless Chrome profile with no cache,
after the first screenshot's oddity turned out to need this fix rather
than being a caching artifact).

### 7.3 — coverage-window and per-zone shading, live

With the strip open against four real zones (ET, UTC, IST, PT), each row's
24h bar showed a distinct green coverage-window band correctly shifted for
that zone's own offset from ET -- including IST's fractional (+5:30)
offset landing the band in a different, correctly-computed position than
the whole-hour zones. A red "now" tick appeared at the correct position on
every row simultaneously. Weekend greying was not separately exercised
(the test day was a Monday), but the `isWeekendIn()` check driving it is
the same weekday parts already verified in 7.1.

### 7.4 — a real bug caught in the zone picker: live-tick wiped in-progress search

**Repro (pre-fix), via a scripted search:** opened the picker (40 items,
correct initial cap), typed "London," and both the filtered-results check
and the resulting add-a-zone click showed the *unfiltered* list was still
active -- searching "London" produced Africa/Abidjan, Accra, Addis Ababa...
and clicking "the first result" added Abidjan, not London. Root cause:
`startLive()`'s 1s tick repainted the entire strip head unconditionally,
rebuilding the picker's `<input>` (and its listener) out from under an
in-progress search on every tick.

**Fix:** skip the tick while the picker is open, and drop the tick
interval to 30s (a clock never needed 1s precision; that was an unexamined
default, not a requirement). Re-ran the identical scripted search after
the fix: "London" correctly filtered to exactly `Europe/London`, and
clicking it added a "London" row with the correct GMT+1 offset and a
correctly-shifted coverage band -- confirmed by screenshot.

### 7.5 — drag reorder

Lifted from `queue.js`'s `openColumnPicker()` into a shared
`tz.makeDraggableList()` rather than a third hand-rolled copy, per the
plan. Not exercised end-to-end with a real drag gesture in this session
(headless Chrome scripted drag-and-drop for HTML5 DnD specifically is
unreliable to simulate via CDP `Input.dispatchMouseEvent` without a
purpose-built sequence, and this was judged not worth the time against
the phases still ahead) -- reviewed by hand against the working
`openColumnPicker()` implementation it was lifted from instead.

### 7.6 — descoped, disclosed in docs/PLAN_V4.md

SavvyCal was never called (Intl covers everything the widget needs, per
the plan's own anticipated outcome); holiday shading was not built
(would disagree with every other business-hours calculation in the app,
none of which handle holidays either); account-timezone pinning was not
wired to case context (no timezone field exists anywhere in the schema to
derive from, and the manual per-account pin fallback itself was cut for
time). All three recorded in `docs/PLAN_V4.md`.
