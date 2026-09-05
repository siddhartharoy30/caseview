# QView v3 — Plan

Three features: live IQS scoring, next-action-driven reply drafting, and time-off
coverage automation. This document records what Phase 0 discovery actually found,
what each integration can and cannot do, and the decisions that follow from that.

Everything below was measured from the VM and from inside the running container,
not assumed. Where a finding contradicts the spec, the finding wins and the
contradiction is called out.

---

## Phase 0 — discovery

### Summary

| Integration | Spec hoped for | Reality | Tier we ship |
|---|---|---|---|
| SentryAI | Tier 1 REST API | Vue SPA behind an nginx catch-all, session-cookie auth | **Tier 3 (paste/CSV) working, Tier 2 wired but dormant** |
| Slack | Bot token | Reachable, no credential exists anywhere | **Composer + dry run working, delivery dormant** |
| Glean | API token | No Rubrik Glean host resolves at all | **Replaced by Salesforce Knowledge, which is better** |

The headline: **the knowledge tier came out stronger than the spec expected and the
official-score tier came out weaker.** Neither blocks the build. Features A, B and
C all reach acceptance with `SENTRYAI_TOKEN`, `SLACK_BOT_TOKEN` and `GLEAN_API_TOKEN`
all empty, which is acceptance criterion 19.

### Section 0 — the blanks in the prompt, filled in

```
SENTRYAI_URL        = https://sentryai.rubrik.com/analytics/iqs   (route confirmed in the bundle)
SLACK_TEAM_CHANNEL  = unset — configurable at runtime, no default invented
SLACK_AUTH          = no. Neither a bot token nor a webhook URL exists.
GLEAN_ACCESS        = no. Superseded by Salesforce Knowledge (see 0.3).
MY_SLACK_HANDLE     = unset — a Settings field, not a hardcoded value
```

`SLACK_TEAM_CHANNEL` and `MY_SLACK_HANDLE` are deliberately left unset rather than
guessed. A wrong channel is worse than an empty one: it means the first real
coverage post goes somewhere unintended. Both are Settings fields, and coverage
stays disabled until they are filled.

---

### 0.1 SentryAI — what it is, and why Tier 1 is not available

`https://sentryai.rubrik.com` is a Vue 3 / Vite single-page application. The server
is an nginx catch-all: **every** path returns the same 1822-byte SPA shell with
`200 text/html`, including `/api`, `/api/health`, `/openapi.json`, `/system/metrics`
and every other path probed. Routing is entirely client-side. There is no SSO
redirect when unauthenticated — just the shell.

This matters because it means **unauthenticated path probing can never discover the
API.** A wrong guess and a right guess return byte-identical responses.

So the entry bundle was read instead — 4,699,435 bytes, `assets/index-DVKaGUCe.js`.
It carries a 136-entry Vite chunk manifest. The IQS routes
(`IQS_OVERVIEW`, `IQS_METRICS`, `IQS_DISPUTES`, `IQS_COMMITTEE`, `IQS_REDIRECT`)
resolve to `assets/CaseAuditDashboard-C29d4Wy1.js`. That chunk is 16 KB and it
gave up the real endpoints:

```
case/audit/detail/
case/audit/visibility/
case/audit/dispute/render/table/
case/audit/committee/dispute/render/table/
```

Note they are **relative** — no leading slash — so they are appended to an axios
`baseURL` resolved at runtime. The entry bundle contains no `baseURL` literal and no
`VITE_*` names, but does carry `"Authorization"`, `"X-CSRFToken"` and `"X-XSRF-TOKEN"`.
That combination is a Django-style session backend, not a bearer-token API.

Two other things the chunk told us, both useful:

- **IQS stands for "Internal Quality Standards."** The dashboard renders an
  `Overall Score` and an `IqsMetricXRayTooltip`.
- The band threshold is in the code:
  ```js
  const f = m.value / m.max * 100; return f >= 80 ? ...
  ```
  **80% is the Meeting threshold, which matches the rubric already in `claude.ts`
  exactly.** That is the first independent confirmation that our local rubric is
  calibrated to the real system, and it is worth more than it looks: it means a
  predicted score is comparable to an official one on the same scale.

What is still unknown without an authenticated session: the dimension list, the
per-dimension weights, and the period granularity. The spec is right that comparing
without them is theatre — so the comparison UI labels our number **predicted** and
the imported number **official**, and never averages them.

**Decision.** `src/iqs/sentryai.ts` exports one function:

```ts
export async function fetchOfficialScores(range: Range): Promise<OfficialScore[]>
```

with three implementations selected at runtime, best available first:

- **Tier 1** — not implemented. No API to call.
- **Tier 2** — `SENTRYAI_TOKEN` + `SENTRYAI_BASE_URL` set: server-side fetch against
  the four discovered `case/audit/*` paths with the session cookie and
  `X-CSRFToken`. Written, dormant, untestable until a session token exists. It will
  need one round of correction against a real response, which is expected.
- **Tier 3** — **the working floor.** `POST /api/iqs/official/import` takes a CSV or
  a pasted table from the IQS Report page. This is what actually runs.

Unreachable is an error state, never mock data (constraint 4). With no token the
Quality tab shows the predicted score alone and says the official score has not been
imported, rather than inventing one.

### 0.2 Slack — reachable, uncredentialed

