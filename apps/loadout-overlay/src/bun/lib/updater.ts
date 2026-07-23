/**
 * Overlay-side updater (issue #173).
 *
 * The Bun host runs as the session user, so it owns the two update
 * steps that don't need root: swapping the user-owned overlay tree at
 * `~/.local/share/loadout-overlay/` and restarting the
 * `loadout-overlay` user unit. The root-only steps (backend binary,
 * plugins tree, `loadout.service` restart) are delegated to the
 * backend's `/api/self-update` route — see
 * apps/loadout/src/loader/self-update.ts for that side's security
 * model. Nothing live is touched until the new overlay tree is fully
 * downloaded, checksum-verified and staged.
 *
 * Sequence for `startUpdate(tag)`:
 *   1. preflight (disk space, resolve backend token)
 *   2. download + SHA256-verify the overlay tarball, extract to
 *      `loadout-overlay.staging`, sanity-check `bin/launcher`
 *   3. carry over the SteamOS webkit closure: `.so` files that
 *      fetch-deck-overlay-libs.sh copied into the live `bin/` at
 *      install time and that the release tar deliberately omits
 *   4. POST /api/self-update {tag} and poll until the backend reports
 *      done (or its post-restart /api/status already shows the target
 *      version — the poll can race the service restart)
 *   5. swap `loadout-overlay` → `.old`, `.staging` → live
 *   6. restart the overlay user unit via a transient systemd-run unit
 *      (a plain child would die with our own cgroup mid-restart)
 *
 * The webview polls `getUpdateStatus()` over RPC to render progress —
 * no push channel needed.
 */

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runFull, spawn } from "@loadout/exec";
import {
  RELEASE_TAG_RE,
  parseVersion,
  isNewerVersion,
  versionsEqual,
  isTrustedGithubHost,
  parseSha256Sums,
  makeIdleAbort,
  type UpdateStatus,
  type UpdateCheckResult,
} from "@loadout/types";

// Status/result shapes live in @loadout/types (both sides of the
// Electrobun RPC boundary consume them); re-exported so callers of
// this module keep a single import site.
export type { UpdateStatus, UpdateCheckResult };

const REPO = "srsholmes/loadout";

/** Free bytes we insist on before starting. Real single-filesystem
 *  peak is ~1.7 GB (tar ~300 MB + extracted staging ~800 MB incl. the
 *  carried webkit closure, plus the backend's ~400 MB of binary/plugins
 *  artifacts on the same fs on SteamOS — the .old swaps are renames,
 *  zero extra bytes). 2 GB leaves headroom without refusing near-full
 *  64 GB eMMC Decks an update that actually fits. */
const REQUIRED_FREE_BYTES = 2_000_000_000;

let status: UpdateStatus = { phase: "idle" };

export function getUpdateStatus(): UpdateStatus {
  return status;
}

function updateInFlight(): boolean {
  return status.phase !== "idle" && status.phase !== "error";
}

