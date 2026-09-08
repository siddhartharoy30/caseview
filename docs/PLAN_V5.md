# QView v5 — decisions recorded during implementation

Per the implementation plan's own instruction to record certain calls here
rather than make them silently. Phase-numbered to match the plan's own
phases.

## Phase 2 — the pool-size denominator

The prompt's own example ("#1 of 3 in AMER · India") doesn't define what the
`3` counts. Chosen: `poolSize` is every roster member sharing my line and
region **regardless of live status** — not just currently-available ones.
This is a calmer number that doesn't flicker every time a pool-mate goes to
ACW or offline; `position` and `ahead` stay live-and-available-only, per the
plan's literal wording, since those are the numbers an alert actually acts
on. If this reads oddly once more agents are classified (e.g. showing "of 3"
when only one is ever on shift at a given hour), reconsider scoping
`poolSize` to "seen on the board within the last N days" instead of "ever
classified" — not built here since the roster is too new to have that
history yet.

## Phase 3 — toast duration: one base, not three independent settings

The plan's own three-tier table (normal 5000ms / warn 6000ms / err 8000ms)
and its ask for one user-tunable `toastDurationMs` setting don't reconcile
literally — three numbers, one knob. Chosen: `toastDurationMs` is the base
("normal"); `warn = base + 1000`, `err = base + 3000`, computed in `ui.js`'s
`defaultDuration()`. The default (5000) reproduces the table exactly, and
moving the setting shifts all three together, preserving the escalation
ordering rather than letting an edit collapse warn and err back toward
normal. If independent control is ever wanted, it would need three separate
settings and a corresponding UI change — not built here since one knob was
the explicit choice.

## Phase 3 — Phase 4a absorbed, not built separately

The plan's own BUILD ORDER table already anticipates this ("already done if
Phase 3 pulled it forward"). Phase 3 fully builds `phoneMonitor.js` as a
boot-time singleton, gated only on the `phoneMonitorEnabled` setting, not on
whether any particular surface (page, dock, pop-out) is currently watching
— the only gate consistent with both Phase 3's own requirement (alerts
survive leaving `/phone`) and the not-yet-built multi-surface requirement
from Phase 4b/4d. **There is no separate Phase 4a commit or code.** A later
reader looking for a second monitor module should stop here: this is it.

## Phase 4c — the deployed instance needs a manual step this repo can't do

The HTTPS listener and cert-generation steps ship in this repo's own code
and `README.md` (see the Security section). But `docker-compose.yml`'s own
header says the deployed VM instance doesn't actually run from this repo's
compose file at all — it runs as one service inside a sibling
`salesforce-case-tracker` compose stack, in a different repository this
plan has no access to. That sibling stack's `qview` container currently
publishes port 3001 as `0.0.0.0:3001->3001` — **not** loopback-only like
this repo's own standalone file, so whoever adds the matching TLS mapping
there should follow *that* stack's existing pattern, not copy this file's
`127.0.0.1:3443:3443` line verbatim.

**Open TODO, not yet done:** add a `3443:3443` (or `0.0.0.0:3443:3443`,
matching the existing port-3001 mapping) entry to the sibling stack's
compose file, generate a real cert for `10.26.118.153` on the VM, and set
`QVIEW_TLS_CERT`/`QVIEW_TLS_KEY` in that deployment's own `.env`. Until
that happens, `https://10.26.118.153:3443` is not reachable even though
the code to serve it is live — Phase 4d's Document PiP tier will correctly
report `insecure-context` and fall back to the popup/dock tiers on the real
deployed instance until this is done by hand.
