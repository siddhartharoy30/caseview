# RSC support-access helper

A small standalone process, separate from the main QView server, that runs
**only on the Mac** and generates RSC support-access tokens. See
`docs/PLAN_V8.md` for why it's a separate process: QView's live dashboard runs
on the VM, but `gcloud` and the VPN pacman requires only work from here.

It listens on `http://127.0.0.1:8756` (loopback only) and is called directly
by the case-detail page's browser JS, even though that page is served from
the VM. It has no login of its own — see `src/rscHelperServer.ts`'s header
comment for why that's an acceptable trust boundary for this feature.

## One-time setup

1. Build the project as usual: `npm run build` (produces `dist/rscHelperServer.js`
   alongside the main `dist/server.js`).
2. Confirm the paths in `deploy/com.qview.rsc-helper.plist` still match your
   machine — in particular `ProgramArguments`' `node` path (`which node`) and
   `GCLOUD_BIN_PATH` (`which gcloud`, or wherever your SDK actually lives —
   this repo's own gcloud is a portable install under `~/Downloads/google-cloud-sdk/`,
   not on a standard PATH).
3. Install the LaunchAgent:
   ```bash
   cp deploy/com.qview.rsc-helper.plist ~/Library/LaunchAgents/
   launchctl load -w ~/Library/LaunchAgents/com.qview.rsc-helper.plist
   ```
4. Verify it's up:
   ```bash
   node -e "fetch('http://127.0.0.1:8756/health').then(r=>r.text()).then(console.log)"
   ```
   (Plain `curl` works too if your shell allows it — the health check itself
   has no dependency on either tool.)

## After a code change

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.qview.rsc-helper
```

## Logs

- `~/Library/Logs/qview-rsc-helper.log` — structured JSON app log (same format
  as the main app's `src/log.ts`, same redaction rules).
- `~/Library/Logs/qview-rsc-helper.stdout.log` / `.stderr.log` — raw process
  output, mainly useful if the process fails to start at all (e.g. a bad
  `GCLOUD_BIN_PATH`).

## Uninstall / stop

```bash
launchctl unload ~/Library/LaunchAgents/com.qview.rsc-helper.plist
```

## Manual run (no auto-start), for local development

```bash
npm run dev:rsc-helper
```
Reads the same env vars as the plist; set them in your shell or `.env` first
(`GCLOUD_BIN_PATH`, `PACMAN_BASE_URL`, `RSC_HELPER_PORT`, `RSC_ALLOWED_ORIGINS`).