export interface UpdaterDeps {
  fetchFn: typeof fetch;
  run: (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  home: string;
  backendBase: string;
  scheduleOverlayRestart: () => void;
  sha256File: (path: string) => Promise<string>;
  /** Injectable clock — real timers in production, simulated in tests
   *  so the multi-minute backend-restart poll is exercisable. */
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** rename(2) seam — real `node:fs/promises` in production; injected
   *  in tests so the overlay-tree swap + its rollback can be exercised
   *  (make `staging→live` fail and assert `.old` is restored). */
  rename: (from: string, to: string) => Promise<void>;
}

async function defaultSha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

function defaultScheduleOverlayRestart(): void {
  // Delay so the RPC response + one last status poll reach the webview
  // before CEF goes down with us.
  setTimeout(() => {
    try {
      spawn(
        ["systemd-run", "--user", "--collect", "systemctl", "--user", "restart", "loadout-overlay"],
        { stdout: "ignore", stderr: "ignore" },
      );
    } catch (err) {
      console.error("[updater] failed to schedule overlay restart:", err);
    }
  }, 1200);
}

export const DEFAULT_DEPS: UpdaterDeps = {
  fetchFn: fetch,
  run: runFull,
  home: homedir(),
  backendBase: `http://127.0.0.1:${process.env.LOADOUT_PORT || 33820}`,
  scheduleOverlayRestart: defaultScheduleOverlayRestart,
  sha256File: defaultSha256File,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  // Monotonic (CLOCK_MONOTONIC excludes suspend on Linux): the 10/60
  // minute budgets in waitForBackendDone should count RUNNING time —
  // with Date.now(), closing the lid for an hour mid-update burned the
  // whole absolute cap and produced a spurious "timed out" on resume
  // while the backend finished anyway (skew).
  now: () => performance.now(),
  rename,
};

// -- Release check ------------------------------------------------------------

/**
 * Resolve the newest published release tag. `releases/latest` is the
 * fast path, but the repo also carries a "rolling" release that is
 * NOT marked prerelease — if GitHub ever hands that (or anything else
 * non-`vX.Y.Z`) back as "latest", fall back to listing releases and
 * picking the highest semver tag ourselves.
 */
export async function resolveLatestReleaseTag(fetchFn: typeof fetch): Promise<string | null> {
  const headers: Record<string, string> = {
    "User-Agent": "Loadout-Updater",
    Accept: "application/vnd.github+json",
  };
  // api.github.com honours the token to lift the 60 req/hr anonymous
  // limit — on CGNAT / shared-IP handhelds the every-boot auto-check
  // would otherwise 403 persistently. (Unlike the asset downloads, the
  // API host never redirects to S3, so there's no cross-auth hazard.)
  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Bounded so the checkForUpdate RPC always answers well inside the
  // webview's request window — a dead network should surface as a
  // clean "check failed" result, not an RPC timeout. Each request gets
  // its OWN signal: a shared one would arrive at the list fallback
  // already aborted precisely when `releases/latest` was what timed
  // out — the one case the fallback exists for.
  try {
    const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const json = (await res.json()) as { tag_name?: string };
      if (json.tag_name && RELEASE_TAG_RE.test(json.tag_name)) return json.tag_name;
    }
  } catch {
    // fall through to the list endpoint
  }
  const listRes = await fetchFn(`https://api.github.com/repos/${REPO}/releases?per_page=20`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!listRes.ok) return null;
  const list = (await listRes.json()) as Array<{
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
  }>;
  let best: string | null = null;
  for (const rel of list) {
    if (rel.draft || rel.prerelease) continue;
    const tag = rel.tag_name ?? "";
    if (!RELEASE_TAG_RE.test(tag)) continue;
    if (!best || isNewerVersion(tag, best)) best = tag;
  }
  return best;
}

export async function checkForUpdate(
  installedVersion: string,
  deps: UpdaterDeps = DEFAULT_DEPS,
): Promise<UpdateCheckResult> {
  if (!parseVersion(installedVersion)) {
    return { available: false, error: "updates are disabled on dev builds" };
  }
  try {
    const tag = await resolveLatestReleaseTag(deps.fetchFn);
    if (!tag) return { available: false, error: "no published release found" };
    return {
      available: isNewerVersion(tag, installedVersion),
      tag,
      latestVersion: tag.slice(1),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: `update check failed: ${message}` };
  }
}

// -- Download helpers ----------------------------------------------------------

function assetUrl(tag: string, asset: string): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
}

/** Per-hop request headers for an asset download. The `Authorization`
 *  token is attached ONLY on the initial `github.com` hop: release
 *  assets 302 to a pre-signed `objects.githubusercontent.com` (S3) URL
 *  that carries its own `X-Amz-*` query auth, and S3 rejects a request
 *  bearing both query-signing AND an `Authorization` header with HTTP
 *  400 "Only one auth mechanism allowed". Normal `fetch` strips auth
 *  cross-origin; our manual redirect walk must do it deliberately. The
 *  repo is public, so the token buys nothing on the asset anyway. */
function assetHopHeaders(host: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "Loadout-Updater" };
  const token = process.env.GITHUB_TOKEN;
  if (token && host === "github.com") headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** Walk redirects manually, re-pinning the host on every hop, and
 *  return the terminal OK response. */