`https://slack.com/api/auth.test` from the VM returns `{"ok":false,"error":"not_authed"}`.
Reachable, no token. `hooks.slack.com` and `api.slack.com` are both open on 443.
None of `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN`, `SLACK_COVERAGE_CHANNEL` exist in `.env`.

**Decision.** Build for the bot token, because it is what threading requires, and
degrade cleanly:

| Capability | Bot token | Webhook only | Neither (today) |
|---|---|---|---|
| Post to a channel | yes | one fixed channel | composed, stored, not sent |
| Thread follow-ups (`thread_ts`) | yes | **no** | n/a |
| Detect a reply or reaction | yes (`reactions:read`) | **no** | n/a |
| Escalation ping after N minutes | yes | **no** | n/a |

With no credential the whole of Feature C still works end to end except the final
HTTP call: transitions are detected, posts are composed and stored in
`coverage_posts`, and QView renders them under a "would have posted" banner. That is
exactly the `coverageDryRun` path, so **dry run is not a special mode we bolt on —
it is the honest default state of the system today.**

Per the spec, the existing `webhookUrl` setting is **not** reused. Coverage gets its
own `coverageSlackChannel` and its own token. The existing notify webhook stays what
it is.

One find worth carrying into Feature C: the Salesforce `Case` object has a
**`Slack_channel__c`** field, and one of the twelve open cases populates it —
`01273803` → `rrt-saber-health-01273803`. When a case carries its own channel, that
is a better destination than the team channel. Compose will prefer it and fall back
to `coverageSlackChannel`.

### 0.3 Knowledge — Glean is gone, Salesforce Knowledge replaces it

No Rubrik Glean host resolves from the VM or the container: `rubrik.glean.com`,
`glean.rubrik.com`, `rubrik-be.glean.com`, `rubrik-be-prod.glean.com`,
`rubrik-prod-be.glean.com`, `search.rubrik.com` — all NXDOMAIN. Only the public
`glean.com` and `app.glean.com` resolve, which are the vendor's own sites and no use
to us. `docs.rubrik.com` redirects to Okta (`onepassport.rubrik.com`) and is
unusable without an interactive login.

Curiously the Salesforce `Case` object does have a `Glean_Escalate__c` field, so
Glean exists somewhere in Rubrik. It is simply not reachable from this box under any
hostname we can find.

**But the search that matters turned out to be available all along.** The Salesforce
connection QView already holds can run SOSL against `KnowledgeArticleVersion`, and it
returns the real Rubrik KB:

```
FIND {backup job failed} IN ALL FIELDS RETURNING KnowledgeArticleVersion(...)
  000007469  A VMware backup job failed with error "Too many open external files: 12902"
  000004510  Rubrik Backup Service (RBS) Troubleshooting
  000009075  Oracle backup job failed during mount operation with error "mount.nfs: Address alr..."
  000006849  VMware Backup job failing with error "Failed to get current vSphere session..."

FIND {archive upload} ...
  000002669  [INTERNAL] How to Force full archive upload for snapshot
  000006724  Archive Upload jobs are stuck in "CANCELING" status
  000004881  Archive Full Upload Heuristics Explained.
  000011098  [INTERNAL] An Upload (to archive) job fails with error "Failed to upload snapshot..."

FIND {cluster upgrade} ...
  000012398  A Rubrik CDM upgrade check fails with "CDM API Token / Service Account Depre..."
  000012576  [INTERNAL] Cluster upgrade fails with 'Setup low privilege db user rk_reader'
  000014078  False "Upgrade failed" notifications appear in RSC after a successful cluster upgrade
  000010645  RSC-P initiated cluster upgrade using NFS for package download
```

Four relevant hits on every term, including internal-only articles. This is a
genuinely better source than Glean would have been: it is first-party, it is scoped
to Rubrik support content, and it costs no new credential, no new dependency and no
new egress path — the Salesforce connection is already open and already trusted.

**Decision.** `src/knowledge/index.ts` exports:

```ts
export async function findGuidance(query: string, context: Ctx): Promise<Source[]>
```

with tiers, best first, each `Source` carrying `{ title, url, snippet, tier }`:

1. **My own resolved cases.** 246 closed cases in the local cache, FTS5-indexed,
   reusing `getRelated()` and `patterns()` from `queries.ts`. Free, offline, and the
   most specific thing available — a case I already solved beats a generic article.
2. **Salesforce Knowledge** via SOSL. Live, first-party, no new credential.
   Article URL is `https://support.rubrik.com/s/article/<ArticleNumber>`.
3. **Glean**, behind `GLEAN_API_URL` + `GLEAN_API_TOKEN`. Written, dormant, skipped
   when unset. Kept because the field in Salesforce says it exists somewhere.
4. **Model reasoning alone**, explicitly labelled unsourced.

The spec's rule holds and is enforced in the composer: **never let tier 4 look like
tier 1.** Every rendered next-action names its tier, and an unsourced suggestion says
so in the Slack post and in the UI.

`knowledge_cache` memoises by `query_hash` so a repeated lookup during a sync storm
does not re-hit Salesforce.

### 0.4 Case status — the spec's example status does not exist

The spec says to source `coverageTriggerStatuses` from the cache via `facets()`. That
would have shipped a broken default, so this was checked against the Salesforce
`Case` describe instead.

The local cache holds **three** distinct statuses, because it is one engineer's 258
cases:

