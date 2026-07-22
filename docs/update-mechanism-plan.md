# In-app update mechanism (issue #173)

## Context

Today the only way to update Loadout is to re-run `curl -fsSL …/install.sh | sh` from a terminal — untenable on a handheld in Gaming Mode. Issue #173 asks for an update mechanism that fetches the latest release and restarts the overlay, driven entirely from the overlay. Requirements: check on startup with a toast, a manual check/update button in Settings, download + restart on button press, and a "skip this version" option that silences the toast for that version only.

Releases already publish everything needed: tags `vX.Y.Z` with assets `loadout-x86_64` (backend binary), `loadout-overlay-x86_64.tar.xz` (~300 MB), `loadout-plugins-x86_64.tar.xz`, and `SHA256SUMS`. There is no self-update code anywhere in the repo today.

## Core design: split by privilege

- The **backend** (`apps/loadout/`) runs as **root** (`/etc/systemd/system/loadout.service`). It updates its own binary (resolving its path via `/proc/self/exe`, which automatically handles SteamOS `~/.local/share/loadout/loadout` vs `/usr/local/bin/loadout` + `restorecon`), swaps `plugins/` + `node_modules/` (it writes root-owned `.cache/` dirs there, so only root can clean them), and restarts its own unit. **No sudo prompt ever.**
- The **overlay Bun process** runs as the user. It performs the GitHub check, downloads/verifies/stages the overlay tarball, swaps `~/.local/share/loadout-overlay/`, and restarts the `loadout-overlay` user unit.
- **Security invariant**: the root backend never trusts user-staged files for its own binary. Its `/api/self-update` route accepts only a tag matching `^v\d+\.\d+\.\d+$`, downloads the binary + `SHA256SUMS` itself over HTTPS from the pinned `srsholmes/loadout` repo (redirect host allow-list per `plugins/store-bridge/lib/github-release.ts`), verifies the checksum before the swap, and **rejects tags older than the running version** (no downgrade via the unauthenticated-bootstrap token path).

Verified enablers: `@loadout/exec` command policy only applies inside plugin scopes (`packages/exec/src/index.ts:62`) — the bun main and loader core are unrestricted, so `systemctl`/`tar`/`systemd-run` need no policy changes. All `/api/*` routes are bearer-token-gated automatically (`apps/loadout/src/loader/index.ts:416`); the Bun process bootstraps a token from the loopback-only `/api/token` (`auth.ts:63`). Backend outbound HTTPS is unrestricted (sandboxed-fetch only wraps plugin calls).

## Version detection & comparison

- Canonical installed version: add `version` (from `__LOADOUT_VERSION__`, e.g. `"0.6.0"`, no `v` prefix) to `/api/status` in `apps/loadout/src/loader/routes/health.ts`. Fallback: `OVERLAY_VERSION` (`apps/loadout-overlay/src/overlay/version.ts`).
- Latest release: `GET api.github.com/repos/srsholmes/loadout/releases/latest` (anonymous; 2 calls/session ≪ rate limit). **Guard**: the "rolling" release is NOT marked prerelease/draft (verified live) — if `releases/latest` ever returns a tag failing `^v\d+\.\d+\.\d+$`, fall back to listing `/releases?per_page=20` and picking the highest semver tag.
- Comparison: new shared util in `packages/types/src/version.ts` (`@loadout/types` already ships runtime code used by backend, bun, and webview): `parseVersion` → `[major,minor,patch]|null`, `compareVersions`, `isNewerVersion`. Plain numeric x.y.z compare — release tags never carry prerelease suffixes.
- Dev builds (`"dev"` / `"dev-<hash>"` version): the entire feature disables itself; Settings shows "dev build — updates disabled".

## User-facing flows

**Startup** (`App.tsx` boot effect): after user-config load, ~10 s after boot, call `checkForUpdate`. If newer and `tag !== updateSkippedVersion` config key → `notify("Loadout vX.Y.Z is available — update from Settings")` (toasts are non-actionable by design of `packages/ui/src/notify.ts`). If `updateAppliedTo` config key equals the running version → "Updated to vX.Y.Z" success toast, then clear the key.

**Settings → About** (new `UpdateSection.tsx` rendered in `Settings.tsx` About section, ~line 732): shows overlay + backend versions; "Check for updates" button (ignores skip); when available: "Update now" (two-step confirm, `MaintenanceActionRow` style, copy warns "overlay will close and reopen") and "Skip this version" (`setConfigValue("updateSkippedVersion", tag)` via `overlay/lib/userConfig.ts` → durable `~/.config/loadout/config.json`). Progress bar driven by a new `overlay-update-progress` push channel.

