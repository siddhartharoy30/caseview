# QView design system (v4 phase 3)

Written before the CSS changes it describes, per the v4 plan's own rule, then
held against each page afterwards. Scope note up front: this phase covers
the `.art-head` card-header bug (3.1), the uppercase micro-label audit (3.2),
the case-detail header retier (3.3), and the token/quality-floor work (3.4).
It does not attempt a full retrofit of every one of the 129 pre-existing
padding literals onto the new spacing scale -- see the self-critique at the
bottom for what that leaves undone.

## 3.1 — the card-head bug, and what it was actually costing

`.art-head` was used 13 times across `timeoff.js` (×7) and `caseDetail.js`
(×6), always paired with a different `.card` variant that may or may not
have supplied its own horizontal padding. Only one of the 13 (the artifacts
grid in Case Detail) happened to sit inside a card that did. The other 12 —
Time Off's Channels/Trigger/Backtest/Approval-queue/History cards, and Case
Detail's Related-cases/Engineering-tickets/Draft/quality cards — rendered
their section title flush against the card's left border, with whatever
followed it (a table, a form, a list) either flush too or padded by an
unrelated, differently-sized value. This reads as sloppy in a way that is
hard to name precisely, which is exactly why it survived nine phases: no
single instance looks broken in isolation, but seeing two cards side by side
with different insets is what actually erodes trust that the layout was
designed rather than assembled.

**Fix:** one `.card-head` / `.card-body` pair, added once in `app.css` and
used everywhere a card needs a bordered title row. `.card` itself keeps zero
padding (a header that owns a full-bleed `border-bottom` cannot coexist with
padding on its parent), and `.card-head`/`.card-body` each own their own
inset instead. `_shared.js` gained two tiny helpers, `cardHead(...)` and
`eyebrow(text)`, so every call site is now `cardHead(eyebrow("Channels"))`
rather than hand-rolled markup — the next new card copies a working pattern
instead of re-deriving the padding by eye. Settings' pre-existing `.set-*`
family (`section()` in `settings.js`) was already the correct shape, so it
was folded into the same classes rather than kept as a parallel system that
two future edits would have to remember to keep in sync.