```
  11  Waiting for Customer Input      (open)
   1  Resolved - Pending Customer     (open)
 246  Closed
```

The real picklist has **49 active values**. And the spec's own worked example —
*"Waiting on Rubrik Support"* — **is not one of them.** The real value is
**"Waiting for Rubrik Support"** (*for*, not *on*). Sourcing the trigger list from
the cache would have produced a multi-select that could not express the single most
important trigger in the feature.

**Decision.** The `coverageTriggerStatuses` multi-select is populated from the
**describe picklist**, cached in `settings` and refreshed on sync. The cache is used
only to annotate each option with observed frequency, which is genuinely useful — it
tells you which triggers would actually fire. Defaults, being the statuses that mean
the ball is in our court:

```
Waiting for Rubrik Support   (primary)
Reopen
New
Assigned
```

The other 45 are selectable. The live backtest the spec asks for
("over the last 30 days, this configuration would have fired N posts") makes a wrong
selection visible before it costs anything.

### 0.5 Environment — no new dependencies needed

- Node **v22.23.2** in the container, global `fetch` available. Every new outbound
  call (Slack, SentryAI, Salesforce Knowledge) uses it. **Zero new dependencies**,
  so constraint 3 needs no exercise.
- The corporate CA is already wired: `certs/rubrik-ca-bundle.pem` mounted read-only
  at `/app/certs`, `NODE_EXTRA_CA_CERTS` set in compose. From inside the container
  `sentryai.rubrik.com` returns 200 in 312 ms and `slack.com` 200 in 421 ms.
- **`.env` reaches the container through compose `env_file:`, not a bind mount.**
  There is no `/app/.env`. Anything needing a secret reads `process.env`.
- Disk: 4.7 GB free of 19 GB. The new tables are small; `iqs_scores` is the only one
  that grows per-comment and it is bounded by comment volume (2,087 of my comments
  total, 68 on open cases).

### 0.6 Baseline the features will run against

```
open cases                12   (1 escalated, 1 with a Slack channel, 10× P2, 1× P3, 1× P4)
my comments               2,087 total, 68 on open cases, avg 2,063 chars
commitments               612 met, 90 breached, 13 unparsed, 10 active
closed cases for tier 1   246
```

Twelve open cases is a small enough queue that Layer 2 model scoring is cheap: 68
comments to score once, then only on change. The hash cache means steady-state cost
is near zero.

---

## Decisions carried into the build

1. **The rubric moves to `src/iqs/rubric.ts` and `claude.ts` imports it.** Not
   copied — imported. Constraint 10 makes duplication a bug regardless of output.
   `claude.ts` also has its own `addBusinessDays()` duplicating `businessHours.ts`;
   that gets consolidated in the same pass for the same reason.
2. **Layer 1 must be able to stand alone.** Acceptance criterion 2 requires a score
   with the Anthropic token unset. Layer 1 is pure functions over cached rows: no
   network, no API key, runs on every sync.
3. **Layer 2 is cached by content hash, not by time.** `sha256(comment bodies +
   RUBRIC_VERSION + model)`. Unchanged content is never re-scored. Bumping
   `RUBRIC_VERSION` invalidates and schedules a rate-limited background re-score,
   newest first.
4. **One next-action derivation.** `sla.ts:deriveNextAction()` and
   `claude.ts:detectKeyword()` currently answer the same question from different
   fields and will disagree. Both become thin wrappers over `src/nextAction.ts`.
5. **The coverage trigger is a status transition, full stop.** Not a customer reply,
   not a commitment deadline, not case age. `runSync()` already snapshots prior state
   for `needsReply`; that query gains `status` and `is_escalated`:
   ```sql
   SELECT case_number, needs_my_reply, status, is_escalated FROM cases WHERE id IN (...)
   ```
   Commitments appear in a post as a context line only, and never affect whether it
   fires, where it sits, or its severity.
6. **Deterministic post ids, following `notify.ts`.** `UNIQUE(case_number,
   trigger_kind, trigger_at)` with `INSERT OR IGNORE` turns "have I already posted
   this" into a primary-key constraint rather than a heuristic — the same trick that
   makes the five-minute event loop safe.
7. **`coverageDryRun` starts true and nothing reaches Slack while it is.** Tested
   explicitly, per constraint 11. Today it is also the only thing that can happen,
   since no token exists.
8. **Still read-only against Salesforce.** No writes, no auto-send. Drafts are staged
   and copied by hand. The Draft tab keeps its warning.

## Data egress

Constraint 6 says customer data leaves the box only through Slack coverage posts.
After discovery the full outbound list is:

| Destination | Direction | Carries case data | Default |
|---|---|---|---|
| Salesforce | in and out | yes (it is the source) | on |
| Anthropic gateway | out | comment text for Layer 2 | on, disableable |
| Salesforce Knowledge (SOSL) | out | a search phrase derived from the case | on |
| Slack coverage | out | case number, account, brief | **off** |
| SentryAI | out | nothing (read-only fetch) | off |
| Glean | out | a search phrase | off, unreachable |

The Knowledge search is the one addition worth flagging, and it is the mildest
possible: it sends a derived query string to Salesforce, which is where the case
already lives.

---

## Build order

