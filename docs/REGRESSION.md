# QView v9 — Regression checklist

Walked once now (v9 phase 0, baseline against `45aae9d`) and again after every
later v9 phase. Unlike `docs/TESTS.md` (a log of what a specific fix changed),
this is a standing checklist: the point is to notice if phase N breaks
something phase N-3 built, not to re-derive what each phase itself was for.

No test framework exists in this repo and this doc doesn't introduce one —
consistent with the project's standing no-new-dependency norm. "Walked" means
either driven live through `npm run dev` (this session has no login
credentials to script a full authenticated browser session, same disclosed
gap every phase of `docs/TESTS.md` already names), or verified structurally
via a throwaway `tsx` script / direct SQLite query against the running
`data/qview.db` where a live click-through isn't practical. Each phase below
should say which it did, not just tick a box silently.

## Queue (`/`)

- [ ] Scope tabs: Open / Closed / Left my queue / All each load and show the
      right rows.
- [ ] Filters: priority, account, product area, needs-reply, escalated —
      each narrows the list correctly.
- [ ] Sort: every sortable column, including the Quality column.
- [ ] Row click → case detail.
- [ ] Keyboard: `j`/`k` move selection, `Enter` opens the highlighted case,
      `.` opens row actions.
- [ ] CSV export produces a file with the expected columns and row count.
- [ ] Changing a filter/sort/scope updates the URL but does **not** remount
      the page (same `#main` DOM node, no scroll/focus reset) — the "v4 fix"
      (`router.js`'s `onQueryChange` + `queue.js`'s `refreshFromQuery()`).
      Only a scope (`status`) change should trigger a real server refetch.

## Case Detail (`/case/:caseNumber`)

- [ ] All tabs render: Timeline, Commitments, Artifacts, Related,
      Draft, Quality.
- [ ] The header's Quality badge/pill shows a score **before** the Quality
      tab is ever opened (reads `state.detail.case.iqs`, not a lazy fetch).
- [ ] RSC panel button/flow.
- [ ] CDM panel button/flow.
- [ ] Draft tab: staging a draft produces a live predicted score; the
      mechanical + model repair tiers both run when invoked.

## Commitments (`/commitments`)

- [ ] List loads, at-risk badge count is correct, manual "add commitment"
      works.

## Time Off (`/timeoff`) + embedded Coverage

- [ ] Time off list/add/delete.
- [ ] Coverage sub-section: channels, recent posts, 30-day backtest,
      approval queue (approve/discard).

## Escalations (`/escalations`), Triage (`/triage`)

- [ ] Both load and list the expected cases.

## Search

- [ ] Topbar search box: typing a query and pressing Enter navigates to
      `/search?q=...` and shows results.
- [ ] `/` from any other page focuses and selects the topbar search box.
- [ ] The `/search` route itself renders correctly on a cold load (not just
      via the topbar box) — this must keep working after Phase 4 removes the
      sidebar entry.

## Scorecard (`/metrics`), Quality (`/iqs`)

- [ ] Scorecard loads with correct period totals.
- [ ] Quality page: Layer 1 stats, Layer 2 stats (budget/sweep controls),
      the official-score import card, the Layer1-vs-Layer2 activity table.

## Settings (`/settings`)

- [ ] Every section loads and its controls read/write correctly: connection,
      schedule, thresholds, notifications, webhook, phone roster, connect
      launcher, appearance, cache.
- [ ] (After Phase 5) phone roster renders collapsed by default with a
      correct summary line; state persists across reload.

## Phone Queue (`/phone`)

- [ ] Board renders, position card shows the right number.
- [ ] Unclassified-agent banner appears when applicable, with a working
      "Classify" flow.
- [ ] Roster classify dialog.
- [ ] Dock (collapsed mini-panel) and pop-out both work; pop-out
      ownership/restore across tabs.

## Sync

- [ ] Manual sync button (`/settings` "Sync now") completes and updates
      `lastSuccess`.
- [ ] Scheduled tick fires inside the configured active window.
- [ ] Delta sync vs. full resync both work.
- [ ] Ownership reconciliation runs on both the empty-delta and normal
      paths of `runSync()`.
- [ ] Coverage sweep runs on real status transitions (not on a full/initial
      resync, which suppresses it intentionally).

## Notifications

- [ ] Desktop permission flow, sound toggles, toast duration setting.

## Auth

- [ ] Login with the allowed email, logout, and session-expiry redirect
      to login.

## Keyboard shortcuts overlay (`?`)

- [ ] Every row shown matches an actual working shortcut — no stale rows
      referencing a removed nav entry (Phase 4 must update this exactly).

## Theme / density

