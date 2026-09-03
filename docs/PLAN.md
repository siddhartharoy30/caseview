# QView Rebuild — Plan

Written at the end of Phase 0. Build order, data model, routes, and dependencies, each
with a justification. Deviations from the current system are called out explicitly, per
guardrail 1 ("note any change in `docs/PLAN.md` first").

## Stack decision

Stay on the current stack: **Express 4 + TypeScript + better-sqlite3 + vanilla ES modules
in the browser.** No React, no Vite, no bundler.

Justification: the app is a single-user internal dashboard behind a VPN. A framework would
add a build step, a `node_modules` tree in the image, and a class of runtime errors that
the current setup cannot have. The nine pages are all "fetch JSON, render a table or a
list", which vanilla DOM handles fine. The one thing the current front end genuinely lacks
is *structure* — one 1,200-line `dashboard.js` — and that is fixed by splitting into ES
modules served directly (`<script type="module">`), which every browser I care about
supports natively.

## Dependencies to add

| Package | Why |
|---|---|
| *(none)* | Everything needed is already present or in the standard library. |

Specifically avoided:

- **A date library (`date-fns`, `luxon`).** Business-hours math and EST/UTC formatting are
  done with `Intl.DateTimeFormat` and a small `src/businessHours.ts`. The rules are
  fixed (Mon–Fri, 09:00–18:00 America/New_York) and about 80 lines; a library would be
  more code in the image than the code it replaces.
- **A charting library.** The charts required are bar, line, and histogram. They are drawn
  as CSS flex columns and inline SVG polylines — the same approach the existing component
  chart already uses successfully, and it keeps the "no third-party scripts near customer
  data" rule trivially true.
- **A router library.** ~60 lines of `history.pushState` + a path-pattern matcher.
- **A front-end framework.** See above.

SQLite FTS5 is used for cross-case search. It is compiled into better-sqlite3 already, so
this is a schema decision, not a dependency.

## Data model

New SQLite schema in `/data/qview.db`, alongside the existing `suggested_replies` table
(which is left untouched — guardrail 1).

```
cases
  id                TEXT PRIMARY KEY      -- Salesforce 18-char Id
  case_number       TEXT UNIQUE NOT NULL
  subject           TEXT
  description       TEXT
  status            TEXT
  priority          TEXT
  type              TEXT
  origin            TEXT
  problem_type      TEXT                  -- Problem_Type__c
  sub_component     TEXT
  account           TEXT
  contact_name      TEXT
  owner_name        TEXT
  is_escalated      INTEGER
  is_closed         INTEGER
  labels            TEXT
  created_date      TEXT                  -- ISO 8601, as returned by SF
  last_modified     TEXT                  -- drives delta sync
  closed_date       TEXT
  ncc_date          TEXT
  last_customer_update TEXT
  active_ttr        REAL
  product_area      TEXT                  -- derived, see below
  first_response_at TEXT                  -- derived from comments
  last_my_touch     TEXT                  -- derived from comments
  last_customer_touch TEXT                -- derived from comments
  needs_my_reply    INTEGER               -- derived
  synced_at         INTEGER

comments
  id                TEXT PRIMARY KEY      -- SF CaseComment.Id or EmailMessage.Id
  case_id           TEXT NOT NULL REFERENCES cases(id)
  source            TEXT NOT NULL         -- 'comment' | 'email'
  body              TEXT NOT NULL
  is_public         INTEGER NOT NULL
  author            TEXT
  is_mine           INTEGER NOT NULL      -- author == SALESFORCE_OWNER_NAME
  created_date      TEXT NOT NULL
  synced_at         INTEGER

comments_fts        -- FTS5 virtual table over (body), external content = comments
cases_fts           -- FTS5 virtual table over (subject, description)

commitments
  id                TEXT PRIMARY KEY
  case_id           TEXT NOT NULL REFERENCES cases(id)
  case_number       TEXT NOT NULL
  due_at            TEXT                  -- ISO 8601 UTC; NULL when unparsed
  raw_text          TEXT NOT NULL         -- the sentence it came from
  source            TEXT NOT NULL         -- 'parsed' | 'manual'
  source_comment_id TEXT                  -- provenance for parsed ones
  state             TEXT NOT NULL         -- 'active'|'met'|'breached'|'superseded'|'dismissed'|'unparsed'
  superseded_by     TEXT                  -- commitment id, for renegotiation history
  met_at            TEXT                  -- reply timestamp that satisfied it
  created_at        INTEGER NOT NULL
  updated_at        INTEGER NOT NULL

artifacts
  id                TEXT PRIMARY KEY
  case_id           TEXT NOT NULL REFERENCES cases(id)
  kind              TEXT NOT NULL         -- cluster_id|cluster_name|version|node_count|
                                          -- error_code|log_bundle|bucket|job_id|ip|jira
  value             TEXT NOT NULL
  first_seen        TEXT                  -- comment created_date it came from
  UNIQUE(case_id, kind, value)

sync_state
  key               TEXT PRIMARY KEY      -- 'cases'|'comments'
  last_modified     TEXT                  -- watermark for delta sync
  last_success      INTEGER
  last_error        TEXT
  error_count       INTEGER
  api_calls         INTEGER

settings          key TEXT PRIMARY KEY, value TEXT   -- server-side prefs (sync interval, thresholds, webhook)
manual_metrics    id, period_start, period_end, csat, nps, iqs, note, created_at
```