| Phase | Scope | Gate |
|---|---|---|
| 0 | Discovery, this document | done |
| 1 | `src/iqs/rubric.ts`, `claude.ts` imports it, no behaviour change | done, byte-identical |
| 2 | Layer 1 scorer, queue column, Quality tab | done, scores appear with zero API calls |
| 3 | Layer 2 scorer, hash cache, `/iqs` page | done, cost and hit rate visible |
| 4 | `src/nextAction.ts`, both callers delegate, queue column | done, `sla.ts` and `claude.ts` agree |
| 5 | Draft pre-flight, auto-repair, keyword override, artifacts | predicted score before copy |
| 6 | Time-off calendar, commitment pre-flight | done, range surfaces its commitments |
| 7 | Status-transition watcher, compose, dry run, sweep | done, 30-day backtest shows volume (701 checked, 6 would fire) |
| 8 | Slack delivery, approval queue | done; threading and escalation ping skipped (webhook cannot thread, no bot token) |
| 9 | Recap, batch drafting, SentryAI import | done |

Phase 8's gate cannot be met today and that is a credential problem, not a code
problem. It ships complete and dormant; the dry-run path is what gets verified.

---

## Phase 1 as built

### What moved

`src/iqs/rubric.ts` is new and is now the only place the IQS rules exist.
`src/claude.ts` went from 329 lines to 199 and imports `CORE_RULES`,
`TEMPLATE_RULES` and the `Keyword` type from it. 8,226 bytes of rule text left
`claude.ts` and nothing was copied.

Alongside the prose, the module exports the machine-readable form the scorer in
phase 2 needs: `RUBRIC_VERSION` (`fy27.1.5.0`), `BANNED_PHRASES` (9 entries,
each with a compiled pattern and the required replacement), `BUSINESS_IMPACT_MAP`
(9 symptom-to-consequence pairs), `DIMENSIONS` (5, with per-dimension max,
signal list and scope), `BANDS`, `bandFor()`, `applicableDimensions()` and
`overallScore()`.

### How the gate was met

The gate is "existing drafts still generate identically". That was verified
mechanically rather than by eye:

1. `git show HEAD:src/claude.ts` yields the pre-refactor file. The two template
   literals were scanned out of it directly, after asserting neither contains
   `${` interpolation so a scan to the closing backtick is exact. No byte in the
   comparison passed through a human transcription.
2. Inside the container, the **compiled** `dist/iqs/rubric.js` was compared
   against those bytes: `CORE_RULES`, all four `TEMPLATE_RULES`, and the four
   composed system prompts (`core + blank line + template`, which is what
   `draftSuggestedReply()` actually sends).

All nine are byte-identical:

```
CORE_RULES           4379 chars    TEMPLATE INTRO      633
TEMPLATE UPDATE       680          TEMPLATE FOLLOWUP   692
TEMPLATE CLOSURE     1707
systemPrompt INTRO   5014          systemPrompt UPDATE   5061
systemPrompt FOLLOWUP 5073         systemPrompt CLOSURE  6088
em-dashes preserved: 2 in core, 4 across templates
```

The em-dash count matters because the rubric bans em-dashes in customer-facing
text while the rules themselves use them. A well-meaning cleanup would have
changed what the model is told without changing what it is told to do.

### Two shapes, one truth

Constraint 10 says the rubric lives in exactly one file. It does, but not every
part of it is single-sourced the same way, and the difference is deliberate.

- **Rendered from data.** The nine banned-phrase prose lines are generated from
  `BANNED_PHRASES`; the threshold sentence interpolates `BANDS` and
  `BAND_LABELS`; the self-check worked example interpolates the dimension maxima
  and signal counts. These have regular shapes, so generating them means the
  prose cannot drift from the data the scorer reads.
- **Verbatim, with an assertion.** The business-impact block is stored as-is
  beside `BUSINESS_IMPACT_MAP`. Its line breaks are hand-set, not the output of
  any wrapper: its lines measure 83/80/82/89/85/88/84/88/84 characters, which
  bounds a wrap width at 89, and one 81-character line is followed by a 6-character
  word that would have fitted at 88. No generic wrapper reproduces it. Generating
  it would have failed the byte-identity gate for a cosmetic win.
  `assertRubricConsistency()` closes the gap instead: it whitespace-normalises the
  prose and asserts every map entry appears in it, and asserts every dimension
  applicable to a keyword is named in that keyword's template. It runs at import,
  so drift is a boot failure, not a silent divergence. Verified live: the
  container came up with zero restarts.

### The one intentional behaviour change

`claude.ts` carried its own `addBusinessDays()` next to the one in
`businessHours.ts`. They are not the same function. Starting from a Saturday and
adding two business days, the local one returned **Tuesday** (it skipped Sunday,
counted Monday and Tuesday) while `businessHours.addBusinessDays` returns
**Wednesday** (it first advances to the next business instant, Monday 9:00 AM,
then adds two). Consolidating onto the shared one changes the date QView writes
into a draft when a draft is generated on a weekend.

That change is worth making because the duplicate was hiding a live defect. The
container clock is UTC, measured directly:

```
container TZ resolved: UTC        TZ env: undefined
local : Thu Sep 03 2026 14:21:21 GMT+0000
NY    : 9/3/2026, 10:21:21 AM
```

`formatLongDate()` called `toLocaleDateString("en-US", ...)` with no `timeZone`,
so between 8:00 PM and midnight Eastern the drafter wrote **tomorrow's** date
into the `Today:` line and into every same-day 6:00 PM commitment. It went
unnoticed because at any normal working hour the two renderings agree.