**Apply sequence** (`applyUpdate({tag})` RPC in bun main; in-flight guard; progress via `sendToWebview`):
1. Preflight: `statfs` disk check (~2.5 GB free), fetch backend token.
2. Download overlay tar + `SHA256SUMS` (streamed to disk), verify sha256 (`Bun.CryptoHasher`), extract `tar -xJf --strip-components=1` into `~/.local/share/loadout-overlay.staging`, validate `bin/launcher`. Everything up to here leaves the live install untouched.
3. `POST /api/self-update {tag}` → backend downloads/verifies binary + plugins tar itself, writes binary as sibling `.loadout.new` + `rename(2)` over its running binary (same-fs rename dodges ETXTBSY), `restorecon -F` if present, swaps plugins dirs, then schedules `systemd-run --collect systemctl restart loadout` (~500 ms — transient unit outside its own dying cgroup). Overlay polls `GET /api/self-update` status until `done`.
4. Overlay swaps: `loadout-overlay` → `.old`, `.staging` → live (open mmaps stay valid via inodes). Preserve SteamOS webkit libs if `fetch-deck-overlay-libs.sh` places them inside the overlay tree (verify at implementation time; copy from `.old` if so).
5. Reply success (UI shows "Restarting…"), then `systemd-run --user --collect systemctl --user restart loadout-overlay`. (The post-update toast marker is written by the webview as `updatePendingTag` *before* the update starts; on next boot App.tsx compares it against the running version.)
6. Boot-time cleanup on both sides removes `.staging`/`.new` leftovers and deletes `.old` after the next successful boot (one-generation manual rollback window).

## Files

**Create**
- `packages/types/src/version.ts` + `version.test.ts` — shared semver compare (export from `index.ts`).
- `apps/loadout/src/version.ts` — `LOADER_VERSION`/`LOADER_BUILD_DATE` from defines (also imported by `src/index.ts`, removing duplication).
- `apps/loadout/src/loader/self-update.ts` + `.test.ts` — root-side updater core, DI bag `{fetch, run, rename, statfs, execPath, scheduleRestart}`.
- `apps/loadout/src/loader/routes/self-update.ts` — `POST /api/self-update` (409 when in flight), `GET /api/self-update` (status), `POST /api/restart` (self-restart primitive).
- `apps/loadout-overlay/src/bun/lib/updater.ts` + `.test.ts` — check/download/stage/swap orchestrator, DI fetch/exec.
- `apps/loadout-overlay/src/overlay/components/UpdateSection.tsx` (+ optional `.spec.tsx`).

**Modify**
- `apps/loadout/src/loader/routes/health.ts` — add `version` to `/api/status`.
- `apps/loadout/src/loader/routes/index.ts` — register routes; `loader/index.ts` — boot cleanup call.
- `apps/loadout-overlay/src/bun/rpc-handlers.ts` — `checkForUpdate`/`applyUpdate` handlers; extend `RpcHandlerDeps` with a `sendUpdateProgress` closure (wired in `src/bun/index.ts`).
- `apps/loadout-overlay/src/bun/rpc-validation.ts` — tag/params validators.
- `apps/loadout-overlay/src/bun/system-actions.ts` — **drive-by fix**: `restartServer()` currently runs `systemctl --user restart loadout`, but install.sh installs a root *system* unit — the Settings "Restart plugin server" button is broken on real installs. Repoint it at the new `POST /api/restart`.
- `apps/loadout-overlay/src/overlay/lib/host.ts` — `checkForUpdate`/`applyUpdate`/`getUpdateStatus` wrappers. (Implementation note: progress is exposed via a polled `getUpdateStatus` RPC rather than the originally-planned push channel — fewer moving parts, no new webview-messages typing or electrobun helper needed.)
- `apps/loadout-overlay/src/overlay/components/Settings.tsx` — render `UpdateSection` in About.
- `apps/loadout-overlay/src/overlay/App.tsx` — startup check effect + post-update toast.

## Failure handling

- Download/checksum/rate-limit failure → abort before any swap, staging deleted, error in UpdateSection; live install untouched. Startup-check network errors are silent (`{available:false}`).
- Backend updated but overlay swap fails → minimized by staging the overlay fully *before* the backend POST; Settings then shows version divergence and "Update now" is idempotent (same-version backend update = plain reinstall).
- Concurrent attempts → module-level guard + 409. Crash mid-update → boot cleanup. Update during gameplay → safe (Steam/gamescope untouched), confirm-button copy warns about the overlay bouncing.

## Verification

- Unit tests (CI `bun test test.ts --isolate`): version parse/compare edge cases; self-update tag validation, redirect-host refusal, checksum-mismatch-means-no-swap, binary path branches, status transitions; updater in-flight guard, disk check, ordering (backend POST only after staging verified), progress emission.
- On-device: install v0.5.0 via `LOADOUT_VERSION=v0.5.0 … install.sh`; boot → toast appears; Settings → Update now → progress → auto-restart → `loadout --version`, `/api/status`, and Settings all report latest; plugins refreshed; `.old` present, gone after next boot. Test "Skip this version" (toast silenced across restarts, manual check still reports). Pull network mid-download → clean error, install intact. Exercise both the SteamOS home-dir binary path and the `/usr/local/bin` + restorecon path (Bazzite).