async function fetchPinned(
  url: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  const MAX_HOPS = 10;
  let currentUrl = url;
  let res: Response | null = null;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let host = "";
    try {
      host = new URL(currentUrl).hostname;
    } catch {
      // handled by the refusal below
    }
    if (!host || !isTrustedGithubHost(host)) {
      throw new Error(
        `download refused: hop ${hop} pointed at untrusted host ${host || currentUrl}`,
      );
    }
    res = await fetchFn(currentUrl, {
      headers: assetHopHeaders(host),
      redirect: "manual",
      signal,
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`HTTP ${res.status} without a Location header`);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    break;
  }
  if (!res) throw new Error(`no response after ${MAX_HOPS} redirect hops`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

/** How long a download may go without receiving a single byte before
 *  the makeIdleAbort watchdog (from @loadout/types) kills it. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

async function downloadToFileWithProgress(
  url: string,
  dest: string,
  fetchFn: typeof fetch,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  const idle = makeIdleAbort(DOWNLOAD_IDLE_TIMEOUT_MS);
  try {
    const res = await fetchPinned(url, fetchFn, idle.signal);
    const total = Number(res.headers.get("content-length") ?? 0);
    const body = res.body;
    if (!body) throw new Error("no response body");
    const writer = Bun.file(dest).writer();
    let downloaded = 0;
    try {
      for await (const chunk of body) {
        idle.reset();
        // Await the sink so a fast network + slow disk applies
        // backpressure instead of buffering the whole ~300 MB in RAM.
        await writer.write(chunk);
        downloaded += chunk.byteLength;
        onProgress?.(downloaded, total);
      }
    } finally {
      await writer.end();
    }
  } finally {
    idle.clear();
  }
}

// -- Apply ---------------------------------------------------------------------

async function backendJson<T>(
  deps: UpdaterDeps,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; json: T | null }> {
  // Loopback calls answer in ms when the backend is up; a hung socket
  // (backend mid-restart) should fail fast so the poll loop's own
  // retry/fallback logic runs instead of blocking on one request.
  const res = await deps.fetchFn(`${deps.backendBase}${path}`, {
    signal: AbortSignal.timeout(5000),
    ...init,
  });
  const json = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, json };
}

async function backendToken(deps: UpdaterDeps): Promise<string> {
  const { json } = await backendJson<{ token?: string }>(deps, "/api/token");
  if (!json?.token) throw new Error("could not obtain a backend session token");
  return json.token;
}

/** Read the backend's reported version, bootstrapping a fresh token
 *  (the pre-restart token dies with the old process). Null when the
 *  backend is unreachable. */
async function backendVersion(deps: UpdaterDeps): Promise<string | null> {
  return (await backendStatusProbe(deps)).version;
}

/**
 * Probe `/api/status` with a freshly bootstrapped token. Distinguishes
 * "backend unreachable" from "backend reachable but reporting no
 * version field" — the latter identifies a PRE-FEATURE backend (the
 * `version` field ships with this feature), which the post-restart
 * fallback in {@link waitForBackendDone} treats as its done signal.
 */
async function backendStatusProbe(
  deps: UpdaterDeps,
): Promise<{ reachable: boolean; version: string | null }> {
  try {
    const token = await backendToken(deps);
    const { status: httpStatus, json } = await backendJson<{ ok?: boolean; version?: string }>(
      deps,
      "/api/status",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (httpStatus !== 200 || !json) return { reachable: false, version: null };
    return { reachable: true, version: typeof json.version === "string" ? json.version : null };
  } catch {
    return { reachable: false, version: null };
  }
}

/**
 * Kick off the full update. Returns synchronously with whether the
 * update was ACCEPTED (guard + tag validation); progress is then
 * observable via getUpdateStatus(). Terminal phases: "restarting"
 * (success — the overlay is about to bounce) and "error".
 */
export function startUpdate(
  tag: string,
  deps: UpdaterDeps = DEFAULT_DEPS,
): { success: boolean; error?: string } {
  if (updateInFlight()) return { success: false, error: "update already in progress" };
  if (!RELEASE_TAG_RE.test(tag)) {
    return { success: false, error: `invalid release tag "${tag}"` };
  }
  status = { phase: "downloading", pct: 0, tag, message: "Preparing…" };
  void runUpdate(tag, deps).then(
    () => {
      status = {
        phase: "restarting",
        pct: 100,
        tag,
        message: "Restarting overlay…",
      };
      deps.scheduleOverlayRestart();
      // Watchdog: scheduleOverlayRestart fire-and-forgets `systemd-run`,
      // which silently no-ops if the unit/binary is absent (dev runs,
      // an install without the user unit). Without this the process
      // lives on pinned at "restarting" forever — every future update
      // is refused as "already in progress" and the UI spins on
      // "Restarting overlay…". Flip to error if we're still here after
      // the restart should have happened. Unref'd so it never keeps the
      // process (or a test) alive on its own.
      const watchdog = setTimeout(() => {
        if (status.phase === "restarting" && status.tag === tag) {
          status = {
            phase: "error",
            tag,
            message:
              "the overlay did not restart automatically — restart it manually to finish updating",
          };
        }
        // 30s, not 20s: a legitimate CEF stop→start ladder can run
        // ~15s, and false-firing this moments before systemd finishes
        // would surface an error the successful restart then contradicts.
      }, 30_000);
      (watchdog as { unref?: () => void }).unref?.();
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      status = { phase: "error", tag, message };
      console.error("[updater] update failed:", message);
    },
  );
  return { success: true };
}

async function runUpdate(tag: string, deps: UpdaterDeps): Promise<void> {
  const overlayDir = join(deps.home, ".local", "share", "loadout-overlay");
  const stagingDir = `${overlayDir}.staging`;
  const oldDir = `${overlayDir}.old`;
  const tarPath = `${overlayDir}.update.tar.xz`;
  const asset = "loadout-overlay-x86_64.tar.xz";

  if (process.arch !== "x64") {
    throw new Error(`no release assets for arch ${process.arch}`);
  }
  await stat(join(overlayDir, "bin")).catch(() => {
    throw new Error(`no installed overlay tree at ${overlayDir}`);
  });

  // Sweep a PREVIOUS attempt's leftovers BEFORE the disk preflight —
  // they only get reaped at overlay-unit restart otherwise, and a
  // failed attempt leaves ~1.1 GB of staging + tarball on disk. With
  // the sweep after the statfs, a Deck that barely passed attempt 1
  // would be refused every retry for space the retry itself reclaims.
  await rm(tarPath, { force: true }).catch(() => {});
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});

  // Disk preflight. statfs is available in Bun's node:fs; if that ever
  // regresses we skip the check rather than block updates.
  try {
    const fs = await fsp.statfs(deps.home);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < REQUIRED_FREE_BYTES) {
      throw new Error(`not enough free space: need ~2 GB, have ${(free / 1e9).toFixed(1)} GB`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("not enough free space")) {
      throw err;
    }
  }

  // Token up-front: fail before the 300 MB download if the backend is
  // down (its route does the root half — no point proceeding without it).
  const token = await backendToken(deps);

  // --- Download + verify the overlay tree (live install untouched) ---------
  status = { phase: "downloading", pct: 1, tag, message: "Downloading overlay…" };
  const sumsRes = await fetchPinned(
    assetUrl(tag, "SHA256SUMS"),
    deps.fetchFn,
    AbortSignal.timeout(30_000),
  );
  const sums = parseSha256Sums(await sumsRes.text());
  const wantSum = sums.get(asset);
  if (!wantSum) throw new Error(`SHA256SUMS for ${tag} has no entry for ${asset}`);

  await downloadToFileWithProgress(
    assetUrl(tag, asset),
    tarPath,
    deps.fetchFn,
    (downloaded, total) => {
      const frac = total > 0 ? downloaded / total : 0;
      status = {
        phase: "downloading",
        pct: Math.min(60, Math.round(frac * 60)),
        tag,
        message: `Downloading overlay… ${Math.round(downloaded / 1e6)} MB`,
      };
    },
  );

  status = { phase: "verifying", pct: 62, tag, message: "Verifying download…" };
  const gotSum = await deps.sha256File(tarPath);
  if (gotSum !== wantSum) {
    await rm(tarPath, { force: true });
    throw new Error(`checksum mismatch for ${asset}`);
  }

  status = { phase: "verifying", pct: 66, tag, message: "Extracting…" };
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  // Tar has a top-level loadout-overlay-dev/ dir; strip it so the
  // launcher lands at bin/launcher (same as install.sh).
  const untar = await deps.run(["tar", "-xJf", tarPath, "-C", stagingDir, "--strip-components=1"]);
  if (untar.exitCode !== 0) {
    throw new Error(`extract failed: ${untar.stderr.trim() || untar.exitCode}`);
  }
  const launcher = join(stagingDir, "bin", "launcher");
  const launcherStat = await stat(launcher).catch(() => null);
  if (!launcherStat || !(launcherStat.mode & 0o111)) {
    throw new Error("staged overlay tree has no executable bin/launcher");
  }

  // Carry over the SteamOS webkit closure: install.sh runs
  // fetch-deck-overlay-libs.sh which drops ~100 MB of `.so` files into
  // the live bin/ (the release tar omits them on purpose). No manifest
  // is left behind, so "old .so files missing from the new tree" is
  // the closure by construction — Electrobun's own bundled libs are in
  // the tar and thus never overcopied.
  const liveBin = join(overlayDir, "bin");
  const stagedBin = join(stagingDir, "bin");
  const stagedEntries = new Set(await readdir(stagedBin));
  const soToCarry = (await readdir(liveBin)).filter(
    (name) => /\.so(\.|$)/.test(name) && !stagedEntries.has(name),
  );
  if (soToCarry.length > 0) {
    // cp -a keeps symlinks as symlinks (the closure uses soname links).
    const cp = await deps.run([
      "cp",
      "-a",
      ...soToCarry.map((name) => join(liveBin, name)),
      stagedBin,
    ]);
    if (cp.exitCode !== 0) {
      throw new Error(`failed to carry over runtime libs: ${cp.stderr.trim()}`);
    }
  }

  // Sentinel: the staged tree is now COMPLETE (extracted, launcher
  // validated, webkit closure carried). The unit's ExecStartPre crash
  // recovery only promotes a staging dir bearing this marker — an
  // executable launcher alone can exist in a half-written tree (crash
  // mid-tar after bin/launcher extracted, or mid-carryover).
  await fsp.writeFile(join(stagingDir, ".verified"), "");

  // --- Root half: backend binary + plugins, via the loader ------------------
  status = { phase: "backend", pct: 75, tag, message: "Updating backend…" };
  // Snapshot the backend version BEFORE the update so the poll's
  // version-match fallback can tell "already landed" from "was already
  // here" — the same-version repair flow (backend already at `tag`)
  // would otherwise read as done from tick one (finding 4).
  const preVersion = await backendVersion(deps);
  const post = await backendJson<{ error?: string }>(deps, "/api/self-update", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tag }),
  });
  if (post.status !== 202) {
    throw new Error(post.json?.error ?? `backend refused the update (HTTP ${post.status})`);
  }
  await waitForBackendDone({ tag, token, preVersion, deps });

  // --- Swap the overlay tree -------------------------------------------------
  status = { phase: "swapping", pct: 92, tag, message: "Installing overlay…" };
  await rm(oldDir, { recursive: true, force: true });
  await deps.rename(overlayDir, oldDir);
  try {
    await deps.rename(stagingDir, overlayDir);
  } catch (err) {
    // Put the old tree back so the unit can still start.
    await deps.rename(oldDir, overlayDir).catch(() => {});
    throw err;
  }
  // The sentinel did its job (it must survive INTO the swap so the
  // crash window between the two renames stays covered); don't leave
  // it littering the live tree.
  await rm(join(overlayDir, ".verified"), { force: true }).catch(() => {});
  await rm(tarPath, { force: true }).catch(() => {});
  // `.old` is kept until the next successful boot (see
  // cleanupUpdateArtifacts) as a one-generation manual rollback.
}

