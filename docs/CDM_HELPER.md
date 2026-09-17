# CDM tunnel helper

A small standalone process, separate from both the main QView server and the
RSC helper, that runs **only on the Mac** and drives `portal_client` /
`expect` / Chrome for CDM UI access. See `docs/PLAN_V8_CDM.md` for the full
architecture and why it's a separate process from `com.qview.rsc-helper`: a
`launchctl kickstart -k` after an RSC-side change must never be able to drop
a live tunnel into a customer cluster.

It listens on `http://127.0.0.1:8757` (loopback only) and is called directly
by the case-detail/queue pages' browser JS, even though those pages are
served from the VM. No login of its own — same trust boundary as the RSC
helper (see `src/cdmHelperServer.ts`'s header comment).

## What it actually does, per session

1. **Readiness check** — `portal list --cluster-uuid <uuid>` via a one-shot
   `portal_client connect` session (needs a PTY; driven by `expect`, a
   pre-installed system binary). Fails fast with a clear message if the
   customer's cluster has no active support-tunnel connection right now —
   this is an external fact, not something the helper can fix.
2. **Claim** — `portal claim --cluster-uuid <uuid> --ticket <case> --duration
   <days>` inside the same kind of one-shot bastion session, answering the
   conditional `[y/n]` confirmation when it appears.
3. **Forward** — the long-lived part. Local `portal_client forward
   --cluster-uuid <uuid> --local-port <port> --node-port 443`, ticket piped
   to stdin. No PTY needed for this step — confirmed live
   (`docs/PLAN_V8_CDM.md`).
4. **Chrome** — a disposable `--user-data-dir` profile per session, spawned
   directly (not `open -na`), so `__Secur-rubrik-token` never leaks between
   concurrent sessions to different clusters.
5. **Token generation (optional, on request)** — `portal connect` again, this
   time straight through to the cluster node itself, running
   `/opt/rubrik/src/scripts/dev/get_local_spray_token.py` for a short list of
   usernames and validating each on the node before handing a match to
   `pbcopy`. Empirically denied on at least one real cluster/account (see
   `docs/PLAN_V8_CDM.md` §8) — the manual-token box in the panel always works
   as a fallback regardless of what this finds.

## One-time setup

1. Build the project as usual: `npm run build` (produces
   `dist/cdmHelperServer.js` alongside the main app and the RSC helper).
2. Confirm the paths in `deploy/com.qview.cdm-helper.plist` still match your
   machine — `ProgramArguments`' `node` path (`which node`),
   `PORTAL_CLIENT_PATH` (`which portal_client`, or wherever the binary
   actually lives — this repo's is `/Users/siddhartharoy/portal_client`, not
   on PATH), and (if Chrome isn't at the default location) `CHROME_BIN_PATH`.
3. Install the LaunchAgent:
   ```bash
   cp deploy/com.qview.cdm-helper.plist ~/Library/LaunchAgents/
   launchctl load -w ~/Library/LaunchAgents/com.qview.cdm-helper.plist
   ```
4. Verify it's up:
   ```bash
   node -e "fetch('http://127.0.0.1:8757/health').then(r=>r.json()).then(console.log)"
   ```
   (`curl` works too where your shell allows it.)
5. Make sure your Teleport identity is current: `ssh-keygen -L -f
   ~/.ssh/portal-cert.pub | grep Valid`. The cert is **1 hour** — if it's
   expired, run `portal_client login` in a terminal before starting a
   session; the helper does not attempt to automate Okta SSO.

## After a code change

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.qview.cdm-helper
```
Kickstarting the CDM helper stops every live tunnel it's holding (by
design — its own signal handler tears them down cleanly first). Kickstarting
the **RSC** helper instead does not touch CDM sessions at all, which is the
entire reason these are two processes.

## Logs

- `~/Library/Logs/qview-cdm-helper.log` — structured JSON app log (same
  format and redaction rules as the main app's `src/log.ts`). Never contains
  the spray token or a command transcript — see the header comments in
  `src/cdmAccess.ts` and `src/cdmToken.ts`.
- `~/Library/Logs/qview-cdm-helper.stdout.log` / `.stderr.log` — raw process
  output, mainly useful if the process fails to start at all.
- `~/Library/Logs/qview-cdm-sessions.log` — a separate, purpose-built JSONL
  file: one line per session open/stop (case, cluster, port, timestamps).
  No token, ever, by construction of what's written to it.

## Uninstall / stop

```bash
launchctl unload ~/Library/LaunchAgents/com.qview.cdm-helper.plist
```
This runs the same clean shutdown path as a `kickstart -k` — every live
session is stopped first.

## Manual run (no auto-start), for local development

```bash
npm run dev:cdm-helper
```
Reads the same env vars as the plist; set them in your shell or `.env` first
(`PORTAL_CLIENT_PATH`, `CHROME_BIN_PATH`, `EXPECT_BIN_PATH`,
`CDM_HELPER_PORT`, `CDM_ALLOWED_ORIGINS`, `CDM_PORT_MIN`/`CDM_PORT_MAX`).

## If a tunnel is ever orphaned

The helper's own boot sweep should catch this automatically (it runs on
every start, including after a crash), but to check by hand:

```bash
lsof -nP -iTCP:9770-9799 -sTCP:LISTEN
ps -p <pid> -o comm=   # confirm it's actually portal_client before killing
kill <pid>
```
