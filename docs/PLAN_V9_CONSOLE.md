# QView v9 Part 3 — Shift Console: Phase 0 discovery

Source: `~/Downloads/qview-v9-part3-shift-console-prompt.md`. The spec's own build
order gates Phase 0 with "Stop, I review" — this document answers the two
feasibility questions it asks for, plus one design question the spec doesn't
resolve, live-measured, before any code is written.

---

## 1. Can the QView box reach a quote provider?

**Yes, both.** Probed directly from the production VM (`10.26.118.153`, the box
that will actually make the server-side ticker call):

| Provider | Endpoint | Result |
|---|---|---|
| Finnhub | `GET finnhub.io/api/v1/quote?symbol=RBRK&token=test` | `HTTP 401` in 0.14s |
| Twelve Data | `GET api.twelvedata.com/quote?symbol=RBRK&apikey=test` | `HTTP 401` in 0.30s |

A bogus token was used deliberately — the `401` is the provider's own
"invalid API key" response, which only happens after DNS resolution, TLS
handshake, and a full HTTP round trip succeed. Neither host is blocked by a
corporate proxy. **Finnhub is the primary provider**, per the spec.

## 2. Does a second `requestWindow()` really close the first, in Chrome?

**Yes — this is spec-defined behavior, not implementation folklore.** The
[WICG Document Picture-in-Picture spec](https://wicg.github.io/document-picture-in-picture/)
states directly: *"Any top-level traversable must have at most one document
picture-in-picture window open at a time... the user agent must close the
existing last-opened window."* [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API)
confirms Chrome enforces this as a single global window, not just per-tab.

This also matches how the codebase already models it — `phonePip.js` tracks
a single `documentPictureInPicture.window` and gates every open through
`isPipOpenLocally()` (`public/js/lib/phonePip.js:59-67`); there is no code
path anywhere that expects more than one PiP window to exist. Nothing to
build to confirm this further — it's confirmed by spec, by MDN, and by the
existing code's own assumptions all agreeing.

**Conclusion for both questions: this is a pane refactor, not a second
window**, exactly as the spec concludes. `phonePip.js` becomes the shift
console; the phone strip becomes one pane among three.

---

## 3. A design question the spec doesn't resolve: does the console force dark, or follow the app theme?

Not one of the two questions asked, but it blocks Phase 1's CSS and is worth
settling before writing `console.css` rather than guessing.

**Finding:** theming in this app is a `body.light` class override sitting on
top of dark-by-default `:root` values (`public/css/app.css:90-115`), toggled
by the user's theme button (`public/js/app.js:318-320`) and persisted in
settings. `phonePip.js:177` already clones `document.body.className` into
the pop-out, which is how the phone pane currently stays theme-consistent
with the main app.

The spec's color table lists only the dark values and describes the mood as
"instrument panel... dense, dark, calm at rest... the reference is a glass
cockpit or a trading terminal" — language that reads as an always-dark
surface, not a theme-following one. But it never says "force dark" outright,
and the existing className clone means "just inherit tokens" will silently
follow the app's light/dark toggle instead, which would contradict that
mood description the moment the app is switched to light.

**This needs a decision before Phase 1:**
- **Force dark always** — `.qv-console` redeclares the dark token values
  itself, ignoring `body.light`. Matches the "trading terminal" framing
  literally; the console never changes appearance regardless of the app.
- **Follow the app theme** — leave the existing className clone alone, no
  override. Simpler, consistent with how the phone pane already behaves
  today, but the light-theme console has never been designed against and
  isn't covered by any of the spec's mood/color language.

---

## Recommendation

Proceed to Phase 1 (rename `phonePip.js`'s console shell, add
`console.css` scoped under `.qv-console`, move the phone strip into a pane)
once the theme question above is answered. Everything else in Phase 0 is
resolved with no open blockers.