/**
 * Poll the backend's self-update status until it lands. The backend
 * marks `done` ~500 ms before restarting itself, so the poll usually
 * sees it — but if the restart wins the race, fall back to the new
 * process's identity.
 *
 * Session tokens are per-process (minted at boot), so after the
 * backend restarts our pre-update token is stale and the auth gate
 * answers 401 *before* route dispatch. We re-bootstrap a fresh token
 * via the public `/api/token` and retry — this is what makes both
 * fallbacks reachable across a restart:
 *   - a fresh-token GET that 404s means the new backend has no
 *     self-update route (updated onto a build predating this feature)
 *     but is up and serving → the update landed (POST was already
 *     accepted 202); don't hang waiting for a "done" it can't report.
 *   - otherwise the version fallback confirms the new process reports
 *     the target version.
 *
 * The version fallback only accepts a match when *corroborated* —
 * `sawActive` (we watched the backend work), `sawRestart` (our token
 * went stale, which only a restart causes, and the backend restarts
 * only after marking `done`), or the version changed from the
 * pre-update snapshot — so a same-version repair can't read as done
 * from the first flaky poll (finding 4). An UNKNOWN snapshot counts as
 * "might already be at the target" and therefore also demands
 * corroboration.
 *
 * The deadline is activity-based: 10 minutes with no sign of life,
 * extended while the backend reports an active phase — it downloads
 * ~150 MB inside this window, and a fixed deadline would cut off slow
 * links mid-download (the backend would then finish and restart anyway,
 * leaving overlay/backend skew after we'd already reported failure). A
 * 60-minute absolute cap still bounds the whole wait.
 */
