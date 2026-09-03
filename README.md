# QView

A single-owner case desk for Salesforce. QView keeps a local mirror of the
cases you own, works out what needs attention and when, and gets out of the
way. It is read-only against Salesforce by default.

The problem it solves is not "I cannot see my cases" — Salesforce shows you
those. It is that the queue view does not tell you which of the twelve open
cases is about to breach, which one you promised something on and have not
delivered, or which customer replied while you were asleep. QView answers
those questions on one screen.

---

## What it does

**Queue** — every case you own, filterable and sorted by how urgent it
actually is rather than by last-modified. Facets for status, priority, product
area and whether the ball is in your court.

**Case detail** — the case, its full comment timeline, extracted artifacts
(log bundles, cluster IDs, versions, support bundles referenced anywhere in the
thread), related cases, and an optional AI-drafted reply.

**Triage** — the open queue banded by urgency, each case showing the SLA clock
that matters for it right now and how much of it is left.

**Commitments** — anything you promised in a comment ("I'll get back to you
Monday", "we'll have a patch by end of week"), extracted from your own text and
tracked to met, due, overdue or superseded. Also editable by hand.

**Escalations** — escalated cases that have gone quiet, ranked by how long
since the last real update against the `escalationUpdateHours` threshold.

**Metrics** — response times, backlog and throughput over time, plus an IQS
scorecard. Anything the cache cannot know is enterable by hand.

**Search** — full-text across cases and comments, SQLite FTS5, one box.

**Patterns** — recurring themes across the case history: which product areas
generate the most work, which issues keep coming back.

**Settings** — sync schedule and active window, the thresholds every other page
reads, notification preferences, an optional outbound webhook, appearance, and
cache rebuild.

Desktop notifications are opt-in and per-kind: new case assigned, customer
reply, case gone stale, SLA at risk, commitment due, commitment breached,
escalation aging.

---

## How it works

```
Salesforce ──REST──> sync ──> SQLite (/data/qview.db) ──> Express API ──> browser
                       │
                       └──> event derivation ──> notifications, optional webhook
```

A background sync runs every `syncIntervalMinutes` inside the configured active
window (default 08:00–20:00 New York), pulling changed cases and comments off a
watermark rather than refetching everything. Between syncs the app reads only
SQLite, so pages are instant and no page view costs a Salesforce API call.

Everything derived — SLA state, commitment extraction, artifact extraction,
product-area classification, staleness, IQS — is computed from the cache. That
means it recomputes on threshold changes without a resync, and it means the
whole thing works offline once the cache is warm.

The front end is vanilla ES modules with no bundler and no dependencies. Pages
are lazy-loaded with dynamic `import()`; charts are hand-rolled SVG.

### Layout

```
src/
  server.ts        Express app, all routes
  db.ts            schema, migrations, settings defaults
  config.ts        env parsing, fails fast on missing required vars
  salesforce.ts    OAuth refresh flow + REST client
  sync.ts          incremental sync loop
  commitments.ts   promise extraction from comment text
  artifacts.ts     log bundle / cluster ID / version extraction
  productArea.ts   case classification
  sla.ts           SLA clocks per priority
  businessHours.ts business-hours arithmetic (New York)
  metrics.ts       aggregates and IQS
  queries.ts       every read query
  notify.ts        event derivation, dedupe, outbound webhook
  claude.ts        AI reply suggestions
  auth.ts          single-email session auth
  log.ts           structured JSON logging

public/
  index.html
  css/app.css
  js/app.js        shell: routing, header, keyboard, theme
  js/lib/          dom, ui, fmt, api, store, notify
  js/pages/        one module per page

docs/
  PLAN.md                  build log, phase by phase, with the reasoning
  ARCHITECTURE_CURRENT.md
  FEATURE_GAP.md
```

### Data

Nine SQLite tables: `cases`, `comments`, `commitments`, `artifacts`, `events`,
`manual_metrics`, `settings`, `sync_state`, `suggested_replies`, plus FTS5
virtual tables over cases and comments.

Only `manual_metrics`, `commitments` you created or edited by hand, and
`settings` are yours. Everything else is a cache and can be rebuilt from
Salesforce at any time from Settings.

---

## Running it

### Docker (recommended)

```sh
cp .env.example .env      # fill in the five REQUIRED values
docker compose up -d --build
```

Then open http://127.0.0.1:3001.

The compose file binds to loopback deliberately — see *Security* below.

### Without Docker

Requires Node 22.

```sh
npm install
cp .env.example .env
# point the storage paths somewhere writable
echo 'QVIEW_DB_PATH=./data/qview.db'  >> .env
echo 'QVIEW_LOG_FILE=./data/qview.log' >> .env
npm run build
npm start
```

`npm run dev` runs `tsx watch` against `src/server.ts` instead.

### Configuration

Every variable is documented in `.env.example`. Five are required:
`SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_INSTANCE_URL`,
`SALESFORCE_REFRESH_TOKEN`, `QVIEW_ALLOWED_EMAIL`, and `SESSION_SECRET` must be
non-empty. The process exits at startup rather than running half-configured.

Sync schedule, active window and all the thresholds (`staleDays`,
`atRiskHours`, `escalationUpdateHours`, `closedCaseWindowDays`) are runtime
settings, not env vars — change them in the Settings page and they take effect
on the next read.

### First run

The first sync pulls open cases plus closed cases within
`QVIEW_CLOSED_WINDOW_DAYS`, and can take a few minutes. The header sync chip
shows progress. Until it completes there has been no successful sync, so
`/healthz` reports `stale` — that is expected, not a fault.

---

## Security

**Auth is one email address and nothing else.** Submitting exactly
`QVIEW_ALLOWED_EMAIL` grants a signed-cookie session. There is no password, no
second factor, and no user table. This is deliberate — it is a single-user tool
on a trusted host — but it means **QView must not be exposed to an untrusted
network.** The bundled compose file binds to `127.0.0.1` for that reason. If you
need remote access, put it behind something that does real authentication.

**Case data is customer data.** QView makes no external network calls with it,
carries no telemetry, and loads no third-party scripts. The one exception is
opt-in and off by default: the Settings webhook, which is https-only and sends a
case number and an event kind — the subject line only if you turn on a second,
separate toggle.

**Credentials never reach the browser.** All Salesforce access is server-side;
no token, client secret or instance URL is present in anything served to the
client. `.env`, `data/` and `certs/` are gitignored.

**Read-only against Salesforce.** QView pulls; it does not push. AI reply
suggestions are drafted into a textarea for you to copy — nothing is posted
back to a case.

---

## API

Every route below carries `requireAuth` except the three auth endpoints,
`/healthz` and `/api/app-versions`, which are open so a monitor can reach them
without a cookie.

| | |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | session |
| `GET /api/cases` · `/api/cases/:caseNumber` · `/timeline` · `/artifacts` · `/related` | cases |
| `GET /api/cases/search` · `/api/search` · `/api/facets` · `/api/counts` | search |
| `GET /api/commitments` · `POST /api/commitments` · `PATCH /api/commitments/:id` | commitments |
| `GET /api/metrics` · `POST /api/metrics/manual` · `DELETE /api/metrics/manual` | metrics |
| `GET /api/patterns` · `GET /api/events` | derived |
| `GET /api/settings` · `PATCH /api/settings` · `POST /api/settings/rebuild-cache` · `POST /api/settings/test-webhook` | settings |
| `POST /api/sync` · `GET /api/sync/status` | sync |
| `POST /api/intelligence/suggest-reply` | AI |
| `GET /healthz` · `GET /api/app-versions` | ops |
| `GET /go/case/:caseNumber` | redirect straight into Salesforce |

`/healthz` returns `ok`, `stale` or `degraded`, and is the one route that needs
no session so a monitor can reach it. `stale` means no successful sync for
longer than `syncIntervalMinutes + 15`; it becomes `degraded` with a 503 once
the error count is also above three, so a monitor pages on repeated failure
rather than on a quiet night. Note that `/healthz` does not consult the active
window, so it reads `stale` overnight by design — the in-app health dot does
consult it, via the window fields on `/api/sync/status`.

---

## Keyboard

`/` search · `g` then a key to go (`q` queue, `c` commitments, `m` metrics,
`t` triage, `e` escalations, `s` search, `p` patterns, `g` settings) ·
`r` refresh · `` ` `` toggle theme · `?` show all shortcuts.

---

## Development notes

- `src/*.ts` imports carry no `.js` extension; `public/js/**` imports do.
- Zero runtime dependencies on the front end. Keep it that way.
- Dark is the default theme; both themes are token-driven from the top of
  `app.css`. Never hard-code a colour in a rule without a `body.light`
  counterpart.
- `docs/PLAN.md` is the build log — each phase records what changed and, more
  usefully, why it was done that way.