This is not cosmetic. `commitments.ts` parses those dates back out of the posted
comment and measures met-versus-breached through `businessHours.ts` in
`America/New_York`. A drafter computing in UTC and a tracker measuring in
Eastern disagree by up to a day, and the Reliability dimension being built in
phase 2 is derived from exactly those rows. Fixed by passing `timeZone: TZ`.

So the gate reads as: the rule text the model receives is byte-identical, proven
above. Reference dates are now correct where they were previously wrong after
8:00 PM Eastern, and weekend arithmetic follows the shared helper. Both are
disclosed rather than absorbed.

### Left alone on purpose

`detectKeyword()` still hardcodes its own 3-Strikes thresholds
(`trailingOwnerCount >= 3`, `=== 2 ? 2 : 1`). That is the same duplication
problem as `addBusinessDays`, but its counterpart is `deriveNextAction()` in
`sla.ts` and unifying them is phase 4's entire scope. Widening phase 1 to reach
it would have put an untested behaviour change under a no-behaviour-change gate.

---

## Phase 3 as built

`src/iqs/layer2.ts` (the Anthropic-backed scorer) and `src/iqs/layer2Store.ts`
(content-hash cache, `iqs_layer2_usage` ledger, budget-capped background
sweep) shipped as designed in Phase 0. Layer 1 stays fully standalone — Layer
2 never scores on a `GET`, only on `POST` or from the sweep, and is inert
without `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` set.

New routes: `GET /api/cases/:caseNumber/iqs/layer2`, `POST` (same path, scores
on demand, `?force=1` to bypass the cache), `GET /api/iqs/overview` (stats,
budget, sweep status, predicted-vs-official comparisons, recent activity in
one round trip), `POST /api/iqs/sweep` (run the sweep now). New `/iqs` page.

Verified locally end to end: server boots clean, `/api/iqs/overview` and
`/api/iqs/sweep` both require auth and return the expected shape, sweep runs
safely against an empty cache with zero cost and zero errors.

## Phase 4 as built

The gate was "`sla.ts` and `claude.ts` agree," and getting there meant finding
a third implementation the gate didn't originally name:
`iqs/layer1.ts:detectKeywordFromComments()`, added during phase 2/3 and
explicitly commented as mirroring `claude.ts` until phase 4 arrived. All three
collapsed into `src/nextAction.ts`:

- `detectKeyword(status, comments)` — the single 3-Strikes derivation. Takes a
  minimal `{isPublic, isMine}[]` shape so it works equally over live
  Salesforce comments (drafting) and cached rows (scoring), oldest-first.
- `nextActionForKeyword(facts)` — the queue's Next Action column. `kind`
  (work/followup/closure) is looked up from `keyword` via a fixed table, not
  re-derived from status text, so it is structurally impossible for the queue
  to disagree with the drafter or the scorer on the fundamental bucket. Status,
  quiet-days, NCC and escalation still shape the `reason` text.

`sla.ts:deriveNextAction()` and `iqs/layer1.ts:detectKeywordFromComments()`
kept their names and are now thin wrappers, so no importer needed to change.
`claude.ts` calls `detectKeyword` directly.

This surfaced and fixed a real disagreement, not just a hypothetical one.
Status `"Resolved - Pending Customer"` is a terminal status by the shared
`isTerminalStatus()` check, so `detectKeyword` returns `CLOSURE` immediately —
exactly what `claude.ts` already did before this refactor. But the pre-phase-4
`deriveNextAction()` treated that same status as `followup` ("confirm fix with
customer") until the customer had been quiet 4+ days, only then flipping to
`closure`. Same case, two different queues telling the engineer two different
things. Verified against the live synced queue: case `01301616`
("Resolved - Pending Customer") now shows `kind: closure` from both the
`/api/cases` queue endpoint and what `claude.ts` would draft, on day zero.

Also fixed in passing: the `/api/cases` handler's `legacy` object (built for
`deriveQueue`/`computeSla`/`deriveNextAction`) never set `IsEscalated`, so
`deriveNextAction`'s escalated-reason branch was dead code from this call site
since it was written. Now mapped; case `01302660` (escalated, mid-conversation)
shows `"Escalated — needs active work"` instead of the generic `"Needs
review"`.

---

## Phase 5 — discovery and decisions

Phase 5 (`Draft pre-flight, auto-repair, keyword override, artifacts`) had no
discovery write-up of its own, unlike phases 0-4, so the first step was
finding out what's actually live before adding to it.

**Finding: the AI drafting feature already exists end to end on the backend
and is completely disconnected from the app.** `/api/intelligence/suggest-reply`
(`draftSuggestedReply()` in `claude.ts`, cached in `suggested_replies`) is real
and working. Its only frontend caller is `public/js/dashboard.js` — 859 lines
building a `suggestModal` with a keyword badge, self-check panel and copy flow.
That file is loaded by nothing: not `index.html`, not `app.js`'s router, not
any page. It predates the SPA rewrite (`app.js` + `pages/*.js`) and was never
deleted. Deleted now — keeping dead code that calls a live paid API is worse
than having no code, because it reads as a working feature to the next person
who greps for `suggest-reply`.