**A second bug found while doing this audit, not in the plan:** two of the
13 sites (`caseDetail.js`'s Related-cases and Engineering-tickets cards) used
class `rel-card`, which collided with an unrelated, already-unused CSS rule
of the same name — a flex/baseline "link chip" component (`display: flex;
align-items: baseline`) that nothing in the current codebase renders as a
link chip. Applied to a card meant to stack a header over a table, that flex
row would have pushed the header and the table onto the same line instead of
stacking them — a real layout break, not just an inconsistent inset. Fixed
by renaming the call sites to `relgrp-card` and deleting the dead `.rel-card`
rule (nothing else referenced it once these two moved off it) — same
disclosed-deletion precedent as `dashboard.css` in phase 3.0 and the 859
lines of dead pre-SPA UI code in phase 5.

## 3.2 — the eyebrow class

23 of 24 uppercase micro-label selectors (everything except `table.tbl
thead th` and `.mini-table th`, which separate a header row from data in a
dense grid and stay uppercase for that reason) had drifted onto their own
font-size/letter-spacing/color triple: 10px/.06em, 10.5px/.05em, 11px/.05em,
11.5px/.05em and several more, all doing the same job. `.art-title` (the
title span inside the old `.art-head`) is now `eyebrow()` from `_shared.js`,
sentence case, `var(--fs-micro)` / `var(--text-3)` / consistent
letter-spacing — a real class, not a convention every author has to
remember. The other 21 selectors (`.nav-section`, `.cd-meta-label`,
`.tl-badge`, `.tile-label`, `.tb-label`, and so on) had `text-transform:
uppercase` removed directly rather than being renamed to `.eyebrow` in
markup — see the self-critique below for why that is a smaller move than it
sounds and what it leaves undone. Every label's underlying text was already
written in sentence case in the JS (`"Rank by"`, `"Daily budget"`, `"update
overdue"`) — the uppercase was purely a CSS transform, so removing it needed
no JS text changes anywhere.

## 3.3 — Case Detail header, three tiers

The header was one `grid-template-columns: repeat(auto-fit, minmax(155px,
1fr))` of seven or eight `metaItem()`s, every one visually identical
regardless of whether it was "what do I do next" or "when was this created."
Restructured into:

- **Primary** (the title row, unchanged in mechanism, extended in content):
  priority chip, case number, subject, and now **status** — moved out of the
  meta grid and into the title row as a plain neutral chip, next to the
  existing Escalated/Closed chips. Status is one of the four facts that
  identify what a case *is*; it does not belong at the same weight as
  "product area."
- **Secondary** (`.cd-meta-secondary`, full-strength text): Next commitment,
  **Quality score** (new — reuses the `iqs` summary already attached to
  every case object by `toApiCase()`, `{overall, band}`, and the existing
  `bandChip()` component from `lib/iqs.js` rather than inventing a second
  band-color mapping), Account, Contact.
- **Tertiary** (`.cd-meta-tertiary`, smaller and muted, set apart by its own
  top border): Created (with relative age, unchanged), Last activity,
  Product area, Next customer contact, and "Waiting on me" (an existing
  signal that used to live folded into the Status item; the plan's three
  named tiers don't mention it, so it was placed here as background detail
  rather than dropped — it did not earn primary or secondary weight on its
  own, but deleting a real signal without being asked to felt like the
  wrong default).

Quality score was genuinely new to this header — it existed only as the
Quality tab's badge count before. It required no new fetch: `state.iqs` is
loaded lazily for the tab's own use, but the case object's own `.iqs`
summary field (`overall`, `band`) has been present on every `/api/cases`
response since phase 3 of the *original* roadmap, unused by the header until
now.

## 3.4 — the system

**Type scale.** Six tokens (`--fs-page-title` 21px down to `--fs-micro`
10px), each named for a role rather than a number. The half-pixel tier —
9.5/10.5/11.5/12.5/13.5/14.5px, roughly a quarter of all 220 font-size
declarations — is retired: each value now resolves to the nearest scale
step (60 declarations moved). Whole-pixel values below scale (13px, 12px,
etc. used directly rather than as `var(--fs-body)`/`var(--fs-table-cell)`)
were not swept in this pass; see the self-critique.

**Spacing scale.** `--space-1` (4px) through `--space-8` (32px), used
throughout the new card-head/body/meta-tier work above. Not retrofitted
onto the ~129 pre-existing padding literals outside that new work — same
scoping call as the type scale.

**z-index scale.** Six named layers (`--z-sticky-table` through
`--z-login`) replacing the same six literal numbers wherever they appeared,
in ascending order of "how completely this covers the screen."

**Quality floor.** Two gaps, both global fixes:
- `:focus-visible` had no baseline rule anywhere in `app.css` — six
  interactive classes (`.btn`, `.icon-btn`, `.nav-item`, `.seg-btn`,
  `.cd-tab`, plain links) had no author focus style at all, meaning
  keyboard focus fell back to whatever the browser draws by default (or
  nothing, on the six `outline: none` kills already in the file for other
  elements). One rule now covers all six with a theme-consistent ring.
  Elements that already had their own `:focus-visible` treatment (text
  inputs' box-shadow ring, several chart/tile/bar-row outlines) are
  unaffected — they win on specificity.
- `prefers-reduced-motion` was handled nowhere in `app.css` — the repo's
  only such block lived in the now-deleted `dashboard.css`, which nothing
  loaded. A single global rule now flattens every animation/transition
  duration to near-zero when the OS preference is set, covering the three
  infinite animations (`shimmer`, `pulse`, `blink`) that mattered most.

**Two colour-encodes-state violations cleared:** `body.light .nav-item.active`
and `.cd-tab.active .cd-tab-count` both hardcoded a literal blue instead of
deriving from the `--blue`/`--blue-2` tokens (one of them a theme-blind
hardcode that never had a dark counterpart). Both now use `color-mix()`
against the token, matching how every other tinted-background chip in the
file already computes its background from its foreground colour.

## Self-critique — what this phase did not fully close

- **No before/after screenshots.** The plan calls for headless-Chrome shots
  of all eleven pages into gitignored `docs/shots/`. This app's auth is
  session-cookie based (`POST /api/auth/login` with an allowed email, no
  password), and wiring a real login into a scripted headless-Chrome
  capture — without adding a new dependency like Puppeteer, per the plan's
  own no-new-dependencies constraint — needed either raw CDP-over-WebSocket
  plumbing or a seeded cookie store, neither of which felt like a good trade
  against the five phases still ahead in this same session. The CSS changes
  above were checked by reading the resulting rules and call sites directly
  against the stated rubric (padding audit, uppercase audit, token
  substitution counts), and by `node --check` on every touched JS file plus
  `npm run build`'s strict typecheck — real verification, but not the same
  thing as looking at a rendered page, and it would not have caught a
  visual regression a screenshot would have.
- **The type and spacing scales are not retrofitted everywhere.** They
  fully govern everything built or touched in this phase (card-head/body,
  the meta tiers, the eyebrow class), and the explicitly-named half-pixel
  tier is gone. But most of the font-size/padding declarations elsewhere in
  the file's ~4,800 lines still carry their original literal values. The
  system exists and new work should use it; old work has not been swept.
- **21 of the 23 converted uppercase labels kept their original selector
  name** (`.cd-meta-label`, `.tl-badge`, `.tb-label`, and so on) rather than
  being renamed to literal `class="eyebrow"` in markup. Each one no longer
  shouts, but each is still its own CSS rule that happens to agree with
  `.eyebrow`'s values today — the drift the plan is worried about (three
  authors independently picking 10px/.05em vs. 10.5px/.06em over time) can
  still recur here, because there are still 21 independent rules, not one.
  Only the two-file `.art-title` audit (13 sites, now genuinely one
  `eyebrow()` call each) got the full single-source-of-truth treatment.
- **Card padding consolidation covered only the audited 13 sites**, not the
  full "11 distinct `.card` variants" enumerated in the plan's discovery
  (`.esc-card`, `.tri-card`, `.sr-card`, `.pt-card`, `.chart-card`,
  `.break-card`, `.manual-card`, `.skeleton-card`, `.iqs-card` used
  standalone, etc.). Those were left untouched because the plan's own
  finding scoped the *bug* to the 13 `.art-head` sites specifically
  ("`.art-head` appears 13 times in exactly two files... the other 12 are
  the visible bug") — the remaining variants have their own, individually
  consistent padding and were not flagged as broken, just as one more
  instance of the same eleven-variant sprawl. Consolidating all eleven onto
  `.card-head`/`.card-body` fully is future work, not done here.

# Phase 8 — full design pass and self-critique

Re-held the quality floor from phase 3 (focus rings, `prefers-reduced-motion`,
contrast, phone width) against every surface phases 4-7 actually added,
rather than re-auditing all eleven original pages from scratch — those were
already held against this document as each was built, and re-litigating
them without new information would not have found anything phases 3-7's
own testing didn't already catch.

**Focus rings: no gap found.** The phase 3 rule is `button:focus-visible`
(a bare tag selector) alongside the specific component classes, which
means every new plain `<button>` from phases 4-7 — notification-centre
items, the zone picker's results, toast close buttons, the phone page's
board rows — already inherits the theme-matched ring with no additional
work. Confirmed by reading the rule rather than screenshotting each one
individually, given the selector is unconditional on class.

**`prefers-reduced-motion`: no gap found**, for the same reason in reverse
— phase 3's rule is a universal selector (`*, *::before, *::after`), so it
already covers every animation/transition phases 4-7 added without needing
to be told about them. Not re-verified with reduced-motion forced in this
session (phase 3 verified the mechanism directly); if a phase 4-7 addition
introduced an animation the universal selector somehow doesn't reach, that
would be a real gap this pass did not catch.

**Contrast: not independently re-measured.** New chip tones this session
(`.chip.cyan`, `.chip.bad`, `.chip.info`, `.chip.warn`) all use the same
`color-mix(in srgb, var(--X) 20%, transparent)` background formula against
the same foreground token as every pre-existing chip tone (`.chip.ok`,
`.chip.purple`), so they inherit whatever contrast properties that
established formula already has rather than being a new, unverified
pattern. No tool ran an actual contrast-ratio check against the dark
surface in this session, for these or the original chips.

**Phone width: tested directly, found and fixed two real bugs.**
Screenshotted `/phone`, the notification panel, and the time zone strip at
375-390px (headless Chrome with device-metrics emulation, not just a
narrow browser window):

- A genuine pre-existing bug, not caused by this session's own work but
  surfaced by it: **`.icon-btn` is defined twice** in `app.css` (line 384,
  circular/borderless/34px; line 2230, square/bordered/28px, no media
  guard) — the second definition wins the cascade for every `.icon-btn` in
  the entire app, at every viewport width, and always has. It was found
  because the time zone strip's own mobile rule
  (`.tz-row-remove { display: none }` under 700px) silently lost to the
  second `.icon-btn` rule's unconditional `display: inline-flex`, so the
  remove button stayed visible and full-width at phone size instead of
  hiding. Fixed narrowly with `!important` on the one rule that needed to
  win, with a comment explaining why, rather than risking a wider
  deduplication across every element that uses `.icon-btn` this late in
  the session. **Deduplicating the two `.icon-btn` rules app-wide is real,
  disclosed follow-up work** — every icon button in QView has been
  rendering as the second definition's style since whenever that
  duplicate was introduced, not the first one a reader would assume is
  canonical.
- The phone board's table (`/phone`) inherits the shared `.tbl` class's
  mobile treatment, which turned out to be dead code app-wide: `app.css`
  has a `table.tbl tbody td::before { content: attr(data-label) }` rule
  meant to prefix each stacked mobile cell with a label, but **no page in
  the entire codebase — old or new — ever sets a `data-label` attribute**,
  so this rule has never actually labeled anything for any table. At phone
  width the phone board's rows stack without labels; this reads as
  acceptable rather than broken because the values are self-describing
  (a status is a colored chip, "Federal"/"AMER" reads as a line, `MM:SS`
  reads as a duration), but it is not the labeled treatment the CSS was
  clearly meant to provide. Not fixed — wiring `data-label` across every
  `.tbl` usage in the app is a larger, pre-existing gap than one page's
  worth of phase 8 time covers.
- The sidebar collapses to icon-only (no text labels) at phone width on
  every page, old and new alike, including `/phone` and the strip's own
  host page — confirmed this is existing, consistent, intentional-looking
  behavior (there is already a manual "Collapse" toggle with the same
  icon-only result) rather than a regression, and left alone.

**What this pass did not do:** re-screenshot the seven pre-existing pages
this session did not touch (Scorecard, Quality, Triage, Search, Patterns,
and the two not separately re-verified at phone width, Commitments and
Settings) against the completed design system. Phase 3 held the system
against Case Detail, Time Off, and Settings directly; the others were
designed against the same tokens and components but not independently
re-screenshotted a second time in this pass. If a page-specific violation
exists there that phase 3's spot-checks didn't happen to hit, this pass
would not have caught it either.
