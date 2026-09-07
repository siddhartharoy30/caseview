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
