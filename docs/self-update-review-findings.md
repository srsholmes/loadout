# Self-update PR review — consolidated findings

## Round 2 (2026-07-23, correctness + tests/UI lenses; failure-modes rerun pending)

Round-1 items were verified implemented (13/15 fully; two had residuals,
fixed below). New findings and dispositions:

- [FIXED] **Heartbeat reap gate forgeable by overlay OPEN** — the freeze
  watchdog seeds `lastHeartbeat` on every show ("assume alive"), so a
  Guide-press on a crash-looping post-update CEF reaped `.old` in the exact
  case it exists for. Now gated on a dedicated `webviewEverAlive` ref set
  only by the `overlayHeartbeat` RPC handler.
- [FIXED] **401→404 test was a second-generation tautology** — the
  version-less /api/status probe masked deletion of both the 401 retry and
  the 404 return. The test now makes /api/status throw (only the
  fresh-token 404 can resolve) and asserts the fresh-token route re-poll.
- [FIXED] **sawRestart corroboration unpinned** — new test: 401 → fresh
  process idle + version match + unknown snapshot must resolve.
- [FIXED] **Loader rollback paths untestable** — `rename`/`copyFile` seams
  added to `SelfUpdateDeps`; both rollback paths (modules-rename failure,
  binary-swap failure) now have failing-without-the-code tests.
- [FIXED] **Backend death mid-apply idled out the 10-min deadline** — a
  restart observed (401) + fresh process reporting the PRE-update version
  now fails fast ("restarted without applying the update").
- [FIXED] **Give-up horizon ~7.5 min vs commented ~40s** — the poll's
  give-up is now time-based (90s since last successful poll), immune to
  how slowly each RPC fails.
- [FIXED] **Startup toast used only OVERLAY_VERSION** — App.tsx now
  compares against the older of backend//overlay versions
  (`olderParseableVersion`, hoisted to @loadout/types), matching Settings.
- [FIXED] **makeIdleAbort untested** — exported + reset/abort/clear test.
- [FIXED] **Checksum-mismatch test didn't pin both-artifacts removal.**
- [ACCEPTED] Power-loss between the completed plugins swap and the binary
  rename commits new-plugins/old-binary and boot cleanup destroys the
  evidence (`.old` pairs). Millisecond window; no swap order eliminates
  it; same-version reinstall repairs it. Documented, not fixed.
- [ACCEPTED] No `UpdateSection.spec.tsx` component test (Settings.tsx is
  also spec-less; the poll state machine is covered indirectly via the
  updater's status tests). Candidate follow-up, not a defect.
- [ACCEPTED] Unit `ExecStartPre` rolls forward (.staging) while bun-side
  cleanup rolls back (.old) — divergence only reachable in unit-less dev
  runs; both outcomes coherent.

# Round 1 — consolidated findings (4-agent review, 2026-07-22)

Status legend: [DONE-HEAD] = already fixed in commits up to ccc3f90 or by the
other active session · [OPEN] = still needs fixing · [WONTFIX] = accepted.

## HIGH

1. [PARTIAL] **401-not-404: pre-feature backend poll hang.** The poll in
   `waitForBackendDone` (apps/loadout-overlay/src/bun/lib/updater.ts) uses the
   pre-restart token; after the backend restarts, the auth gate 401s BEFORE
   route dispatch (loader/index.ts:422, per-process token in auth.ts), so the
   `httpStatus === 404` shortcut is unreachable and the pre-feature fallback
   (`/api/status` has no `version` field pre-feature) returns null forever →
   10-min hang at "Updating backend… 80%". HEAD now retries with a fresh token
   on 401 (good). STILL OPEN on top of that:
   - `preVersion === null` should count as "might already be at tag" (require
     corroboration), not as corroboration (`preIsTag = preVersion === null || …`).
   - Reachable `/api/status` WITHOUT a `version` field ⇒ pre-feature backend ⇒
     treat as done (belt-and-braces beside the fresh-token 404 probe).
   - `sawRestart` (a 401 observed) is itself corroboration for the version match.
   - Deadline should be activity-based (10 min idle, extended while the backend
     reports an active phase; ~60 min absolute cap) — the backend downloads
     ~150 MB inside the current fixed 10-min window (slow links time out, then
     backend finishes anyway → skew).

2. [OPEN] **Overlay mid-swap crash strands the install; in-app repair can never
   run.** Crash between `rename(live→.old)` and `rename(.staging→live)` leaves
   no live tree; `loadout-overlay.service` ExecStart path is gone so the unit
   crash-loops and the bun-side restore (cleanupUpdateArtifacts) never executes.
   FIX: add an ExecStartPre restore to loadout-overlay.service (repo root) AND
   the install.sh heredoc twin:
   `ExecStartPre=-/bin/sh -c 'L=%h/.local/share/loadout-overlay; if [ ! -x "$L/bin/launcher" ]; then if [ -x "$L.staging/bin/launcher" ]; then rm -rf "$L"; mv "$L.staging" "$L"; elif [ -x "$L.old/bin/launcher" ]; then rm -rf "$L"; mv "$L.old" "$L"; fi; fi'`
   (staging preferred: if live is missing the staged tree was already fully
   verified; note self-update never rewrites unit files, ships via reinstall).

3. [OPEN] **The 404 test is a tautology** (updater.test.ts) — passes with the
   404 branch deleted (version fallback masks it: tag v0.6.0 matches default
   statusVersion 0.6.0 with sawActive). Rewrite to model reality: poll → 401,
   fresh-token probe → 404, `/api/status` WITHOUT a version field; plus a test
   that the activity-based deadline extends while phases are active.

## MEDIUM

4. [OPEN] **Backend boot cleanup races plugin loading** — `void
   cleanupStaleSelfUpdateArtifacts(pluginsDir)` in loader/index.ts must be
   `await`ed: after a mid-swap crash the restorative rename can lose to
   `loadPlugins`' readdir (ENOENT → silently boots pluginless).

5. [OPEN] **No rollback copy of the backend binary.** Keep a
   `.loadout.old` copy (copyFile before the rename) so a new binary that
   can't boot leaves an SSH-recoverable copy; reap it in
   cleanupStaleSelfUpdateArtifacts (which only a WORKING new binary runs).
   Related: overlay `.old` is reaped at process start — before CEF has proven
   itself. Split cleanup: boot keeps `.old` (restore+staging/tar sweep only);
   reap `.old` only on the webview's first heartbeat (lastHeartbeat ref in
   bun/index.ts).