export async function waitForBackendDone(args: {
  tag: string;
  token: string;
  preVersion: string | null;
  deps: UpdaterDeps;
}): Promise<void> {
  const { tag, token, preVersion, deps } = args;
  const preIsTag = preVersion === null || versionsEqual(preVersion, tag);
  const IDLE_LIMIT_MS = 10 * 60_000;
  const ABSOLUTE_LIMIT_MS = 60 * 60_000;
  const startedAt = deps.now();
  let lastActivity = startedAt;
  let sawActive = false;
  let sawRestart = false;
  let currentToken = token;
  while (
    deps.now() - lastActivity < IDLE_LIMIT_MS &&
    deps.now() - startedAt < ABSOLUTE_LIMIT_MS
  ) {
    await deps.sleep(1000);
    let phase: string | null = null;
    let message: string | undefined;
    let httpStatus = 0;
    try {
      let res = await backendJson<{ phase?: string; message?: string }>(deps, "/api/self-update", {
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      // 401 → the backend restarted and minted a new token. Re-bootstrap
      // and retry so we observe the NEW process (and so a route-absent
      // pre-feature backend reaches dispatch and 404s instead of being
      // masked by the auth gate).
      if (res.status === 401) {
        sawRestart = true;
        const fresh = await backendToken(deps).catch(() => null);
        if (fresh) {
          currentToken = fresh;
          res = await backendJson<{ phase?: string; message?: string }>(deps, "/api/self-update", {
            headers: { Authorization: `Bearer ${currentToken}` },
          });
        }
      }
      httpStatus = res.status;
      if (res.status === 200 && res.json?.phase) {
        phase = res.json.phase;
        message = res.json.message;
      }
    } catch {
      phase = null; // backend unreachable — possibly mid-restart
    }
    // Fresh-token 404: the restarted backend is up but has no
    // self-update route (predates this feature). The POST already ran,
    // so the update landed. A backend that still has the route answers
    // 200, so this can't mask a genuinely in-flight update.
    if (httpStatus === 404) return;
    if (phase === "done") return;
    if (phase === "error") {
      throw new Error(`backend update failed: ${message ?? "unknown error"}`);
    }
    if (phase === "downloading" || phase === "verifying" || phase === "applying") {
      sawActive = true;
      lastActivity = deps.now();
      status = { phase: "backend", pct: 80, tag, message: "Updating backend…" };
      continue;
    }
    // Unreachable, unauthorized, or a fresh process reporting idle.
    if (phase === null || sawRestart || sawActive) {
      const probe = await backendStatusProbe(deps);
      if (!probe.reachable) continue;
      if (probe.version === null) {
        // Reachable /api/status WITHOUT a version field ⇒ a backend
        // predating this feature (the field ships with it). It can only
        // be answering here after a restart — a pre-feature process
        // could never have accepted our POST — so the apply completed.
        // Belt-and-braces beside the fresh-token 404 above, for when
        // that re-poll races the restart and misses.
        return;
      }
      if (!versionsEqual(probe.version, tag)) {
        // Restart observed (stale token) but the new process still
        // reports the PRE-update version: the service died mid-apply
        // (crash, OOM, manual restart) and systemd relaunched the old
        // binary. Nothing will ever report done — fail now instead of
        // idling out the 10-minute deadline.
        if (sawRestart && preVersion !== null && versionsEqual(probe.version, preVersion)) {
          throw new Error(
            "backend update failed: the service restarted without applying the update",
          );
        }
        continue;
      }
      // Corroborate before trusting a bare version match: the version
      // changed to the target, we watched the backend do the work, or
      // we observed the restart that only follows a completed apply.
      if (sawActive || sawRestart || !preIsTag) return;
    }
  }
  throw new Error("timed out waiting for the backend update");
}

/**
 * Boot-time cleanup: reap an abandoned staging tree and leftover
 * tarball, and — unless `keepOldGeneration` — the previous generation
 * `.old` dir too.
 *
 * Restorative first: if a crash between the two swap renames left the
 * live overlay dir MISSING while `.old` still holds the previous tree,
 * put `.old` back rather than deleting it — otherwise we'd erase the
 * only surviving copy and leave the overlay permanently unlaunchable
 * (finding 2, overlay twin). The unit's ExecStartPre carries a mirror
 * of this restore for the case where the bun host itself can't start
 * because the live tree is gone.
 *
 * `keepOldGeneration` exists because "the bun process started" is NOT
 * proof the new overlay works — CEF can still crash after this runs.
 * The boot path passes it and defers the `.old` reap to
 * {@link reapOldGeneration}, which the orchestrator calls only once
 * the webview's first heartbeat arrives (a rendering webview = a
 * genuinely working overlay). That heartbeat is the real end of the
 * one-generation rollback window; if the new overlay never becomes
 * healthy, `.old` survives as the recovery copy.
 */
export async function cleanupUpdateArtifacts(
  opts: { home?: string; keepOldGeneration?: boolean } = {},
): Promise<void> {
  const home = opts.home ?? DEFAULT_DEPS.home;
  const overlayDir = join(home, ".local", "share", "loadout-overlay");
  const oldDir = `${overlayDir}.old`;
  const liveMissing = !(await stat(overlayDir).catch(() => null));
  const oldExists = !!(await stat(oldDir).catch(() => null));
  if (liveMissing && oldExists) {
    await rename(oldDir, overlayDir).catch(() => {});
  }
  const targets = [`${overlayDir}.staging`, `${overlayDir}.update.tar.xz`];
  if (!opts.keepOldGeneration) targets.push(oldDir);
  for (const t of targets) {
    await rm(t, { recursive: true, force: true }).catch(() => {});
  }
}

/** Drop the `.old` rollback generation — called once the new overlay
 *  has PROVEN itself (first webview heartbeat), not merely started. */
export async function reapOldGeneration(opts: { home?: string } = {}): Promise<void> {
  const home = opts.home ?? DEFAULT_DEPS.home;
  const oldDir = `${join(home, ".local", "share", "loadout-overlay")}.old`;
  await rm(oldDir, { recursive: true, force: true }).catch(() => {});
}

/** Test seam — reset the module-level status singleton to idle so
 *  tests don't leak in-flight/terminal state into one another. */
export function resetUpdateStatusForTest(): void {
  status = { phase: "idle" };
}