The Draft tab a user actually sees today (`caseDetail.js`) is a different,
simpler thing: a `localStorage`-backed staging textarea with static
bracketed-placeholder skeletons (INTRO/UPDATE/CLOSURE) and a copy button.
No AI, no scoring, no override.

**Decision: build phase 5 into that live tab, not the dead modal.** One
staging textarea, one Copy button, regardless of whether the text came from a
skeleton, an AI draft, or hand-typing — every capability below applies to
whatever is currently staged.

- **Predicted score before copy (the gate).** `iqs/store.ts:previewDraftScore()`
  appends the staged text as a synthetic `isMine` comment onto the case's real
  cached facts and calls the existing pure `scoreCase()` — the same Layer 1
  scorer every real score goes through, free and instant, with zero new
  rubric logic. Because Layer 1 already returns `violations[]` (exact banned
  phrase + the rubric's own required replacement) and a per-comment WWW
  breakdown, the preview needed nothing new to be genuinely actionable, not
  just a number. Fetched eagerly as soon as staged text looks non-trivial, so
  in the normal flow the score is already on screen by the time Copy is
  reached — advisory, not a hard block, consistent with this app never
  gating a human's own judgment anywhere else.
- **Auto-repair, two tiers.** Tier 1 (`mechanicalRepair()` in `layer1.ts`):
  every banned-phrase hit already carries its mandated replacement in the
  rubric, so fixing it is a regex substitution, not a model decision — free,
  deterministic, zero risk of the model touching anything else. Tier 2
  (`repairDraft()` in `claude.ts`): only reached if a structural gap remains
  after tier 1 (a missing What/Why/When, a dimension still weak) — one model
  call, targeted at exactly those named gaps, instructed to preserve
  everything already correct. One "Auto-repair" button runs tier 1 always and
  tier 2 only if still needed, so the common case (a stray banned phrase) never
  spends a token.
- **Keyword override.** `scoreCase()` gained an optional second parameter so
  a forced keyword flows through scoring the same way `layer2.ts` already
  forces one through Layer 2 (`keywordOverride || detectKeyword(...)`, the
  same pattern, now the third place it appears — drafting, both score layers).
  `draftSuggestedReply()` and `repairDraft()` take the same override.
- **Artifacts.** Already extracted and cached per case (`getArtifacts()` in
  `queries.ts`, backing the existing Artifacts tab) — nothing new to extract.
  Phase 5 just hands that same list to the drafting and repair prompts as
  context ("the case has these on file; cite them"), and shows a one-line
  summary in the Draft tab so the reviewing engineer sees it without a tab
  switch.

---

## Phase 6 — discovery and decisions

Phase 6 (`Time-off calendar, commitment pre-flight`) is the first piece of
Feature C (Phase 0's coverage automation) to actually get built. Nothing for
it existed yet: no `time_off` table, no `coverageDryRun`/`coverageSlackChannel`
settings, no route. Grepping for all three came back empty before writing any
code, which is the honest starting point — phases 7-9 (status-transition
watcher, Slack delivery) build on top of what this phase lays down, so getting
the shape right here matters more than usual.

**What "commitment pre-flight" means, concretely.** The commitment system
already exists (`commitments.ts` parses promises out of case text,
`queries.ts:listCommitments()` serves the Commitments page's breached / at-risk
/ today / upcoming bands). What phase 6 adds is a second lens on the same
data: given a date range, which of those deadlines fall inside it. That is a
plain filter (`due_at BETWEEN`), not new commitment logic, so
`queries.ts:commitmentsInRange()` reuses the same join and the same
`toApiCommitment()` shaping the Commitments page already uses — one row shape,
two views.

**Decision: a real persisted calendar, not just a date picker.** The gate
says "range surfaces its commitments," which a stateless two-date-field form
would satisfy literally. But phase 7's status-transition watcher and phase
8's Slack delivery need to know, on their own, whether coverage should be
armed *right now* — that requires a saved list of ranges to check against, not
something that only exists while a form is open. So `time_off` is a table
(`start_date`, `end_date`, `note`), not a settings blob: phases 7-9 will query
it the same way `commitments` and `iqs_scores` are queried, and a settings
JSON value would have made that an awkward parse-and-scan instead of a normal
indexed lookup.

**Whole days, in the owner's timezone, not the container's.** A time-off range
is dates, not instants — "out Sep 10 through Sep 12" means midnight to
midnight in `America/New_York`, not UTC. Phase 1 already found and fixed the
exact bug class this would otherwise reintroduce (`claude.ts`'s date
formatting running in UTC and writing tomorrow's date after 8 PM Eastern), so
`timeOff.ts:rangeBoundsMs()` goes through the same `businessHours.ts:fromWallClock()`
every other date-sensitive part of this codebase uses, rather than a fresh
`new Date(startDate)` that would parse as UTC midnight and shift the boundary
by hours depending on the server's clock.

**Scope drawn at "surface," not "act."** This phase shows what needs
attention before you leave; it does not renegotiate, dismiss, or notify
anyone. Phases 7 and 8 own the status-transition watcher and the Slack post —
adding either here would be doing phase 7/8's job under phase 6's gate, the
same trap phase 1 explicitly declined to walk into with `detectKeyword()`'s
own thresholds. `active` and `breached` commitments are the ones surfaced
(an outstanding promise, in either state, is exactly what needs a plan before
you're unreachable); `met`, `superseded` and `dismissed` are resolved and
`unparsed` has no `due_at` to range against, so all four are excluded.

**Its own page, not a section bolted onto Commitments.** Phases 7 and 8 add a
coverage-trigger settings block, a dry-run banner, and an approval queue —
real screen area this page doesn't have yet but will. `/iqs` went through the
same reasoning in phase 3: give the feature its own room now rather than
migrate it out of a denser page later.

---

## Phase 7 — discovery and decisions

**Reopened decision: webhook, not bot token.** Phase 0 picked a bot token
specifically because threading and reaction-based escalation need one. Asked
directly, the owner declined to stand up a Slack app with bot scopes at all —
"no need of bot." So delivery now goes through Slack Incoming Webhooks
instead: a JSON `POST {"text": ...}` to a per-channel URL, no OAuth, no bot
user. This app already has that exact primitive, built for the general
event webhook (`notify.ts:sendWebhookTest`) — coverage delivery reuses it
rather than adding a second HTTP client.

**What this costs, disclosed rather than absorbed:** a webhook URL is locked
to one channel at creation time, so `Case.Slack_channel__c` (case `01273803`
carries its own channel, found in phase 0) can no longer be preferred per
case the way phase 0 planned — every coverage post now goes to whichever one
channel is currently active. Escalation pings and reaction-detection (phase
8) are also off the table without a bot token; if that turns out to matter
later, the webhook and bot approaches can coexist; nothing here forecloses
adding a token afterward.

**The channel picker the owner asked for:** `coverage_channels` is a table,
not a single setting — a short list of `{label, webhookUrl}` (e.g. "Test
channel", "Team channel"), one marked active via `coverageActiveChannelId`.
Adding the real team channel later is "add a row and switch the active one,"
not "overwrite the test URL and lose it." Every channel gets its own "Send
test" action, not only the active one, so a new channel can be proven before
it goes live.

**The 30-day backtest is real, not aspirational.** Phase 0 named it as
something the spec wanted without confirming it was possible. Checked before
building anything: `CaseHistory` has `Status` in its tracked-fields picklist,
and a live query against the org confirmed real transition rows exist
(`Waiting for Customer Input` → `Waiting for Rubrik Support` and similar, for
this owner's own cases, timestamped). So the backtest queries real history —
`salesforce.ts:getRecentStatusHistory()` — rather than simulating from
current state, and it checks each transition's timestamp against declared
`time_off` ranges the same way the live sweep does, so a backtest and the
real thing agree on what counts.

**The trigger is still a status transition into a configured list, checked
only while time off is active** — unchanged from phase 0's decision 5.
`coverage_posts` keeps phase 0's `UNIQUE(case_number, trigger_status,
trigger_at)` dedup (decision 6, the same `INSERT OR IGNORE` trick
`notify.ts`'s events already use), and `coverageDryRun` still starts `true`
(decision 7) — nothing this phase does is any different from what a real
delivery would compose and record, except the one `fetch()` call, which
dry-run skips.

---

## Phase 8 — discovery and decisions

Scoped down twice before writing anything, both times because of the
phase 7 pivot to Incoming Webhooks (no bot token).

**Escalation ping: skipped, at the owner's explicit request.** It needs
`reactions:read` to detect a response, which only a bot token has.

**Threading: skipped too, for a reason the owner had not been told yet.**
Grouping a case's follow-up posts into one Slack thread means posting with
`thread_ts`, and Incoming Webhooks do not support that parameter at all —
every webhook post is a new top-level message, unconditionally. This isn't
a scope choice like escalation ping was; it is the same webhook-vs-bot
limitation showing up a second time, and it was worth surfacing on its own
rather than silently folding into "skip escalation ping" and letting the
owner think that was the only thing given up.

**What phase 7 actually shipped, read again: dry run off meant auto-send.**
`recordAndMaybeDeliver()` called the webhook itself the moment dry run was
false and a channel was active — no human step in between. That is flatly
inconsistent with this project's own founding rule, unchanged since the
first planning session: "Autonomy: draft-and-approve — every outbound
email/Slack/case-edit is queued for the user to Approve/Edit/Send. No
autonomous sending." Phase 5's AI drafts already honor this ("Draft only —
review before sending. Nothing is sent automatically."); phase 7's coverage
posts did not, and nothing had actually been sent for real yet (no webhook
URL existed at the time), so fixing it now costs nothing already relied on.

**Decision: dry-run-off arms the queue, it does not arm sending.** Turning
dry run off no longer means "the next matching transition posts itself." It
means "the next matching transition is composed, recorded, and placed in an
approval queue" — a human still clicks Send (or edits the text first, or
discards it) for every single post, exactly the same shape as the Draft
tab's AI replies. Dry run keeps its original job too: a dry-run post is
purely informational and never offered a Send button at all, so testing the
detection logic and actually operating the queue are two different modes,
not the same button with a delayed effect.

No new column for this: the existing `dry_run` / `delivered` / `error`
fields already distinguish four states without adding one --
`dry_run=1` → dry run (never actionable); `dry_run=0, delivered=0,
error IS NULL` → pending approval; `dry_run=0, delivered=1` → sent;
`dry_run=0, delivered=0, error IS NOT NULL` → failed (retryable). One
column was added, `discarded_at`, for the human explicitly declining to
send a pending post -- the row stays as a record either way, nothing about
a real trigger is ever deleted.

**A real bug the approval-queue work surfaced in phase 7's own dedup.**
`recordAndMaybeDeliver()` stamped `trigger_at` with `new Date().toISOString()`
-- wall-clock-at-detection-time, not anything intrinsic to the transition.
Caught by testing the same transition through `sweepTransitions()` twice in
a row (simulating an overlapping or retried sync): the second call minted a
different `trigger_at` than the first, so `UNIQUE(case_number,
trigger_status, trigger_at)` never matched and the dedup silently did
nothing -- exactly the failure mode decision 6 exists to prevent, sitting
undetected in phase 7 because nothing had exercised a repeated sweep yet.
Fixed by keying on the case's own `last_modified_date` instead (already on
hand from `getCaseRow()`), which only moves when Salesforce records a real
further change -- the same "derive the key from data, not from when the
code happened to run" rule `notify.ts`'s event ids already follow. Verified
against a clean table: sweeping the identical transition twice now produces
exactly one row.

---

## Phase 9 — discovery and decisions

The last phase on the original roadmap, and the only one whose table row
had no gate at all (`| 9 | Recap, batch drafting, SentryAI import | — |`).
Checked before assuming any of the three had a real spec: none did.
`docs/PLAN.md`, `docs/FEATURE_GAP.md` and `docs/ARCHITECTURE_CURRENT.md`
have zero hits for "recap" or "digest". "Batch drafting" has no existing
selection UI anywhere in `queue.js` to extend. The one piece with a real
spec is SentryAI's Tier 3 import, decided in phase 0 and never built.

### SentryAI official import (Tier 3)

Phase 0's decision, quoted because it still holds: *"`POST
/api/iqs/official/import` takes a CSV or a pasted table from the IQS Report
page. This is what actually runs... the comparison UI labels our number
predicted and the imported number official, and never averages them."*

**A new table, not a third `iqs_scores` layer.** `iqs_scores` has `keyword`
and `detail` as `NOT NULL` -- both meaningful only for a score computed
against *our* rubric shape (a response-type keyword, a dimension tree). An
official score has neither; SentryAI's own dimensions and weights are still
unknown (phase 0: "What is still unknown without an authenticated session:
the dimension list, the per-dimension weights, and the period
granularity"). Forcing an official row into `iqs_scores` would mean
inventing a fake keyword and an empty detail blob just to satisfy
constraints that exist for a different kind of row. `iqs_official_scores`
(case_id, overall, band, source_note, imported_at) keeps every row
meaningful, the same reasoning phase 6 used for `time_off` and phase 7 for
`coverage_channels`.

**The column names are a guess, disclosed as one.** Nobody on this project
has ever seen a real SentryAI export -- phase 0's discovery got as far as
the login wall and stopped. `iqs/official.ts`'s parser matches header
aliases ("case", "case number", "case #" for the case column; "score",
"overall", "overall score", "iqs score" for the score column) rather than
one exact format, and reports what it understood before committing, so the
first real paste is a correction, not a rewrite.

### Batch drafting

No backend change needed at all. `/api/intelligence/suggest-reply` already
takes one case at a time and already does everything phase 5 built --
keyword detection, artifacts context, rubric-consistent drafting. Batch
drafting is `queue.js` gaining row selection and looping that same
endpoint client-side, then reusing `previewDraftScore()`'s existing route
to show a predicted score next to every result, exactly like the Draft tab
already does for one case. Capped at 15 cases per run with an explicit "N
AI calls" confirmation first -- the one thing phase 5's single-case flow
had that a batch loses by default is the natural friction of one click per
call.

### Recap

No spec existed to build against, so this defines one: a copyable text
digest, not a new chart. `metrics.ts:scorecard()` already computes
everything period-scoped that a recap needs (opened, closed, commitments
met/breached, TTR, aging); duplicating that computation for a recap would
be the exact single-source-of-truth mistake phase 4 fixed for next-action
logic. Recap is a new tab on the existing Scorecard page, sharing its
period selector and its already-fetched data, adding only what
`scorecard()` doesn't have: current Layer 1 quality average
(`iqs/store.ts:getStats()`) and coverage activity in range (new
`coverage.ts:listPostsSince()`). "Copy recap" formats it as plain text --
consistent with this app never sending anything on its own, a recap is
something the owner copies into their own stand-up or status update by
hand.

### Verified, and one bug the verification found

All three tested against real synced data. SentryAI import: a deliberately
mixed paste (two valid rows, one unparseable score, one case number not in
the cache) came back exactly right -- 2 imported, 1 unmatched, 1 warning --
and the comparisons table correctly showed a real predicted-vs-official gap
(70.5 predicted vs. 87.5 official on one case). Batch drafting: two real AI
calls through the existing single-case endpoint, both scored afterward
through the existing draft-score endpoint, no new failure mode. Recap:
real period data from `scorecard()` plus a live quality average, correctly
formatted and copyable.

The bug: a paste with no recognizable header at all (`importOfficialScores`
returning zero rows because neither column could be found) came back as
HTTP 200 with `ok: true` -- indistinguishable from "nothing needed
importing" when the real story was "this input could not be read." Fixed
by giving `ParseResult` a `fatal` flag, true only when the header itself
couldn't be read, false when the header was fine but some data rows were
skipped -- the same distinction commitments.ts already draws between
"this isn't a promise" and "this is a promise with an unparseable date."
The route now answers 400 for the first case and 200 for the second.
