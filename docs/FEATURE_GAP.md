# Feature Gap — Reference QView vs Case Desk vs My QView

**Reference QView** (`http://10.0.3.102:3001/dashboard.html`) — reachable. A single 152 KB
self-contained HTML file. It is a **team triage board**, not a personal queue: it groups
unassigned cases by queue, shows theater (AMER/EMEA/APAC), counts down initial-response
SLA, and lets an engineer claim a case. Backend endpoints observed:
`/api/auth/me`, `/api/cases/:sfId/assign`, `/api/intelligence`, `/api/broadcast-messages/for-me`
(+ `/acknowledge`, `/dismiss`), `/api/app-versions`. Its SOQL is server-side and not
exposed to the client, so field mapping was inferred from the rendered payload
(`c.theatre`, `c.priority`, `c.labels`, `c.type`, `c.createdDate`, `c.id`). Refresh
interval `REFRESH_INTERVAL_SECONDS = 60` with a visible countdown. IR SLA table
`{P1: 30 min, P2: 2 h, P3: 4 h, P4: 8 h}` — identical to my `src/sla.ts` windows, which
confirms that mapping is right.

**Case Desk** (`https://10.26.117.234/`) — reachable. Endpoints `/api/cases`,
`/api/phone-queue`, `/api/cases/:id/draft`. A personal queue with a component pivot tab,
P1 and idle banners, a sortable table, and an AI draft modal with a staged loading
animation.

Verdict legend: **adopt** = build it; **adapt** = build a changed version; **skip** = not
applicable to a personal read-only queue; **have** = already in my QView.

## Shell, navigation, chrome

| Feature | Reference QView | Case Desk | My QView | Verdict |
|---|---|---|---|---|
| Multi-page routing with real URLs | ✗ (one page) | ✗ (two tabs) | ✗ | **adopt** — the core ask |
| Persistent left sidebar, collapsible | ✗ | ✗ | ✗ | **adopt** |
| Sidebar live badge counts | ✗ | ✗ | ✗ | **adopt** |
| Deep-linkable filter state in URL | ✗ | ✗ | ✗ | **adopt** |
| Multi-timezone clock | ✔ EST/CST/PST/Cork/IST | ✗ | ✗ | **adapt** — EST + UTC only |
| Last-fetched stamp + refresh countdown | ✔ | ✔ (`markRefreshed`) | ✔ sync pill | **have** (keep, move to top bar) |
| Manual refresh with spinner state | ✔ `setRefreshing` | ✔ | ✔ | **have** |
| Connection health dot | ✔ `#sf-dot` / `#sf-status` | ✗ | ✗ | **adopt** |
| Salesforce error banner + retry countdown | ✔ `showSfError` | ✗ | ✗ | **adopt** — becomes the staleness banner |
| Dark / light theme toggle | ✔ | ✔ | ✔ | **have** — flip default to dark |
| Version-history panel | ✔ | ✗ | `/api/app-versions` stub | **skip** — team release comms, not mine |
| Broadcast messages | ✔ | ✗ | ✗ | **skip** — team-ops feature |
| Impersonation bar | ✔ | ✗ | ✗ | **skip** — admin feature |
| Global search box in chrome | ✗ | ✗ | ✗ (in-page only) | **adopt** |
| Keyboard shortcuts | ✗ | ✗ | ✗ | **adopt** |
| Shortcut help overlay (`?`) | ✗ | ✗ | ✗ | **adopt** |

## Queue / table

| Feature | Reference QView | Case Desk | My QView | Verdict |
|---|---|---|---|---|
| Sortable table | ✔ | ✔ `sortedCases` | ✔ | **have** |
| Multi-sort (shift-click) | ✗ | ✗ | ✗ | **adopt** |
| Column show/hide + order persistence | ✔ tile reorder only | ✗ | ✗ | **adopt** |
| Group-by (queue / account / priority) | ✔ by queue, drag-reorder, collapsible | ✗ | ✗ | **adapt** — group-by selector |
| Saved views / filter presets | ✔ pillar filter pills | ✗ | ✗ | **adopt** + user-defined |
| Density toggle | ✗ | ✗ | ✗ | **adopt** |
| Priority colour chips | ✔ | ✔ | ✔ | **have** |
| Theater pill | ✔ | ✗ | ✗ | **skip** — my cases are all AMER |
| Labels column + label pivot popup | ✔ `renderLabelPivot` | ✗ | ✗ | **adapt** — folds into Patterns |
| Age with amber/red thresholds | partial | ✔ `fmtAge` | ✔ Active TTR | **adapt** — add 7 d / 14 d bands |
| Initial-response countdown | ✔ "IR Left" | ✗ | ✔ `computeSla` (unrendered) | **adopt** — surface it on Triage |
| Last customer touch | ✗ | ✔ | ✔ `Last_Customer_Update__c` | **have** |
| Last **my** touch | ✗ | ✗ | ✗ | **adopt** — needs comment cache |
| "Needs my reply" row state | ✗ | ✗ | ✗ | **adopt** — the single most important state |
| Stale row state | ✗ | ✔ idle banner | ✔ idle banner | **adapt** — promote to a row state |
| Commitment due / breached row state | ✗ | ✗ | ✗ | **adopt** |
| Product area derived from text | ✗ | ✔ pillars | ✔ `Problem_Type__c` | **adapt** — SF field first, keyword fallback |
| P1 banner | ✗ | ✔ `updateP1Banner` | ✔ | **have** |
| Row click → detail | ✔ opens intel panel | ✔ opens modal | ✔ modal | **adapt** — route to `/case/:n` |
| Right-click row menu | ✗ | ✗ | ✗ | **adopt** |
| Click-to-copy case number | ✗ | ✗ | ✗ | **adopt** |
| Open in Salesforce link | ✔ | ✔ | ✔ | **have** |
| CSV export | ✗ | ✗ | ✗ | **adopt** |
| `j`/`k`/`Enter` row navigation | ✗ | ✗ | ✗ | **adopt** |
| Assign / claim case | ✔ | ✗ | ✗ | **skip** — write-back, and my cases are already mine |
| Alert sound on new case | ✗ | ✔ `playAlertSound` | ✗ | **adapt** — browser notification instead |