Client-side (`localStorage`) holds only presentation state: column visibility and order,
density, theme, saved views, sidebar collapsed. Nothing derived from case data, so a
cleared browser loses nothing but layout.

### Derived fields, and where they are computed

Computed **server-side during sync** and stored, because Phases 4–6 need to query them:

- `product_area` — `Problem_Type__c` when present, else keyword match over subject +
  description against CDM, RSC, AWS, Azure, GCP, M365, Archival, Cyber Recovery.
- `last_my_touch`, `last_customer_touch`, `first_response_at`, `needs_my_reply` — from the
  comment stream. `needs_my_reply` = the newest comment is not mine and the case is open.
- Commitments and artifacts — extracted from comment bodies on insert.

Computed **client-side at render**, because they change every second:

- Age, countdowns, relative times, row state classes, badge counts.

## Routes

### Pages (client-side, `history.pushState`)

| Path | Page | Notes |
|---|---|---|
| `/` | Queue | default; filters live in the query string |
| `/case/:caseNumber` | Case detail | tabs via `?tab=timeline\|artifacts\|commitments\|related\|draft` |
| `/commitments` | Commitments | |
| `/metrics` | IQS Scorecard | `?period=week\|month\|quarter\|half\|custom` |
| `/triage` | Triage | |
| `/escalations` | Escalations | |
| `/search` | Search | `?q=` |
| `/patterns` | Patterns | |
| `/settings` | Settings | |

Express serves `index.html` for any non-`/api`, non-asset path so deep links and reload
both work.

### API (server)

Existing, unchanged in shape — guardrail 1:

| Method | Path |
|---|---|
| POST | `/api/auth/login`, `/api/auth/logout` |
| GET | `/api/auth/me` |
| GET | `/api/cases` — same JSON shape, now served from cache |
| GET | `/api/cases/search?q=` |
| POST | `/api/intelligence/suggest-reply` |
| GET | `/api/app-versions` |

New:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cases/:caseNumber` | one case + derived fields |
| GET | `/api/cases/:caseNumber/timeline` | comments + emails, public and internal |
| GET | `/api/cases/:caseNumber/artifacts` | extracted key-values |
| GET | `/api/cases/:caseNumber/related` | same account / signature / product area |
| GET | `/api/commitments` | `?state=`, all cases |
| POST | `/api/commitments` | manual add |
| PATCH | `/api/commitments/:id` | edit, dismiss, mark met, **renegotiate** |
| GET | `/api/metrics?period=` | scorecard aggregates |
| GET | `/api/metrics/manual`, POST same | CSAT / NPS / IQS entries |
| GET | `/api/search?q=` | FTS5 across cases + comments |
| GET | `/api/patterns` | clustered signatures |
| GET | `/api/settings`, PATCH same | server-side prefs |
| POST | `/api/sync` | manual refresh / full resync (`?full=1`) |
| GET | `/api/sync/status` | last sync, staleness, error count |
| GET | `/healthz` | unauthenticated liveness + sync summary |

**Change to note (guardrail 1):** `GET /api/cases` stops hitting Salesforce on every
request and reads the cache instead. The response body keeps the exact same field names,
so the existing front end would still work against it unchanged. The one behavioural
difference is that data can now be up to one sync interval old — which is why the response
gains a `syncedAt` field and the UI gains a staleness banner.

**Second change to note:** `getCaseComments()` currently filters `IsPublished = true`. The
Timeline tab requires internal comments too, so that filter is removed and `IsPublished` is
carried through as `is_public`. Internal comments are visually distinct and filterable in
the UI, and are never fed to the customer-facing draft path — `claude.ts` keeps asking for
public-only.

## Build order

Each phase ends with a commit and a live verification pass (guardrails 5 and 6).

**Phase 1 — cache + sync + shell.** The spec lists the shell as Phase 1 and the cache as
cross-cutting, but the cache is a hard prerequisite for Phases 2–6 (badge counts, "needs my
reply", commitments, metrics, search all read it), so it is built first inside Phase 1
rather than retrofitted later.

1. `src/log.ts` — structured JSON logger to stdout and file.
2. `src/db.ts` — new tables, FTS5, migrations. Additive; `suggested_replies` untouched.
3. `src/salesforce.ts` — widen the comment query, add `EmailMessage`, add delta-by-
   `LastModifiedDate` and a closed-case window for metrics.
4. `src/productArea.ts`, `src/artifacts.ts`, `src/businessHours.ts`, `src/commitments.ts`
   — pure functions, unit-testable by hand.
5. `src/sync.ts` — background loop, delta by watermark, exponential backoff, active-window
   gating, API-call accounting.
6. `src/server.ts` — serve `/api/cases` from cache, add `/api/sync/status` and `/healthz`,
   SPA fallback.
7. `public/index.html` + `public/css/*` + `public/js/router.js`, `app.js`, `lib/*` — shell,
   sidebar, top bar, dual clock, health dot, badge counts, keyboard shortcuts, skeletons.

**Phase 2 — Queue.** The table, all eleven columns, row states, saved views, multi-sort,
group-by, density, keyboard nav, context menu, CSV.

**Phase 3 — Case detail.** Five tabs, prev/next.

**Phase 4 — Commitments.** Parser is written in Phase 1 (sync needs it); this phase is the
page, the bands, the duplicate warning, manual CRUD, and renegotiation.

**Phase 5 — Metrics.** Aggregates endpoint + scorecard page + drill-through links.

**Phase 6 — Triage, Escalations, Search, Patterns, Settings.** Plus notifications and the
optional webhook, `.env.example`, `docker-compose.yml`, `README.md`.

## Risks

- **Salesforce API volume.** Delta sync keeps steady-state cost to one query per interval
  plus one comment query per changed case. The first full sync of comment history is the
  expensive one; it runs once, is chunked, and is visible in the API-call counter.
- **`EmailMessage` access.** If the connected app cannot read `EmailMessage`, the timeline
  degrades to `CaseComment` only. The sync catches that error, records it, and the UI says
  emails are unavailable rather than pretending there are none.
- **Commitment parsing false negatives.** Mitigated by the `unparsed` state: anything that
  looks like a commitment but does not yield a datetime is surfaced for manual fixing
  rather than dropped.

## Changes to existing behaviour

**Phase 3 → `public/js/pages/queue.js`.** The case page's prev/next has to walk the queue
in the order you are actually looking at — your filters, your sort, your grouping — and
that ordering only ever exists in the browser. `paint()` now writes the visible case
numbers to `localStorage` under `qview.queue.order` on every repaint. Case numbers only;
no case content leaves the table. Nothing else about the Queue changed, and the case page
degrades to disabled prev/next controls when the key is absent, so a direct URL visit
without having opened the Queue first still works.

**Phase 4 → `src/queries.ts`.** `listCommitments` now LEFT JOINs `cases`, so every row
returned by `GET /api/commitments` also carries `subject`, `account`, `priority`, `status`
and `isClosed`. Purely additive — no field was renamed or removed, and existing consumers
see the same keys they saw before. The join is a LEFT one on purpose: a commitment whose
case has fallen out of the cache reports `isClosed: false`, because that case is not
closed, it is unknown, and defaulting it to closed would hide a live deadline.
`listCommitmentsForCase` still passes `null` and is byte-for-byte unchanged in behaviour —
the case page already has the case.

**Phase 4 → `public/js/pages/caseDetail.js`.** The HTML-to-text sanitizers
(`decodeEntities`, `htmlToText`, `splitQuoted`, `highlightInto`, `textNodes`, `oneLine`)
moved out to `public/js/lib/text.js`, and the copy affordance (`copyToast`, `copyBtn`)
moved to `public/js/lib/ui.js`. Both are lifts, not rewrites: the case page imports the
same functions and renders identically. One behaviour did change — the copy failure toast
passed `"error"`, which `toast()` does not recognise, so it displayed for 2.2s with no
error styling; it now passes `"err"`. The extraction is the point: Commitments and, later,
Search have to escape customer-authored HTML by exactly the same rules the case page does,
and two copies of an escaping routine drift.

**Phase 4 → `public/js/app.js` contract.** The sidebar risk badge has linked to
`/commitments?state=at-risk` since Phase 1, but nothing read that parameter, so clicking it
landed on an unfiltered page that looked like the filter had applied. The Commitments page
now honours `?state=`, accepting both the band ids it emits itself and the spellings the
rest of the app already uses. `app.js` was not modified.

**Phase 5 → `public/js/pages/queue.js`.** The Queue learned four new URL parameters —
`cases`, `opened`, `closed` and `caseStatus` — and one new derived flag, `escalated`.
This is additive: no existing parameter changed meaning, and a URL that worked before
Phase 5 produces the same rows after it. The four exist because the Scorecard has to be
able to name the exact population behind every number it prints, and the toolbar filters
could not express three of those populations: a set of specific cases (the initial-response
misses), a date window (everything opened or closed inside the period), and an exact status
string (the open-by-status breakdown). Windows are half-open — `from` inclusive, `to`
exclusive — matching the arithmetic the server already does in `resolveRange`, so a tile
and its drill-through count the same rows rather than nearly the same rows. Either end may
be blank, which is what lets the aging chart's open-ended `30d+` bucket drill through
without a fifth parameter. `escalated` is deliberately absent from the `_state` precedence
list, because escalation is a property of a case, not a state of my queue, and letting it
outrank "customer is waiting on me" would bury the thing the Queue exists to surface.

Two supporting changes came with it. Because these parameters arrive from a link rather
than from a control the user can see, `drillChips()` renders one dismissable chip per
active drill in the result line — a filter with no visible affordance is a filter the user
blames on the data. And the empty state now recognises a drill that came up empty only
because the Queue defaults to open cases while the Scorecard counts closed ones too, and
offers "Include closed cases" instead of the generic nothing-here message.

**Phase 5 → `src/metrics.ts`, `volume[].meanTtrHours`.** One extra field on a query that
was already running, computed from the same rows the daily `closed` count comes from.
Additive; nothing else in the payload moved. It is `null`, not `0`, on a day that closed
nothing: a gap in the resolution-time trend is honest, whereas a zero is a claim that
cases were resolved instantly. The chart honours that by splitting its polyline into
separate runs at each null rather than drawing through the gap.

**Phase 5 → `src/metrics.ts`, `escalations`.** This is the one breaking change in the
phase. The field was a single number counting cases that are either flagged escalated or
sitting at P0/P1; it is now `{ flagged, p1 }`. The old scalar was unusable on a page whose
whole premise is that every number can be clicked: the Queue can filter on the escalation
flag and it can filter on priority, but it cannot express the union of the two, so the
only drill-through available for that tile would have landed on a different population
than the tile had counted. Two numbers that each drill exactly are worth more than one
number that drills approximately. Nothing outside the Scorecard consumed the field.

---

## Phase 6 — Settings, notifications and the event stream

### What landed

**Server**

- `src/db.ts` — two new rows in `SETTING_DEFAULTS`: `escalationUpdateHours`
  (how long an escalated case may sit without an update before Escalations
  calls it overdue, default 24) and `webhookIncludeSubject` (default
  `"false"`). Added the `events` table plus its indexes, and taught
  `cacheCounts()` to report `events` alongside the other five counts.
- `src/notify.ts` (new) — turns sync results into rows in `events`. One row
  per thing worth telling the user about: a new case assigned, a customer
  reply, a case going stale, an SLA clock going red, a commitment coming due
  or breaching, an escalation aging past `escalationUpdateHours`. Dedupes on
  `(kind, caseId, dayKey)` so a case that is still stale tomorrow produces one
  row tomorrow, not one row per sync. Also owns the outbound webhook: off by
  default, https only, and it sends a case number and an event kind — the
  subject line goes only if `webhookIncludeSubject` is on.
- `src/sync.ts` — calls `runEvents` at the end of a successful sync, inside
  the same try so a notification bug can never fail a sync.
- `src/server.ts` — `GET /api/events?since=<ms>` (returns rows plus a server
  `now` so the client never has to trust its own clock for the next cursor)
  and `POST /api/settings/test-webhook`. `/api/sync/status` now also returns
  `intervalMinutes` and the three active-window fields, because the shell
  colours its health dot by how late a sync is and "late" only means anything
  inside the window — overnight there is nothing to be late for.

**Client**

- `public/js/lib/notify.js` (new) — polls `/api/events` once a minute, holds
  the cursor, and raises at most three desktop notifications per poll so a
  backlog cannot produce a wall of them. Per-kind preferences live in
  localStorage. Clicking a notification navigates to the case.
- `public/js/pages/settings.js` — the real page, replacing the placeholder.
  Seven sections: connection, schedule, thresholds, notifications, webhook,
  appearance, cache.
- `public/js/app.js` — starts the notification poller after login, and the
  header theme toggle now mirrors to the server the same way Settings does.
- `public/css/app.css` — styles for every class the Phase 2–6 pages use. The
  settings family is `.set-`, not `.st-`: `.st-` was already the
  commitment/case *status* family, and reusing it would have silently
  restyled every status chip in the app.

### Decisions worth recording

1. **Theme and density are browser state, not server state.** `app.js` reads
   localStorage and toggles a body class; nothing consults the server's
   `theme` row. So the Appearance controls drive the same localStorage keys
   `app.js` reads, mirror them to the server so the two cannot drift, and the
   section says where the value actually lives rather than pretending the
   server is in charge.

2. **Numeric settings save on blur, not behind one Save button.** A single
   Save invites the half-typed-then-navigated-away failure. Per-field commit
   with per-field validation means an invalid interval never leaves the field,
   and a valid one is stored before you can lose it. Ranges are enforced
   client-side because the server stores every setting as an opaque string.

3. **The saved state is the server's echo, never the typed value.** After a
   successful `PATCH /api/settings` the page adopts `res.settings`, so what
   the page shows is what the server actually holds.

4. **Rebuilding the cache is the only destructive control in the app**, so it
   is the only one behind a confirmation, and the confirmation names the exact
   counts about to be deleted rather than saying "all data".

5. **The webhook is the only thing in QView that sends anything off the
   machine**, so its section leads with a banner saying exactly that and
   exactly what is in the payload. Off by default; https enforced before both
   Save and Send test; the subject line is behind a second, separate toggle.

### Fixed along the way

- The sync chip had been stuck on "never synced" since Phase 1: `paintSync()`
  read snake_case keys from a camelCase payload and treated epoch-ms as
  seconds. Fixed on both ends.
- Health-dot staleness now respects the active window instead of going amber
  every night.
