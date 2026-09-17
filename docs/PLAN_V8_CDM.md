# QView v8 Part 2 — CDM UI Access: Phase 0

A button on every case with a cluster that opens a `portal_client` tunnel, generates
a spray token on the customer's cluster, copies it to the clipboard, and opens the
correct CDM UI (Crystal or Luna) — replacing four manual steps every time.

Everything below was measured directly: the local `portal_client` binary run for
real, a real bastion shell opened, a real `claim` grant issued against a real open
case, and a real tunnel forwarded to a real customer cluster and verified reachable
from `127.0.0.1` on this Mac. Nothing here is guessed. Where the spec's own
assumptions (or an earlier planning pass's assumptions) turned out wrong, the live
finding wins and the correction is called out explicitly — several of the
assumptions carried into planning were **materially wrong**, in ways that change
the design in Phase 3.

---

## 1. The architecture is two layers, not one

`portal_client` (the local Mac binary) has exactly three subcommands that matter:
`connect`, `exec`, `forward` — plus `copy`, `login`, `proxy`. Of these, **`connect`
and `exec` take zero flags.** Running either opens an interactive SSH shell to a
Teleport bastion pod (`portal-<hash>-<pod>`, Ubuntu 24.04), not to a customer
cluster. The bastion's login banner names the real tool:

```
To access a customer cluster, use the 'portal' command:
  portal list --help
  portal connect --help
  portal copy --help
  portal forward --help
  portal token --help
  portal claim --help
  portal access --help
```

**`portal` (no `_client` suffix) is a second, separate binary that lives on the
bastion**, reached only after `portal_client connect` drops you into that shell.
This is the actual cluster-access tool. Its full command set:

```
$ portal --help
Available Commands:
  access      Access Commands
  claim       Claim a tunnel
  cluster     Manage per-customer cluster settings
  connect     Open shell on the node
  copy        Copy data to/from the node
  exec        Execute command on the node
  forward     Start port forwarding to the node
  list        List open tunnels
  nodes       Node commands
  token       Generate RK support token for offline access
```

**Correction to every earlier assumption in this project (including my own prior
Phase 0 pass and a separate planning pass done before the live probe):** *"the
local `portal_client` binary drives everything via subcommands and flags"* is
wrong. `portal_client`'s only real jobs are (a) authenticate
(`login`) and (b) open the bastion shell (`connect`) or attach a local port to an
already-open tunnel (`forward` — see §3). Every cluster-specific operation —
claiming access, listing tunnels, generating tokens — happens through the remote
`portal` binary, run inside that shell.

---

## 2. `portal access gain` is real, but it is not this feature

The original spec referenced `portal access gain` from the internal wiki. An
earlier Phase 0 pass concluded this was wrong because `portal_client` (local) has
no `access` subcommand. That's true but was the wrong binary to check.
`portal access gain` **does exist** — on the remote `portal` binary:

```
portal access gain --ticket <Jira Ticket ID/URL> --duration <days> [--internal] [--cluster-uuid ...]
```

But its `--ticket` is a **Jira** ticket, not a Salesforce case number, and it takes
an explicit `--internal` flag ("gain access for internal clusters"). This is the
tool Rubrik engineers use to access **internal** (dev/test) clusters via a Jira
ticket — a different authorization path entirely from customer support access,
which goes through `claim` (§3) keyed to a Salesforce case. **Do not use
`portal access gain` for CDM customer access.**

---

## 3. The real flow: `claim`, then `forward` — and "open tunnel" is not something we create

### 3.1 `forward` and `connect` both require a pre-existing "open tunnel"

The very first live test — `portal_client forward --cluster-uuid <uuid>
--local-port 9770 --node-port 443` from the Mac, ticket piped to stdin — failed
immediately, before ever reading stdin:

```
Command failed: failed to start port forwarding: failed to identify an open
tunnel to connect: no open tunnels found
```

The same error came back from the *remote* `portal forward` and `portal connect`
(run inside the bastion shell), and from `portal forward --shell` (a flag that
looked like it might combine session-open + forward — it does not). **None of
`forward`, `connect`, or `forward --shell` can create a tunnel.** They only attach
to one that already exists.

### 3.2 "Open tunnel" means the customer's cluster is currently phoning home

`portal list --cluster-uuid <uuid>` is a read-only, side-effect-free status check.
Run against four of my open cases' clusters:

| Case | Cluster tag | Result |
|---|---|---|
| 01308000 | pgb-rubrik-cl001 | `No tunnels found` |
| 01273803 | SHGRubrik1 | `No tunnels found` |
| 01313394 | VREC1993AFCFE | `No tunnels found` |
| 01315394 | RUBCC-01 | **Live row returned** — `GmpenergieRsc RUBCC-01 1c9d87c3-... VRAZ238702681 14813 9.6.0-p1-33410` |

`portal list` with no filter returns the entire live registry — several thousand
rows, one per cluster/node currently connected across the whole customer base, not
just mine. **"An open tunnel" is a live fact about the customer's cluster having an
active reverse (support-tunnel) connection into Rubrik's Teleport infrastructure
at that exact moment** — it is not something the operator, QView, or `portal_client`
creates. If a cluster isn't in this registry, no sequence of local commands will
make `forward`/`connect` succeed. This is the single most important correction
from this probe: **CDM tunnel access has a genuine external precondition** (the
customer's support tunnel must be up) that RSC's flow never had. `portal nodes` on
the bastion (`list`, `register`, `clear`, `offline-entitle`) confirms this is a
Teleport node-registration concept, not a QView-side gap.

**Decision for the helper:** before attempting `claim`/`forward`, run
`portal list --cluster-uuid <uuid>` as a cheap readiness probe. If it reports no
tunnel, surface exactly that to the operator — *"This cluster has no active
support-tunnel connection to Rubrik right now. Ask the customer to confirm Support
Tunnel is enabled, or try again later."* — rather than attempting the doomed
claim/forward sequence and returning a more confusing error.

### 3.3 `claim` grants ownership; it is separate from the tunnel being open

`portal claim --cluster-uuid <uuid> --ticket <Salesforce case> --duration <days>`
(default 14 days) is the real authorization step, and **its `--ticket` is
confirmed to be the Salesforce case number** — validating security requirement 3
directly from the tool's own `--help` text, not just the spec's say-so.

Two observed behaviours, both live:

- Against a cluster **not** currently live (01308000/pgb-rubrik-cl001): claim
  prompts `No open tunnels found for this cluster. Do you still want to claim the
  tunnel [y/n]?` — answering `y` succeeds and returns *"siddhartha.roy@rubrik.com
  already has ownership of cluster with UUID: ... for case 01308000 where the
  tunnel is not open."* Ownership is granted; the tunnel still isn't attachable
  (§3.2 still applies — nothing here can override the customer-side precondition).
- Against a cluster **currently live** (01315394/RUBCC-01): claim returns
  immediately with **no y/n prompt at all** — *"already has ownership of cluster
  with UUID: ... for case 01315394."*

**So the y/n confirmation is conditional, not universal** — it appears specifically
when claiming a tunnel that isn't currently open (a "are you sure" safety check),
and is skipped when the tunnel is already live. The helper's claim automation must
handle *both* shapes: watch for the y/n pattern and answer `y` if it appears, but
not require it.

### 3.4 The decisive end-to-end test — and it changes the whole automation design

Against the live cluster (RUBCC-01, case 01315394, UUID
`1c9d87c3-94c2-409b-8bed-4ca9661f5e3f`, node `VRAZ238702681`):

1. `portal claim --cluster-uuid ... --ticket 01315394 --duration 1` — ownership
   confirmed, no prompt (tunnel already live).
2. **Local** (not remote) `portal_client forward --cluster-uuid ... --local-port
   9772 --node-port 443` (no `--ticket` flag exists on the local binary — confirmed
   again from `--help`) prompts on stdout:
   ```
   Please enter the case number/ ticket ID -
   Salesforce Case Number/ Jira Ticket ID (CDM, SPARK, INFRA, ALERT) or
   NA (if no ticket ID is available).
   Please enter the ticket ID:
   ```
   Answered with **plain piped stdin — `printf '01315394\n' | portal_client
   forward ...` — no PTY, no `expect`, no `script`, no `node-pty`.** It worked on
   the first try:
   ```
   Started port forwarding from local port 9772 to Tunnel(NodeID:
   VRAZ238702681, Port:14813, ClusterUUID: 1c9d87c3-...) on port 443
   ```
3. `lsof -nP -iTCP:9772 -sTCP:LISTEN` on the Mac confirmed a real `portal_client`
   listener on `127.0.0.1:9772` — genuinely reachable by Chrome.
4. Cleanly killed; port released; no orphaned processes.

**This directly confirms the original Phase 0 hypothesis for the tunnel itself:**
a Go CLI prompting for a ticket on a bare `bufio`-style prompt is satisfied by a
plain `child_process.spawn` with piped stdio. The earlier concern (from the
follow-up planning pass) that `promptui`/`survey`/`bubbletea`-style libraries would
isatty-guard and hang on a pipe **did not materialize for `forward`'s ticket
prompt** — it is a plain readline-style prompt on stdout/stdin.

**What does need a PTY: the bastion shell itself**, for `claim`. `portal_client
connect` opens a real interactive shell (confirmed: it's a login shell with a
banner, a prompt, and job control) — piping `/dev/null` or a bare newline at it
produces silent no-op behaviour (exit 0, no output), and `exec` behaves
identically for the same reason (see §4). Driving `connect` to run `portal claim
...` and answer its conditional y/n was done successfully with **`expect`** — a
pre-installed macOS/BSD system binary requiring no new dependency, exactly the
zero-dependency alternative to `node-pty` a prior planning pass had already
flagged (`script -q /dev/null` was the other candidate; `expect`'s pattern-match
+ conditional-reply model is the better fit here since the y/n prompt is
conditional, not guaranteed).

### 3.5 The corrected two-part automation model

This replaces the single-mechanism model in the original spec and in the
pre-probe plan:

| Step | Where | Mechanism | Long-lived? |
|---|---|---|---|
| Readiness check | local | `portal_client connect` (PTY) → `portal list --cluster-uuid <uuid>` inside it → parse for a data row vs. `No tunnels found` | No — one-shot |
| Claim | local → bastion | `portal_client connect` (PTY, via `expect`) → `portal claim --cluster-uuid <uuid> --ticket <case> --duration <N>`, answer `y` if prompted | No — one-shot, then exit the shell |
| Tunnel | local, directly | `portal_client forward --cluster-uuid <uuid> --local-port <port> --node-port 443`, plain piped stdio, ticket written to stdin immediately | **Yes** — this is the session |

The long-lived process — the one that matters for the session registry, signal
handlers, and the boot-orphan sweep — needs **no PTY at all**. Only the short,
one-shot claim step does, and `expect` covers it with no new npm dependency,
matching the "no `node-pty` yet" decision.

---

## 4. `exec` is a dead end for this feature

`portal_client exec` (local, zero flags) and `portal exec` (remote, "Execute
command on the node") both looked like the natural non-interactive automation
path for spray-token generation. Live testing shows the *local* `exec` is not
usable:

- `portal_client exec --cluster-uuid ...` → `Error: unknown flag: --cluster-uuid`
  (confirmed zero flags, no override).
- `portal_client exec` with closed stdin (`< /dev/null`) → exits 0, **no output at
  all**.
- Piped a bare newline → same silent no-op.
- Run under a real PTY (`script -q`) → still nothing rendered in 4 seconds.
- A `--conf` pointing at a nonexistent file → still exits 0 silently; no config
  file exists anywhere on this Mac, confirming "assuming defaults" from the
  original Phase 0 pass.

**Correction:** the working hypothesis that `exec` was "the automation path" for
either the tunnel or the token is wrong. **Token generation must go through the
remote `portal exec` (run inside a `connect` bastion shell, targeting the cluster
node once a tunnel is open) or through a `portal connect`-to-the-node session** —
this is deferred to Phase 5 and needs its own short live probe at that time,
against a cluster confirmed live via `portal list` first (§3.2). The manual
fallback (copy the exact commands, paste the result) remains the permanent,
always-present tier regardless of what Phase 5 finds — this was never contingent
on `exec` working.

---

## 5. Auth pre-flight (unchanged from the original probe, re-confirmed)

`ssh-keygen -L -f ~/.ssh/portal-cert.pub` parses the Teleport cert. The cert found
at the start of this session had already expired 13 minutes prior (`Valid: ...
15:32:47 to ... 16:32:47`, checked at 16:45) — **re-confirming the cert is
genuinely 1-hour** and a session can trivially outlive it. `portal_client login`
re-authenticated silently (no visible browser interaction needed — an existing SSO
session covered it) and issued a fresh cert, `16:45:49` to `17:45:49`. The panel
must surface cert expiry; an established `forward` session likely survives past
its cert (the SSH-equivalent connection is already up), but a *new* claim/forward
attempted after expiry will need a fresh `portal_client login` first. The helper
should pre-flight the cert and, on failure, tell the operator to run
`portal_client login` rather than trying to script Okta SSO itself — SSO is
explicitly not something to automate.

---

## 6. Salesforce data — six corrections, all from live SOQL

Verified against the 14 open cases actually owned.

1. **`Platform__c` must not gate the CDM button.** Cases 01273803, 01313394,
   01315394 are `Platform__c = Polaris` with populated clusters; 01314320 has
   `Platform__c` **null entirely**. Gate on "cluster UUID present," full stop.
2. **The human-readable cluster tag is `Cluster__r.tag__c`, not `Cluster__r.Name`.**
   `Name`'s field label is literally "Cluster UUID" — `Name` and `uuid__c` are the
   same value. This matters directly: `portal claim`/`forward` accept
   `--cluster-tag` as an alternative to `--cluster-uuid`, and passing the UUID
   there would be a bug.
3. **The case-level `Software_Version__c` fallback is unsafe as written** and, on
   current data, **rescues nothing**: observed values are `"Rubrik Security Cloud
   (RSC)"`, `"Other"`, and `null`. The one case with a null cluster-level version
   (01313394) has a case-level value of `"Rubrik Security Cloud (RSC)"`, which the
   `^\d+\.\d+` guard correctly rejects. Keep the fallback (one line, cheap, may
   help on a case not yet sampled) but do not rely on it.
4. **Versions carry patch suffixes** (`9.5.1-p2-36376`, `9.6.0-p1-33410`) — parse
   leading `X.Y` only.
5. **Two-cluster cases are rare but real** — 8 of 14 open cases have `Cluster__c`;
   exactly one (01308000) also has `Additional_Cluster__c`.
6. **`Cluster_ID_Read_Only__c` and `Support_Tunnel__c` are not worth syncing.**
   `Cluster_ID_Read_Only__c` mirrors `Cluster__c`'s UUID with no independent
   information. `Support_Tunnel__c` is overwhelmingly null with a handful of
   inconsistent junk values where populated (`"Not available"`, bare numbers, one
   stray UUID) — not a usable signal for whether a cluster's support tunnel is
   actually live. (§3.2's `portal list --cluster-uuid` is the real, live way to
   answer that question — Salesforce cannot.)

`Cluster__r.uuid__c`, `Cluster__r.tag__c`, and `Cluster__r.software_version__c` are
confirmed populated and correctly named from live SOQL on all 8 clustered open
cases.

---

## 7. Decisions this doc locks in (continuing straight to Phase 1, per the
   agreed gate — no separate review stop)

1. **Two-part automation, not one.** A short PTY-driven claim step (`expect`,
   zero new dependency) plus a long-lived, PTY-free `forward` process (plain
   piped stdio) — not a single mechanism, and not `node-pty`.
2. **A readiness check (`portal list --cluster-uuid`) runs before claim/forward**,
   and its failure gets a specific, honest error message rather than a generic
   tunnel-start failure.
3. **`exec`-based token generation is deferred to a fresh live probe in Phase 5**,
   scoped to a cluster confirmed live via the readiness check. The manual
   fallback tier is unaffected either way.
4. **Crystal/Luna resolution stays Salesforce-only, per the earlier decision** —
   this probe did not test tunnel-based version probing and was not asked to;
   that option was explicitly not chosen.
5. **Sync `Cluster__r.tag__c` (not `Name`) for the cluster tag; drop
   `Support_Tunnel__c` and `Cluster_ID_Read_Only__c`** from the Phase 1 column
   list — one addition, two removals from the original plan.
6. **Real customer access was exercised during this probe** — a genuine `claim`
   grant (1-day duration) against case 01315394/RUBCC-01, and one real tunnel
   opened, verified, and cleanly closed, using the real case number as the ticket
   throughout (security requirement 3). This was a legitimate use of the tool
   against an open, real support case ("Waiting for Rubrik Support") — not a
   synthetic test against unrelated customer infrastructure.

---

## 8. Phase 5 — spray token generation, live-tested against the actual node

This section was written after Phases 1-4 shipped (five commits) and the whole
tunnel was validated end-to-end through the real helper implementation, not just
an ad-hoc probe script: `POST /sessions` on the actual `cdmHelperServer.ts`
completed the full readiness-check → claim → forward sequence unattended and
reached `state: "open"` with a real listener on `127.0.0.1`, confirming Phase 3's
design needs no manually-held companion session of any kind — local
`portal_client forward` alone, after `claim`, is sufficient.

### 8.1 `portal connect` (remote) reaches the actual cluster node

With a tunnel genuinely open (via the real helper, this time — not a hand-held
`expect` session), remote `portal connect --cluster-uuid <uuid> --ticket <case>`
(inside the same one-shot bastion shell as `claim`) succeeded and dropped into a
**real shell on the CDM node itself**:

```
rksupport_basic@VRAZ238702681:~$
```

`VRAZ238702681` matches the node ID `portal list` reported for this cluster. The
earlier failed attempt at this same command (Phase 0, section 3) was against a
cluster with no live tunnel at all — the command itself works fine once a tunnel
exists; nothing else needed to change.

### 8.2 The spray-token script, confirmed present and inspected

```
$ ls -la /opt/rubrik/src/scripts/dev/get_local_spray_token.*
-rwxrwxr-x 1 ubuntu ubuntu 4731 Aug 24 23:33  get_local_spray_token.py
-rwxrwxr-x 1 ubuntu ubuntu  144 Aug 24 23:33  get_local_spray_token.sh
```

`/usr/local/rubrik/...` does not exist on this node — only `/opt/rubrik/...` is
real. `.sh` is a thin wrapper (`source scl_source enable python27` on RedHat,
then just execs the `.py` with the same args) — calling the `.py` directly, as
`cdmToken.ts` does, skips an irrelevant RedHat-only branch on this Ubuntu node.

`--help` confirms the real signature:
```
usage: get_local_spray_token.py [-h] --username USERNAME
                                [--organization-id ORGANIZATION_ID]
                                [--caller CALLER]
```
`--username` is required, no default. `--organization-id` and `--caller` are
optional.

### 8.3 Every username tried was denied — a real permission gate, not a guess

Four candidates tried against this cluster, all failing identically:

| `--username` | Result |
|---|---|
| `support` | `Unable to get local spray token. Please check the target --username, and confirm you have the permission to request a token for that user.` (exit 1, empty output) |
| `support_basic` | same |
| `rksupport` | same |
| `rksupport_basic` (the OS login itself) | same |

The identical message across four different targets, including the exact OS
username we're logged in as, points to a genuine authorization gate on this
account/cluster combination rather than a wrong-username guess. Phase 0's own
recon already surfaced the documented escalation path: `portal token --escalate`
("Generate an escalation token for rksupport user. Use this only if you are
currently able to log in as rksupport_basic and need to escalate to rksupport")
— which opens a real JIRA ticket or posts to `#low-privileged-support-user`.
**Deliberately not triggered here** — escalating access is a judgement call for
the operator with a real justification, not something `cdmToken.ts` should ever
do on its own.

### 8.4 What shipped despite the permission wall

The full mechanism is implemented and live-tested up to (but not across) that
wall: locate the script, drive `portal connect` non-interactively via the same
one-shot `expect` pattern as `claimAccess`, run the script with each candidate
username redirected to a node-local temp file, **validate on the node itself**
(`curl -sk -H "Authorization: Bearer $(cat <tmpfile>)" https://localhost/api/v1/cluster/me`
— `$(...)` expands server-side, so the raw token is never present in a command
line this process sends, and therefore never echoed into shell history), extract
the token from between a pair of per-candidate markers only on a `200`, hand it
straight to `copyToMacClipboard()`, and delete the remote temp file regardless of
outcome. `generateToken()` never returns the token value itself — the HTTP
response from `/sessions/:id/generate-token` carries only `{ok, via}`.

**What is not live-validated**: the actual success path (a `200` from the
validation curl). Every candidate tried failed at generation, so the
extract-and-pbcopy branch has not fired against real data. The manual-token tier
(shipped in Phase 4, unaffected by any of this) is not a stopgap for that reason
— it is, empirically, the path that works today on the one cluster this was
tested against.