## Case detail

| Feature | Reference QView | Case Desk | My QView | Verdict |
|---|---|---|---|---|
| Dedicated case page | ✗ (side panel) | ✗ (modal) | ✗ (modal) | **adopt** |
| Full comment timeline | ✗ | ✗ | ✗ (fetched server-side only) | **adopt** |
| Public vs internal comments distinguished | ✗ | ✗ | ✗ — query hardcodes `IsPublished = true` | **adopt** — widen the query |
| Email messages in timeline | ✗ | ✗ | ✗ | **adopt** — new `EmailMessage` query |
| Search within case | ✗ | ✗ | ✗ | **adopt** |
| Extracted artifacts (cluster ID, versions, error codes) | partial — `#intel-description`, keyword chips | ✔ `clusterVersionHtml` | ✗ | **adopt** — full extractor |
| Related cases (same account / signature) | ✗ | ✗ | ✗ | **adopt** |
| Jira references linkified | ✗ | ✗ | ✗ | **adopt** |
| Draft scratchpad + copy | ✔ `copyIqsReply` | ✔ | ✔ modal | **adapt** — becomes a tab; template picker only |
| AI auto-written reply | ✔ | ✔ | ✔ `claude.ts` | **keep, do not extend** — prompt says a separate assistant owns this |
| Prev/next case respecting filter | ✗ | ✗ | ✗ | **adopt** |
| Staged loading animation | ✔ `startIqsScan` | ✔ `startDraftLoading` | ✔ | **have** |

## Commitments, metrics, other pages

| Feature | Reference QView | Case Desk | My QView | Verdict |
|---|---|---|---|---|
| Follow-up commitment parsing | ✗ | ✗ | ✗ | **adopt** — highest-value new feature |
| Business-hours countdown | ✗ | ✗ | partial — `addBusinessDays` in `claude.ts` | **adapt** — promote to a real module |
| Duplicate-commitment warning | ✗ | ✗ | ✗ | **adopt** |
| Renegotiate / supersede | ✗ | ✗ | ✗ | **adopt** |
| IQS scorecard | ✗ (per-reply estimate only) | ✗ | ✔ per-draft self-check | **adopt** — period scorecard page |
| Charts | ✗ | ✔ CSS bar chart | ✔ CSS bar chart | **adapt** — reuse the CSS-only approach |
| Drill-through from a number to a filtered list | ✔ stat tiles filter | ✔ chart bar filters | ✔ | **have** — apply everywhere |
| Manual metric entry (CSAT/NPS/IQS) | ✗ | ✗ | ✗ | **adopt** |
| Triage / needs-first-response view | ✔ the whole app | ✗ | ✗ | **adopt** |
| Escalations view | ✗ | ✗ | ✔ escalated stat only | **adopt** |
| Backlog alerts | ✔ `loadBacklogAlerts` | ✗ | ✗ | **adapt** — folds into Commitments at-risk |
| Cross-case full-text search | ✗ | ✗ | ✗ (SOQL `LIKE` on subject only) | **adopt** — FTS5 over cached comments |
| Recurring-pattern clustering | ✗ | ✗ | ✗ | **adopt** |
| Settings page | ✗ | ✗ | ✗ | **adopt** |

## Cross-cutting

| Feature | Reference QView | Case Desk | My QView | Verdict |
|---|---|---|---|---|
| Server-side SQLite cache of cases/comments | unknown (server not readable) | unknown | ✗ — drafts only | **adopt** |
| Delta sync on `LastModifiedDate` | ✗ (full refetch every 60 s) | ✗ | ✗ | **adopt** |
| Backoff on API error | ✔ retry countdown | ✗ | ✗ | **adopt** |
| Show last-good data on failure | ✔ | ✗ | ✗ | **adopt** |
| Poll only during an active window | ✗ | ✗ | ✗ | **adopt** |
| Credentials confined to the server | ✔ | ✔ | ✔ | **have** |
| Browser notifications | ✗ | ✔ sound only | ✗ | **adopt** |
| Outbound webhook | ✗ | ✗ | ✗ | **adopt** — off by default |
| Structured JSON logs | ✗ | ✗ | ✗ | **adopt** |
| `/healthz` | ✗ | ✗ | ✗ | **adopt** |
| `docker-compose.yml` in-repo | ✗ | ✗ | ✗ — lives in the sibling repo | **adopt** — add a self-contained one |
| `.env.example` | ✗ | ✗ | ✔ exists, incomplete | **adapt** |
| Responsive / mobile | ✗ | ✗ | ✗ | **adopt** |
| Skeleton loading states | ✗ spinner | ✗ spinner | ✗ spinner | **adopt** |

## Things deliberately not taken

- **Assign / claim** and any other Salesforce write. The brief says read-only by default;
  the cases in scope are already owned by me, so there is nothing to claim.
- **Broadcast messages, impersonation, version panel.** Team-operations features of a
  shared tool; they have no meaning in a single-user dashboard.
- **Theater pill.** Every case in scope is AMER, so the column would be a constant.
- **Phone queue.** Case Desk reads `/api/phone-queue` from a data source my Salesforce
  connection does not expose. Building a phone-queue tab would mean inventing data, which
  the brief forbids.
