# QView v4 — decisions recorded during implementation

Per the plan's own instruction to record certain calls here rather than
make them silently. Phase-numbered to match `PLAN_V4`'s (the implementation
plan's) own phases.

## Phase 6 — the phone board is plain `http://`

The existing `^https://` validation in this codebase (Settings' Slack
webhook field) is specific to that one outbound-delivery use case. The AMER
phone board (`http://reportrunner.colo.rubrik.com/cgi-bin/amer/phone_now_et.pl`)
is a different kind of thing entirely — an internal, read-only source QView
polls, not a destination QView sends to — so the https-only rule does not
apply and was not extended to it. Noted here rather than silently exempted,
per the plan's explicit ask.

## Phase 7 — SavvyCal dropped, Intl used instead

The plan already anticipated this outcome and asked only that the decision
be recorded, not that both be built. `Intl.supportedValuesOf("timeZone")`
plus `Intl.DateTimeFormat` (for offsets, abbreviations, and DST-correct
labels) supplies everything the strip needs: the full IANA zone list,
live offsets, and short names — all correct across a DST transition with
no table to maintain, no network call, no API key, and no new dependency.

No SavvyCal endpoint was ever called to compare against, so the honest
version of "what did it add that Intl doesn't" is: nothing was found that
would have justified adding it, given `Intl` already covers the zone list,
offsets, and abbreviations the widget needs, and the plan's own steer was
to prefer `Intl` unless SavvyCal demonstrably carried something extra
(curated city names, popularity ordering) worth a server-side, cached,
graceful-fallback integration. It was not built.

## Phase 7 — holiday shading: explicitly out of scope

The plan asks to either hardcode a small US-holiday list shared with
`businessHours.ts`, or explicitly drop it rather than half-build it where
it would disagree with the commitment countdowns elsewhere in the app.
Chosen: **dropped for this pass.** There is no holiday support anywhere
else in the codebase today — `businessMsBetween()` already counts
Thanksgiving and July 4th as ordinary nine-hour business days — so adding
holiday awareness only to the timezone strip would make it disagree with
every other business-hours calculation in the app (commitment countdowns,
the Next Commitment column, coverage automation) rather than agreeing with
a wrong-but-consistent answer. Weekend shading (`isWeekendIn()`, reusing
`bizhours.js`'s own weekday logic) is implemented; holidays are not. If
this becomes a real ask, it needs to land in `businessHours.ts`/
`bizhours.js` first so every consumer moves together, not just the strip.

## Phase 7 — account-timezone pinning: descoped

The plan's own fallback language ("if a timezone can be derived from the
contact or account, surface it; if not, let me pin one per account and
remember it") already anticipates that derivation may not be possible:
there is no timezone field anywhere on the case/account/contact schema
this project reads from Salesforce, so automatic derivation was never
buildable. The manual "pin one per account" fallback itself was not built
in this pass either — a real, disclosed time cut, not an oversight. The
zone search/add/remove/reorder mechanism the pinning would have used is
fully built and generic (any zone can be added under any label today,
including typing an account name as the label by hand), so this is a
missing convenience wired to case context, not a missing capability.

## Phase 7 — a real bug caught while testing the zone picker

`startLive()`'s tick originally repainted the entire strip header every
second, which rebuilt the zone-picker's search `<input>` mid-search --
silently reverting an in-progress query back to the unfiltered 400+ zone
list the instant the user typed. Caught by a scripted search-and-select
test (search "London", expect `Europe/London`; got the unfiltered list
and added `Africa/Abidjan` instead). Fixed by skipping the tick while the
picker is open, and dropping the tick cadence from 1s to 30s -- a clock
display never needed sub-30s precision, and the shorter interval was only
ever there by default, not by a real requirement. Re-tested after the fix:
searching "London" now correctly narrows to `Europe/London` alone.
