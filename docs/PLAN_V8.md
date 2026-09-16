# QView v8 Part 1 — Plan

A button on every case that generates an RSC support access token, copies it to the
clipboard, and opens the customer's login page. This document records what Phase 0
discovery actually found — an architecture question the spec itself told us to stop
and confirm, and a Salesforce field-population question — and the decisions that
follow from that. Part 2 (CDM UI access) is out of scope; see the notes at the end.

Everything below was measured directly (live SSH to the VM, live network probes,
live Salesforce queries against real case data), not assumed. Where a finding
contradicts the spec author's own guess, the finding wins and the contradiction is
called out.

---

## Phase 0 — discovery

### 1. Where does the QView server actually run?

The spec's own instruction: *"gcloud runs on my Mac. If the QView server is on the
same machine it can shell out; if it runs elsewhere it cannot, and the feature needs
a different shape... If the server is remote, stop and tell me before building
anything."*

**Finding: the server is remote.** QView's live instance runs on the VM
(`10.26.118.153:3001`), deployed as a service inside the sibling
`salesforce-case-tracker` Docker Compose stack — not on the Mac. Confirmed three
ways:

| Check | Result |
|---|---|
| `which gcloud` on the VM | not found |
| `curl -X POST https://pacman.prod.my.rubrik.com/query_open_support_access` from the VM (no auth) | `HTTP 403`, body `{"error":"Caller has insufficient permissions to access the endpoint"}` — the VM is not on `vpn-colo-sso`/`vpn-bldc` |
| `gcloud auth list` on the Mac | already authenticated as `siddhartha.roy@rubrik.com` (the correct, verified support identity from v7's ownership-disambiguation work) |

DNS resolution and raw TCP to `pacman.prod.my.rubrik.com` (34.8.255.182) work fine
from the VM — the block is at the application/network-policy layer (Google IAP or
equivalent), consistent with the spec's own "otherwise 403" framing. Installing
`gcloud` on the VM would not fix this: the network gate is the harder blocker, and
there is no route to bring the VM's egress onto the required VPN from within this
repo.

**Decision: split the feature across two processes.** A new, small standalone
server — the **RSC helper** — runs only on the Mac as a macOS LaunchAgent
(auto-starting at login), and is the only thing that ever shells `gcloud` or talks
to pacman. It lives in this same repo/npm project (new TypeScript entrypoint
compiled by the existing `tsc` build, no new dependency — `express` is already a
dependency). The case-detail page, still served from the VM, talks to the helper
directly over `localhost` for token generation, and separately calls the
VM-hosted main app to persist a token-free audit row. See the Architecture diagram
in the implementation plan for the exact request shape.

This means the RSC button only works when the user is at their Mac, on VPN, with
the helper running — which is exactly the condition under which the feature is
useful (impersonating a customer tenant is not something to do from an arbitrary
machine). The main app's Docker image needs zero changes for this feature: no
`gcloud` install, no new system packages, no VPN configuration in `docker-compose.yml`.

### 2. `Account_Polaris_URL__c` vs `RSCInstance__c`

The spec's own instruction: *"Also investigate `RSCInstance__c` — if the lookup
object carries a URL and is populated more reliably on recent cases, prefer it and
fall back to the legacy string."*

**Finding: the opposite is true.** Queried both fields directly against the user's
15 real open cases (`Owner.Name = 'Siddhartha Roy' AND IsClosed = false`):

| Field | Populated | Notes |
|---|---|---|
| `Account_Polaris_URL__c` ("RSC Instance (Legacy)") | **15 / 15** | Every open case has this. |
| `RSCInstance__r.RSCUrl__c` (via the `RSCInstance__c` lookup) | **2 / 15** | Sparse. |

Where both are populated, the URL values are byte-identical (e.g. case `01301616`:
both read `https://snhu.my.rubrik.com`). The `RSCInstance__c` object also carries a
`Status__c` picklist (`ACTIVE`/`HOLD`/`GRACE`/`SUSPENDED`/etc.) — not used by this
feature, but worth knowing it exists for anyone extending this later.

`RSCInstance__c` reaches the Case object as a standard lookup, so its
Salesforce-generated relationship name is `RSCInstance__r`, reachable via the same
inline-relationship-traversal pattern this codebase already uses for `Owner.Name`/
`Account.Name` (`src/salesforce.ts`) — no second SOQL round trip needed.

**Decision: `Account_Polaris_URL__c` is primary; `RSCInstance__r.RSCUrl__c` is a
fallback used only when the legacy field is empty.** Resolved once at sync time
(same pattern as this codebase's existing `product_area` local derivation), not
re-resolved on every read.

### 3. Federal / FedRAMP gating fields

`US_Federal_Account__c` (boolean), `isFedRAMP__c` (boolean), and
`Federal_Account_Support_Access__c` (string(1300)) all exist exactly as the spec
describes and are populated in production (verified against 5 real federal cases,
e.g. case `00020578`: `US_Federal_Account__c = true`,
`Federal_Account_Support_Access__c = "No WebEx/no log data"`). No surprises here.

### 4. CDM fields (Part 2 — not built, notes only)

Per the spec's explicit instruction to note findings without building toward Part
2:

- `Cluster__c` and `Additional_Cluster__c` — both `reference` fields pointing at a
  custom `Cluster__c` object.
- `Cluster_ID_Read_Only__c` and `Support_Tunnel__c` — plain `string` fields, no
  relationship.
- `Platform__c` ("Product-Line") — a picklist with values `Polaris, CDM, NAS Cloud
  Direct, Laminar, DatosIO, Other, Duplicate, Spam/Junk, Backrightup, Predibase,
  Strata`. This is the field that would distinguish a CDM-eligible case from a
  Polaris/RSC one when Part 2 is built.

Nothing else was investigated for Part 2 — no CDM UI, no cluster-access flow, no
speculative scaffolding, per the spec's "build nothing" instruction.

### 5. Documentation-numbering gap (unrelated, noted for continuity)

`docs/PLAN_V6.md` and `docs/PLAN_V7.md` were never committed, despite both phases
shipping (their decisions live only in inline code comments, e.g. `src/config.ts`'s
`v7 phase 4` comment for the `SALESFORCE_OWNER_ID` override). This document restarts
the numbered-plan convention at v8 rather than backfilling the gap.

---

## Decisions carried into implementation (recorded here per the spec's own
## instruction to record judgment calls rather than make them silently)

1. **RSC helper port: `8756`.** Confirmed free on the Mac (`lsof -iTCP:8756` —
   nothing listening) and distinct from the main app's `3001`/`3443`.
2. **`gcloud` binary path must be set explicitly in the launchd plist's
   environment**, not left to the default bare `"gcloud"` (which is what the
   user's original manual script relies on from an interactive shell). launchd
   LaunchAgents do not source `.zshrc`/`.zprofile`, and this is a portable,
   `~/Downloads`-folder gcloud install — not on any standard PATH a login item
   would see. The plist sets `GCLOUD_BIN_PATH=/Users/siddhartharoy/Downloads/
   google-cloud-sdk/bin/gcloud` directly.
3. **The spec's `gcloud_missing` error message** ("Set the path in Settings")
   assumed one process with an in-app Settings page. The standalone helper has no
   such UI. Adjusted wording: "gcloud SDK not found at `{path}`. Set
   `GCLOUD_BIN_PATH` in the RSC helper's environment."
4. **The audit table (`support_access_log`) gets no dedicated UI in this
   release.** The spec frames it as answering "when did I last go into this
   tenant" later, which a direct SQLite query already satisfies — building a
   history view would be scope beyond what was asked.
5. **Federal/FedRAMP gating is enforced client-side only** (disabled button, no
   `onclick` wired) rather than also re-checked inside the helper. The helper has
   no access to Salesforce case data to verify such a flag against, and this is a
   single-operator personal tool, not a multi-tenant security boundary — pacman
   itself remains the real authorization check regardless.
6. **Phases 2, 3, and 4 shipped as one commit, not three.** The plan's own
   phase split (field sync + button/panel UI, then clipboard tiers, then
   errors/federal-gating/audit-log) assumed more separability than the actual
   code has: the button's five states need the error-message contract to
   exist, the panel needs the clipboard tiers to be a complete, testable unit,
   and the audit call is one line inside the same `pick()` function the panel
   already needed. Splitting these into three commits would have meant two of
   them left the app in a state that doesn't build toward anything usable on
   its own. All of it is still gated on the same acceptance criteria the
   original three-phase table implied; only the git history is flatter than
   planned.
7. **The RSC panel formats `enable_at`/`expired_at` defensively**
   (`fmt.dateOnly`/`fmt.dateShort`, which already fall back to "—" on anything
   that doesn't parse as a date) rather than assuming a specific string shape.
   Live testing hit a real `gcloud` reauthentication requirement mid-build
   (Google's reauth policy expired the session between the Phase 1 gate test
   and a later Phase 2 check — confirmed via `gcloud auth print-identity-token`
   directly, which is exactly the `gcloud_unauth` path's own error text: "Run
   `gcloud auth login`"), which blocked inspecting a second live response
   before this was written. The `url`/`user_email`/`domain`/`token` fields
   were already confirmed against a real response in Phase 1 and are used
   as-is; only the two date fields' exact string format was unconfirmed, so
   they get the defensive treatment. **This also live-validates the
   `gcloud_unauth` error path itself was hit for real, not simulated** — the
   helper correctly distinguished it from `gcloud_missing` and returned the
   exact spec-required message.
