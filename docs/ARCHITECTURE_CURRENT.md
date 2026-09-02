# QView — Current Architecture (pre-rebuild snapshot)

Captured at commit `cd97e81`, before the dashboard rebuild.

## Stack

| Concern | Choice |
|---|---|
| Language | TypeScript 5.6, `target: ES2022`, `module: commonjs`, `strict: true` |
| Server | Express 4.21 |
| Persistence | better-sqlite3 11 (WAL), DB at `/data/qview.db` inside the container |
| AI drafts | `@anthropic-ai/sdk` 0.32 against an internal gateway (`ANTHROPIC_BASE_URL`) |
| Front end | One static HTML page + one CSS file + one classic (non-module) JS file. No bundler, no framework. |
| Build | `tsc -p tsconfig.json` → `dist/` |
| Runtime | `node dist/server.js` |

## Deployment

Docker multi-stage (`node:22-bookworm-slim`; build stage installs `python3 make g++` for
`better-sqlite3`). Composed as service `qview` in
`/home/ubuntu/salesforce-case-tracker/docker-compose.yml`:

- port `3001:3001`
- `env_file: ../qview/.env`
- `NODE_EXTRA_CA_CERTS=/app/certs/rubrik-ca-bundle.pem` — **required**; the internal
  Anthropic gateway will not verify without the Rubrik CA bundle
- volumes `../qview/data:/data` and `../qview/certs:/app/certs:ro`

Rebuild: `cd /home/ubuntu/salesforce-case-tracker && docker compose up -d --build qview`.

## Salesforce integration

`src/salesforce.ts`. OAuth 2.0 **refresh-token** grant against
`${SALESFORCE_INSTANCE_URL}/services/oauth2/token`; the access token is cached in a
module-level variable and proactively re-minted every 15 minutes, plus a one-shot retry
on any `401`. All reads go through `GET /services/data/{v}/query?q=<SOQL>`.

Three queries exist today:

```
listOpenCases()    SELECT <CASE_FIELDS> FROM Case
                   WHERE Owner.Name = :owner AND IsClosed = false
                   ORDER BY CreatedDate ASC LIMIT 200

getCaseByNumber()  SELECT <CASE_FIELDS> FROM Case WHERE CaseNumber = :n LIMIT 1

searchCases(q)     SELECT <CASE_FIELDS> FROM Case
                   WHERE CaseNumber LIKE '%q%' OR Subject LIKE '%q%'
                   ORDER BY CreatedDate DESC LIMIT 25

getCaseComments()  SELECT Id, CommentBody, IsPublished, CreatedDate, CreatedBy.Name
                   FROM CaseComment WHERE ParentId = :id AND IsPublished = true
                   ORDER BY CreatedDate ASC
```

`CASE_FIELDS` = `Id, CaseNumber, Subject, Description, Status, Priority, Type, Origin,
Problem_Type__c, Sub_Component__c, IsEscalated, IsClosed, CreatedDate, LastModifiedDate,
ClosedDate, Owner.Name, Owner.Title, Account.Name, Contact_Name__c, Labels__c,
NCC_date__c, Last_Customer_Update__c, Active_TTR__c`.

SOQL string interpolation is escaped by `escapeSoqlString()` (backslash + single quote).

**Everything is read-only.** No `POST`/`PATCH` to Salesforce anywhere in the codebase.

## Derived fields (`src/sla.ts`)

- `slaWindowMinutes(priority)` — `P1:30, P2:120, P3:240, P4:480`
- `computeSla(case)` — window, `remainingSeconds` measured from `CreatedDate`, `breached`
- `deriveQueue(case)` — `Origin || Type || "General"`
- `caseAgeDays(case)`
- `deriveNextAction(case)` — a `{kind: "work"|"followup"|"closure", label, reason}`
  heuristic driven by `Status`, days since `Last_Customer_Update__c`, and whether
  `NCC_date__c` is in the past

## Auth

`src/auth.ts`. Email-only. `POST /api/auth/login` compares the submitted address
case-insensitively against `QVIEW_ALLOWED_EMAIL`; on a match it mints
`base64url(email) + "." + expiry + "." + HMAC-SHA256(payload, SESSION_SECRET)` and sets it
as the `qview_session` cookie (`httpOnly`, `sameSite=lax`, 12 h). The email is base64url
encoded because a raw address's dots collide with the `.` token delimiter.

No password, no OTP, no second factor.

## Persistence

One table only:

```
suggested_replies(id, case_number, draft, keyword, internal_note, self_check, created_at)
```

with `idx_suggested_replies_case`. A tiny `ensureColumn()` helper performs additive
migrations. **Cases and comments are not cached** — every page load re-queries Salesforce.

## AI drafting (`src/claude.ts`)

`draftSuggestedReply(case)` pulls the public comment history, classifies the case into an
IQS keyword (`INTRO` / `UPDATE` / `FOLLOWUP` / `CLOSURE`, including the 3-Strikes
non-response path), assembles a large system prompt of Rubrik IQS rules, injects
pre-computed reference dates so the model never does its own date math, and parses the
reply out of fenced code blocks. Returns `{keyword, customerText, internalNote, selfCheck}`.

## HTTP surface

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | — | email only |
| POST | `/api/auth/logout` | — | |
| GET | `/api/auth/me` | — | `{authenticated, email}` |
| GET | `/api/cases` | ✔ | live Salesforce fetch, `Cache-Control: no-store` |
| GET | `/api/cases/search?q=` | ✔ | live SOQL `LIKE` |
| POST | `/api/intelligence/suggest-reply` | ✔ | `{case_number, regenerate}` |
| GET | `/api/app-versions` | — | static `{app, version}` |
| GET | `/*` | — | static from `public/`, `index: dashboard.html` |

## Refresh / caching

Client-side only: `dashboard.js` polls `GET /api/cases` every 5 minutes and re-renders.
No server-side cache, no delta sync, no persistence of case data. If Salesforce is
unreachable the table simply fails to populate.

## Observability

`console.log("QView listening on port …")` at boot, and nothing else. No health endpoint,
no structured logs, no metrics, no API-call accounting.

## Gaps relative to the target

No routing (single scrolling page), no case-detail view, no comment history in the UI, no
commitments, no metrics, no cross-case search over history, no notifications, no
`/healthz`, no cache, no `.env.example` completeness check, no responsive/mobile layout.
