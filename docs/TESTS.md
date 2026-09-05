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