6. [OPEN] **Swap order skew (loader/self-update.ts):** binary is renamed
   BEFORE the plugins swap; a plugins failure leaves new-binary/old-plugins
   armed for the next unrelated restart with no error surfaced. Reorder:
   plugins+modules swap first (multi-rename, failure-prone), binary rename
   last (atomic); if the binary swap fails, roll the plugins back too.

7. [OPEN] **Backend `downloadToFile` sends `Authorization` on every hop** —
   with GITHUB_TOKEN set, the S3 hop 400s ("Only one auth mechanism allowed").
   Port the overlay's `assetHopHeaders` (token only on the github.com hop).

8. [OPEN] **No idle-abort on asset downloads (both sides).** A half-open TCP
   connection hangs fetch forever; status pins at `downloading`, every retry
   refused ("already in progress") until service restart. Add a
   per-chunk-reset AbortController watchdog (~60 s no-data → abort), unref'd
   timers; stream the loader download manually instead of `Bun.write(dest, res)`.

## MEDIUM-LOW / LOW

9. [OPEN] Backend has no disk preflight; overlay checks only $HOME. On
   Bazzite the binary staging goes to /usr/local/bin (different fs). Add
   statfs checks (skip when statfs unavailable) for dirname(exePath) (~400 MB)
   and installDir (~1 GB).
10. [OPEN] **Coherent boot restore (loader):** crash between the plugins and
    modules renames → cleanup restores pairs independently → new-plugins/
    old-modules mix. When ANY pair needs restoring, restore EVERY pair that
    still has an `.old` (discarding its half-applied new dir).
11. [OPEN] `restartServer` (system-actions.ts) treats 409 ("update in
    progress") as route-unavailable and falls through to the legacy
    `systemctl --user` path — surface the 409 as an error instead.
12. [OPEN] Shared `AbortSignal.timeout(8000)` across both requests in
    `resolveLatestReleaseTag` — the list fallback starts already-aborted
    exactly when `releases/latest` timed out. Give each request its own signal.
13. [OPEN] UpdateSection.tsx: (a) poll can start after unmount (mount effect's
    async resume + handleUpdate's await) → leaked interval; add an
    unmounted/cancelled guard. (b) give-up path (15 nulls) leaves a frozen
    progress bar — set an error status so the buttons return. (c) overlapping
    getUpdateStatus calls (setInterval doesn't serialize; up to ~40 s of
    in-flight calls with the 30 s RPC window) — add a busy guard; fix the
    "~11s" comment. (d) "Skip this version" button unmounts under controller
    focus — keep it mounted (disabled "Skipped ✓") instead.
14. [OPEN] Tests: "second update in flight" test leaks an unawaited rejection
    into the next test (drain it); routes/self-update.test.ts "downgrade"
    test actually exercises the dev-build guard (relabel); checksum-mismatch
    apply test should assert `startSelfUpdate(...).ok === true`. Missing
    coverage: overlay apply-path harness (happy path + checksum abort),
    cleanupUpdateArtifacts restore/sweep/keepOldGeneration, coherent-restore.
15. [WONTFIX] Backend wait window includes backend download time — covered by
    the activity-based deadline in (1). Visibility race on the post-update
    toast (App.tsx) — low, self-heals. Unsigned SHA256SUMS — inherent to the
    release-trust model, equivalent to curl|sh (add a note to the security
    comment if desired). Non-unit overlay instance + scheduled restart can
    double-start (dev-only shape, watchdog covers absent-unit case).

## Security review: no new HIGH/MEDIUM findings — TOCTOU windows and
/api/restart reachability are status-quo-equivalent to the existing
user-writable-binary/plugins model; redirect pinning, argv-array exec, and
tag validation verified sound.
