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
import { RELEASE_TAG_RE, parseVersion, isNewerVersion, versionsEqual } from "@loadout/types";

const REPO = "srsholmes/loadout";

/** Same per-hop allow-list as the loader's self-update downloader
 *  (and plugins/store-bridge/lib/github-release.ts, where the pattern
 *  originates). Kept as a local copy per that module's note — pull
 *  into a shared package if yet another consumer appears. */
const TRUSTED_GITHUB_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

export function isTrustedGithubHost(host: string): boolean {
  const lower = host.toLowerCase();
  return TRUSTED_GITHUB_HOSTS.some((t) => lower === t || lower.endsWith(`.${t}`));
}

/** Free bytes we insist on before starting: tar (~300 MB) + extracted
 *  staging tree (~800 MB) on top of the live copy, with headroom. */
const REQUIRED_FREE_BYTES = 2_500_000_000;

export type UpdatePhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "backend"
  | "swapping"
  | "restarting"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  /** 0-100 coarse overall progress across all phases. */
  pct?: number;
  message?: string;
  tag?: string;
}

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
  now: () => Date.now(),
};

// -- Release check ------------------------------------------------------------

export interface UpdateCheckResult {
  available: boolean;
  /** Release tag, e.g. "v0.7.0". Present whenever a release resolved. */
  tag?: string;
  /** Bare version of `tag`, e.g. "0.7.0". */
  latestVersion?: string;
  error?: string;
}

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
  // clean "check failed" result, not an RPC timeout.
  const signal = AbortSignal.timeout(8000);
  try {
    const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
      signal,
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
    signal,
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
async function fetchPinned(url: string, fetchFn: typeof fetch): Promise<Response> {
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
    res = await fetchFn(currentUrl, { headers: assetHopHeaders(host), redirect: "manual" });
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

async function downloadToFileWithProgress(
  url: string,
  dest: string,
  fetchFn: typeof fetch,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  const res = await fetchPinned(url, fetchFn);
  const total = Number(res.headers.get("content-length") ?? 0);
  const body = res.body;
  if (!body) throw new Error("no response body");
  const writer = Bun.file(dest).writer();
  let downloaded = 0;
  try {
    for await (const chunk of body) {
      // Await the sink so a fast network + slow disk applies
      // backpressure instead of buffering the whole ~300 MB in RAM.
      await writer.write(chunk);
      downloaded += chunk.byteLength;
      onProgress?.(downloaded, total);
    }
  } finally {
    await writer.end();
  }
}

/** "<hex>  <filename>" lines → filename → lowercase hex. */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    const hash = m?.[1];
    const name = m?.[2];
    if (hash && name) out.set(name.trim(), hash.toLowerCase());
  }
  return out;
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
  try {
    const token = await backendToken(deps);
    const { json } = await backendJson<{ version?: string }>(deps, "/api/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return json?.version ?? null;
  } catch {
    return null;
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
      }, 20_000);
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

  // Disk preflight. statfs is available in Bun's node:fs; if that ever
  // regresses we skip the check rather than block updates.
  try {
    const fs = await fsp.statfs(deps.home);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < REQUIRED_FREE_BYTES) {
      throw new Error(`not enough free space: need ~2.5 GB, have ${(free / 1e9).toFixed(1)} GB`);
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
  const sumsRes = await fetchPinned(assetUrl(tag, "SHA256SUMS"), deps.fetchFn);
  const sums = parseSha256Sums(await sumsRes.text());
  const wantSum = sums.get(asset);
  if (!wantSum) throw new Error(`SHA256SUMS for ${tag} has no entry for ${asset}`);

  await rm(tarPath, { force: true });
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
  await rename(overlayDir, oldDir);
  try {
    await rename(stagingDir, overlayDir);
  } catch (err) {
    // Put the old tree back so the unit can still start.
    await rename(oldDir, overlayDir).catch(() => {});
    throw err;
  }
  await rm(tarPath, { force: true }).catch(() => {});
  // `.old` is kept until the next successful boot (see
  // cleanupUpdateArtifacts) as a one-generation manual rollback.
}

/**
 * Poll the backend's self-update status until it lands. The backend
 * marks `done` ~500 ms before restarting itself, so the poll usually
 * sees it — but if the restart wins the race (connection refused, 401
 * from a fresh token generation, or a fresh process reporting `idle`),
 * fall back to reading the NEW process's /api/status version.
 *
 * The fallback only accepts a version match when it's *corroborated*:
 * either we observed the backend actively working this run (`sawActive`)
 * or the reported version differs from the pre-update snapshot. Without
 * that, a same-version repair (backend already at `tag`) would read as
 * done from the first flaky poll and the overlay would swap + restart
 * while the backend was still applying (finding 4).
 */
export async function waitForBackendDone(args: {
  tag: string;
  token: string;
  preVersion: string | null;
  deps: UpdaterDeps;
}): Promise<void> {
  const { tag, token, preVersion, deps } = args;
  const preIsTag = preVersion !== null && versionsEqual(preVersion, tag);
  const deadline = deps.now() + 10 * 60_000;
  let sawActive = false;
  while (deps.now() < deadline) {
    await deps.sleep(1000);
    let phase: string | null = null;
    let message: string | undefined;
    try {
      const { status: httpStatus, json } = await backendJson<{
        phase?: string;
        message?: string;
      }>(deps, "/api/self-update", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (httpStatus === 200 && json?.phase) {
        phase = json.phase;
        message = json.message;
      }
    } catch {
      phase = null; // backend unreachable — possibly mid-restart
    }
    if (phase === "done") return;
    if (phase === "error") {
      throw new Error(`backend update failed: ${message ?? "unknown error"}`);
    }
    if (phase === "downloading" || phase === "verifying" || phase === "applying") {
      sawActive = true;
      status = { phase: "backend", pct: 80, tag, message: "Updating backend…" };
      continue;
    }
    // Unreachable, unauthorized, or a fresh process reporting idle.
    if (phase === null || sawActive) {
      const version = await backendVersion(deps);
      if (!version || !versionsEqual(version, tag)) continue;
      // Corroborate before trusting a bare version match: the version
      // changed to the target, or we watched the backend do the work.
      if (sawActive || !preIsTag) return;
    }
  }
  throw new Error("timed out waiting for the backend update");
}

/**
 * Boot-time cleanup: drop the previous generation (`.old`), any
 * abandoned staging tree, and a leftover tarball. Reaching this after
 * an update IS the "next successful boot", which ends the `.old`
 * rollback window.
 *
 * Restorative first: if a crash between the two swap renames left the
 * live overlay dir MISSING while `.old` still holds the previous tree,
 * put `.old` back rather than deleting it — otherwise we'd erase the
 * only surviving copy and leave the overlay permanently unlaunchable
 * (finding 2, overlay twin).
 */
export async function cleanupUpdateArtifacts(home: string = DEFAULT_DEPS.home): Promise<void> {
  const overlayDir = join(home, ".local", "share", "loadout-overlay");
  const oldDir = `${overlayDir}.old`;
  const liveMissing = !(await stat(overlayDir).catch(() => null));
  const oldExists = !!(await stat(oldDir).catch(() => null));
  if (liveMissing && oldExists) {
    await rename(oldDir, overlayDir).catch(() => {});
  }
  for (const t of [oldDir, `${overlayDir}.staging`, `${overlayDir}.update.tar.xz`]) {
    await rm(t, { recursive: true, force: true }).catch(() => {});
  }
}

/** Test seam — reset the module-level status singleton to idle so
 *  tests don't leak in-flight/terminal state into one another. */
export function resetUpdateStatusForTest(): void {
  status = { phase: "idle" };
}
