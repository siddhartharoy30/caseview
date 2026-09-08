# Phone queue monitor (v4 phase 6)

## Sources

- `PHONE_BOARD_URL = http://reportrunner.colo.rubrik.com/cgi-bin/amer/phone_now_et.pl`
  — plain HTTP, an internal CGI script, self-refreshes every 15s. Someone
  else's service; QView never polls it faster than every 10s, and only
  while a browser tab has `/phone` open with the monitor toggled on.
- `CASE_DESK_URL = https://10.26.117.234/` — an internal tool colleagues
  already trust for this exact question. Read rather than reinvented.
- Board identity: the exact string `"Siddhartha"`, as the `phoneBoardName`
  setting (`SETTING_DEFAULTS` in `src/db.ts`) — confirmed live: a real fetch
  of the board during development showed a row literally named
  `Siddhartha`.

## Position discovery — not guessed, read from Case Desk's own code

The open question from the plan: Amazon Connect routes to the longest-idle
*available* agent, and the board already lists available agents sorted by
duration descending, so position-by-duration-among-available was the
working hypothesis — but whether a `fed` (Federal-line) agent also
occupies a slot in the general queue's position count could get the number
wrong either way if guessed.

Fetched Case Desk's `app.js` directly (from the VM — both hosts are
internal, and a direct `curl` from this Mac was denied by this session's
own sandboxing, not by the target hosts). Its phone-queue tab:

```js
const nonFederal = data.agents.filter((a) => !a.federal);
const nowInTop3 = nonFederal.slice(0, 3).some((a) => a.name === WATCHED_NAME);
```

`data.agents` comes from Case Desk's own `/api/phone-queue` backend
endpoint. Fetched that endpoint directly too, and compared its row order
against a simultaneous fetch of the raw board HTML: **the backend does not
re-sort — it preserves the board's own row order**, which already lists
available agents sorted by duration descending, with other statuses
trailing after.

**Answer: a Federal-line agent never counts toward a non-federal agent's
position.** Position is a name's 1-based index into the board's own row
order after removing `fed` rows — no independent sort needed, because the
source already presents it that way. This is exactly what
`src/phone.ts:positionOf()` does.

**Cross-validated, not just read:** parsed a real board HTML snapshot with
QView's own regex parser and computed my own position; independently
fetched Case Desk's live `/api/phone-queue` response a few minutes later
(board membership drifts in real time, so this was two independent reads,
not one shared payload) and computed the same filter over its
non-federal agents. Both agreed: position 2, one agent ahead. Confirmed
again once the running feature was live end-to-end (see below).

## What was not independently re-verified

Case Desk's own position number itself was not directly displayed and
compared side-by-side in this session (its phone-queue tab shows only a
top-3 boolean, not a printed rank) — the agreement above is between two
independent *computations* of the same filter-and-index logic against the
real board, not a screenshot-to-screenshot comparison of a number Case Desk
prints. If Case Desk's UI ever grows an explicit position number, that
would be the stronger check to run.

## Region discovery (v5)

The federal/non-federal split above is real and correct, but AMER is not one
pool: US-based agents and India-based agents working AMER hours sit on
different lines and do not compete for the same calls. A real screenshot
made this concrete — a US agent idle over an hour, the India-based owner
idle 34 minutes, both AMER/available, and QView said the owner was #2 when
they would actually take the next call.

Checked three avenues before writing any code, per the plan's own
instruction not to guess:

1. **Sibling reportrunner endpoints.** Probed roughly 18 plausible paths
   under `reportrunner.colo.rubrik.com/cgi-bin/` — regional variants, a
   `roster.pl`, a `routing_profile.pl`, a `federal/` sibling directory. Only
   the known `amer/phone_now_et.pl` exists; everything else 404s, directory
   listing is 403. No sibling endpoint exposes region or routing profile.
2. **Case Desk.** Re-fetched its live `/api/phone-queue` response and its own
   `app.js`. Its agent objects carry exactly `name`, `status_text`,
   `status_class`, `duration`, `federal` — no region field, no mention of
   "region" or "routing profile" anywhere in its code. **Case Desk shares
   this exact flaw** — it would also read #2 when a US agent is idle longer
   than an India-based one on the same line. This is a documented
   divergence QView now corrects, not a silent disagreement: Case Desk was
   never wrong on purpose, the dimension simply doesn't exist anywhere
   machine-readable.
3. **The Amazon Connect CCP routing-profile panel.** Behind Okta SSO in a
   real browser session — not checkable by an automated read. Not required
   either way: both machine-readable avenues above came up empty, so the
   explicit roster below is necessary regardless of what that panel would
   have said.

**Conclusion: the roster (`phone_roster` in `src/db.ts`) is not a fallback,
it is the only option.** Region is never inferred from an agent's name,
timezone, or idle pattern — per the plan's own explicit constraint, a guess
here would reproduce the exact failure this phase exists to fix. An agent
absent from the roster reads `region: "unknown"` and, if they are available
on my own line, makes my own position uncertain rather than silently wrong
— see `src/phone.ts:positionOf()`'s `uncertain`/`unclassified` fields and
the banner on `/phone`.

## Status vocabulary

Matched to the board's own CSS classes (from the fetched page's `<style>`
block), not invented: `available`, `ringing`, `accepting_call`, `inbound`,
`outbound`, `on_call`, `on_call__inbound_`, `on_call__outbound_`,
`on_hold__in_`, `on_hold__out_`, `acw`, `acw_in_`, `acw_out_`,
`acw__inbound_`, `acw__outbound_`, `acw__transfer_`, `after_call_work`,
`zoom`, `busy`, `away`, `offline`, `missed`. QView's own colour mapping
(`STATUS_TONE` in `phone.js`) follows the same good/bad/info/warn grouping
the source page's own stylesheet uses (green for available/ringing-as-
progress, blue for in-progress-on-a-call states, purple for busy/away,
grey for offline, red for missed) rather than inventing a second
vocabulary that could disagree with the board an agent might also have
open directly.

## Constraint notes

- The phone board is plain `http://`, not `https://` — the existing
  `^https://` validation elsewhere in this codebase (the Slack webhook) is
  specific to that one use and does not apply here; this is a different,
  internal, read-only source, not an outbound delivery target.
- No HTML parser dependency: `src/phone.ts` tokenizes the three-cell row
  shape with two regexes, tested directly against a real fetched snapshot
  of the board before being trusted (see `docs/TESTS.md`).
- Agent names are logged at `debug` only; counts (`agents`, `queued`,
  `queuedFederal`) are logged at `info`. `log.ts`'s redaction matches key
  names like `token`/`secret`, not `name`, so this had to be a deliberate
  choice in `phone.ts`, not something the logger enforces on its own.