- [ ] Toggling each in Settings visibly changes the app and persists.

## Read-only invariant

- [ ] `grep -n "app\.post\|app\.delete" src/server.ts` — every route found
      writes only to QView's own SQLite cache or a local setting/roster/
      commitment/time-off/coverage row. None calls a Salesforce write API.
      (True today; the check is to keep it true after every phase.)

## Contributor-scoping invariant (Part A)

- [ ] `scoreCase()` in `src/iqs/layer1.ts` still filters to `all.filter(c =>
      c.isMine && ...)` before calling any dimension scorer.
- [ ] `scorableComments()` in `src/iqs/layer2.ts` still filters to
      `c.isMine` before building the Layer 2 prompt.
- [ ] Neither function is ever handed the case's full, unfiltered comment
      list for scoring purposes (only for context, e.g. `openingWindow()`'s
      cross-author index).

---

## Baseline walk (v9 phase 0, against `45aae9d`)

Walked via a mix of direct code reading (every checklist item above reflects
confirmed-current behavior as of this commit — this is the pre-v9 baseline,
not a bug hunt) and direct queries against the real running `data/qview.db`
for anything numeric. Everything above passes by definition at this baseline;
no code changed in phase 0 beyond adding measurement instrumentation
(`/api/debug/perf`, per-phase sync timing, `dbFileSize()`).

**Numbers captured, to compare against after Phase 6:**

- `cacheCounts()`: **12,766** total cases, **10,336** matching `is_closed=0
  AND owned=1`. This is far larger than a real single-engineer open queue
  should ever be (an earlier release's own record put the real open-case
  count after ownership reconciliation at ~12) — this local dev copy of
  `data/qview.db` is almost certainly a stale/unpruned historical cache, not
  representative of live production scale. The Phase 6 N+1 fix is correct
  regardless (it's a structural per-row cost, not a scale-dependent bug),
  but don't cite 10,336 as "how slow the real queue is today" — cite the
  measured latency below, which is real regardless of whether the row count
  is realistic.
- **`listCases({status: "open"})` timed directly** (via a throwaway `tsx`
  script, not the HTTP layer — no server was running with auth configured):
  **882ms** for 10,336 rows, all of it downstream of the base SELECT via the
  per-row `toApiCase()` N+1 (confirmed below).
- **`EXPLAIN QUERY PLAN`**, run directly against `data/qview.db`:
  ```
  sqlite> EXPLAIN QUERY PLAN SELECT * FROM cases WHERE is_closed = 0 AND owned = 1 ORDER BY created_date DESC;
  |--SEARCH cases USING INDEX idx_cases_open (is_closed=?)
  `--USE TEMP B-TREE FOR ORDER BY

  sqlite> EXPLAIN QUERY PLAN SELECT * FROM commitments WHERE case_id='x' AND state='active' AND due_at IS NOT NULL ORDER BY due_at ASC LIMIT 1;
  `--SEARCH commitments USING INDEX idx_commitments_state (state=? AND due_at>?)

  sqlite> EXPLAIN QUERY PLAN SELECT overall, band, keyword, scored_at FROM iqs_scores WHERE case_id='x' AND layer='layer1';
  `--SEARCH iqs_scores USING INDEX sqlite_autoindex_iqs_scores_1 (case_id=? AND layer=?)
  ```
  Confirms the plan's finding: the queue query seeks `is_closed` only (no
  index covers `owned` or `created_date`) and falls back to a full temp
  B-tree sort; the commitment lookup seeks `state` and residual-filters
  `case_id`. Both are what Phase 6's new composite indexes target.
- **`getLayer2Stats(30)`**: `{"scored":0,"hits":0,"misses":0,"errors":960,
  "skipped":0,"hitRate":null,"spendToday":0,"spend7d":0,"spend30d":0,
  "queueDepth":22}`. Worth noting honestly rather than glossing over: every
  one of the 960 recorded Layer 2 usage rows in this dev DB is an `error`
  outcome, not a real hit/miss mix — this local environment's Layer 2 budget
  is effectively unexercised. Not a v9 concern; just means Phase 6's
  Settings addition (surfacing this via `api.iqsOverview()`) will show a
  real "check your Anthropic key" signal rather than a healthy hit rate
  until that's addressed separately.
- **Largest cases by comment count**: `01106962` (2,143), `00529548`
  (2,021), `00728038` (1,957) — confirms the real worst case is far beyond
  the "141 comments" example the source prompt used; `caseDetail.js`'s
  `paintTimeline()` renders all of them on initial paint with zero
  windowing today (deferred to Phase 7 per the plan).

`npm run build` passes clean at this baseline.
