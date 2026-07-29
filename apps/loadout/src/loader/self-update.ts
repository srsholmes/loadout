/**
 * Root-side self-update (issue #173).
 *
 * The loader runs as root (`/etc/systemd/system/loadout.service`), so
 * it is the only process that can replace its own binary on non-SteamOS
 * installs (`/usr/local/bin/loadout`, SELinux-labelled) and clean the
 * root-owned `.cache/` dirs it writes under the user's plugins tree.
 * This module downloads a pinned release's backend binary + plugins
 * archive, verifies them against the release's SHA256SUMS, swaps them
 * in, and restarts its own service. The overlay tree is NOT handled
 * here — the overlay's Bun host swaps that user-owned dir itself (see
 * apps/loadout-overlay/src/bun/lib/updater.ts).
 *
 * Security model: `/api/token` is an unauthenticated loopback
 * bootstrap, so any local user process can obtain a token and reach
 * `/api/self-update`. Therefore this endpoint:
 *   - accepts ONLY a release tag matching `vX.Y.Z` — never file paths;
 *   - downloads every artifact itself over HTTPS from the pinned
 *     OWNER/REPO, re-validating the hostname on every redirect hop;
 *   - verifies SHA256SUMS before any swap;
 *   - refuses downgrades, so a local caller can't roll the root
 *     service back to a release with known-exploitable bugs;
 *   - refuses to run at all on dev builds (version "dev"), which also
 *     guards against a `bun run` dev loop resolving /proc/self/exe to
 *     the bun interpreter and clobbering it.
 */

import { chmod, copyFile, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runFull, commandExists, spawn } from "@loadout/exec";
import {
  RELEASE_TAG_RE,
  parseVersion,
  compareVersions,
  isTrustedGithubHost,
  parseSha256Sums,
  makeIdleAbort,
} from "@loadout/types";
import { LOADER_VERSION } from "../version";
import { getTargetUser } from "./target-user";
import { log } from "./logger";

const REPO = "srsholmes/loadout";

export type SelfUpdatePhase = "idle" | "downloading" | "verifying" | "applying" | "done" | "error";

export interface SelfUpdateStatus {
  phase: SelfUpdatePhase;
  tag?: string;
  message?: string;
}

let status: SelfUpdateStatus = { phase: "idle" };

export function getSelfUpdateStatus(): SelfUpdateStatus {
  return status;
}

/** Test seam — reset the module-level status singleton to idle so
 *  tests don't leak in-flight/terminal state into one another. */
export function resetSelfUpdateStatusForTest(): void {
  status = { phase: "idle" };
}

function inFlight(): boolean {
  return (
    status.phase === "downloading" || status.phase === "verifying" || status.phase === "applying"
  );
}

/** True while a self-update is mid-flight. Exported so `/api/restart`
 *  refuses to restart the service in the middle of a binary/plugins
 *  swap — a restart there can SIGTERM the apply between renames and
 *  strand the install (finding 2). */
export function isSelfUpdateInFlight(): boolean {
  return inFlight();
}

/** Injected side effects so the flow is unit-testable without a real
 *  GitHub, filesystem or systemd. Production callers use DEFAULT_DEPS. */
export interface SelfUpdateDeps {
  fetchFn: typeof fetch;
  run: (argv: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Resolve the running binary's on-disk path (SteamOS home-dir
   *  install vs /usr/local/bin — /proc/self/exe answers both). */
  resolveExePath: () => string;
  currentVersion: string;
  /** Fire the deferred `systemctl restart loadout` via a transient
   *  unit OUTSIDE our own cgroup (a plain child would be SIGTERM'd
   *  mid-restart along with us). */
  scheduleRestart: () => void;
  sha256File: (path: string) => Promise<string>;
  /** Whether a binary is on PATH (gates the optional `restorecon`). */
  commandExists: (name: string) => Promise<boolean>;
  /** rename(2)/copyFile seams — real `node:fs/promises` in production;
   *  injected in tests so the multi-rename swap sequences and BOTH
   *  rollback paths (modules-rename failure, binary-swap failure) can
   *  be exercised by making a specific call throw. Same seam the
   *  overlay updater grew for its rollback test. */
  rename: (from: string, to: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
}

async function defaultSha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

function defaultScheduleRestart(): void {
  setTimeout(() => {
    try {
      spawn(["systemd-run", "--collect", "systemctl", "restart", "loadout"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch (err) {
      log.error(`[self-update] failed to schedule service restart: ${err}`);
    }
  }, 500);
}

export const DEFAULT_DEPS: SelfUpdateDeps = {
  fetchFn: fetch,
  run: runFull,
  resolveExePath: () => readlinkSync("/proc/self/exe"),
  currentVersion: LOADER_VERSION,
  scheduleRestart: defaultScheduleRestart,
  sha256File: defaultSha256File,
  commandExists,
  rename,
  copyFile,
};

/**
 * Download `url` to `dest`, walking redirects manually and re-pinning
 * the hostname on every hop. Streams to disk — the plugins archive is
 * tens of MB and buffering it in RAM buys nothing.
 */
/** Per-hop request headers. The `Authorization` token is attached ONLY
 *  on the initial `github.com` hop: release assets 302 to a pre-signed
 *  S3 URL carrying its own `X-Amz-*` query auth, and S3 rejects a
 *  request bearing both with HTTP 400 "Only one auth mechanism allowed"
 *  — so with GITHUB_TOKEN in the service env every download would 400 on
 *  the redirect. Mirrors the overlay updater's `assetHopHeaders`. The
 *  repo is public, so the token buys nothing on the asset anyway. */
function assetHopHeaders(host: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "Loadout-Updater" };
  const token = process.env.GITHUB_TOKEN;
  if (token && host === "github.com") headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** How long a download may go without a single received byte before
 *  the makeIdleAbort watchdog (from @loadout/types) kills it — a
 *  half-open TCP connection would otherwise hang `fetch` forever,
 *  pinning the status at `downloading` where every new POST is
 *  refused with 409 until the service restarts. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

export async function downloadToFile(
  url: string,
  dest: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const idle = makeIdleAbort(DOWNLOAD_IDLE_TIMEOUT_MS);
  try {
    const MAX_HOPS = 10;
    let currentUrl = url;
    let res: Response | null = null;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      let host = "";
      try {
        host = new URL(currentUrl).hostname;
      } catch {
        // fall through to the refusal below
      }
      if (!host || !isTrustedGithubHost(host)) {
        throw new Error(
          `download refused: hop ${hop} pointed at untrusted host ${host || currentUrl}`,
        );
      }
      res = await fetchFn(currentUrl, {
        headers: assetHopHeaders(host),
        redirect: "manual",
        signal: idle.signal,
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
    await mkdir(dirname(dest), { recursive: true });
    // Stream chunk-by-chunk (not Bun.write(dest, res)) so the idle
    // watchdog can observe per-chunk progress and cut a stalled body.
    const body = res.body;
    if (!body) throw new Error("no response body");
    const writer = Bun.file(dest).writer();
    try {
      for await (const chunk of body) {
        idle.reset();
        await writer.write(chunk);
      }
    } finally {
      await writer.end();
    }
  } finally {
    idle.clear();
  }
}

function assetUrl(tag: string, asset: string): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
}

export interface StartSelfUpdateArgs {
  tag: string;
  pluginsDir: string;
}

/**
 * Validate + kick off a self-update. Returns synchronously with
 * whether the update was ACCEPTED; the download/verify/apply flow then
 * runs in the background and is observable via getSelfUpdateStatus().
 */
export function startSelfUpdate(
  args: StartSelfUpdateArgs,
  deps: SelfUpdateDeps = DEFAULT_DEPS,
): { ok: boolean; error?: string; code?: number } {
  const { tag, pluginsDir } = args;
  if (inFlight()) return { ok: false, error: "update already in progress", code: 409 };
  if (!RELEASE_TAG_RE.test(tag)) {
    return { ok: false, error: `invalid release tag "${tag}"`, code: 400 };
  }
  const current = parseVersion(deps.currentVersion);
  if (!current) {
    return { ok: false, error: "self-update is disabled on dev builds", code: 400 };
  }
  const target = parseVersion(tag);
  if (!target || compareVersions(target, current) === -1) {
    // Same-version is allowed (idempotent reinstall after a partial
    // apply); downgrades are not — see the security note up top.
    return {
      ok: false,
      error: `refusing downgrade from ${deps.currentVersion} to ${tag}`,
      code: 400,
    };
  }
  if (process.arch !== "x64") {
    return { ok: false, error: `no release assets for arch ${process.arch}`, code: 400 };
  }

  let exePath: string;
  try {
    exePath = deps.resolveExePath();
  } catch (err) {
    return { ok: false, error: `cannot resolve own binary path: ${err}`, code: 500 };
  }
  // Belt-and-braces against a dev run that slipped past the version
  // gate: never treat the bun interpreter as "our binary".
  if (basename(exePath) === "bun") {
    return { ok: false, error: "running under bun — refusing to self-replace", code: 400 };
  }

  status = { phase: "downloading", tag };
  void runSelfUpdate({ tag, pluginsDir, exePath }, deps).then(
    () => {
      status = { phase: "done", tag };
      log.info(`[self-update] ${tag} applied — restarting loadout.service`);
      deps.scheduleRestart();
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      status = { phase: "error", tag, message };
      log.error(`[self-update] failed: ${message}`);
    },
  );
  return { ok: true };
}

async function runSelfUpdate(
  opts: { tag: string; pluginsDir: string; exePath: string },
  deps: SelfUpdateDeps,
): Promise<void> {
  const { tag, pluginsDir, exePath } = opts;
  const binAsset = "loadout-x86_64";
  const pluginsAsset = "loadout-plugins-x86_64.tar.xz";

  const installDir = dirname(pluginsDir); // ~/.local/share/loadout
  const newBin = join(dirname(exePath), ".loadout.new");
  const oldBin = join(dirname(exePath), ".loadout.old");
  const pluginsTar = join(installDir, ".loadout-plugins.tar.xz");
  const pluginsStaging = join(installDir, ".plugins-staging");

  // Disk preflight. The overlay's own check covers $HOME, but on
  // Bazzite/ostree the binary staging lands in /usr/local/bin
  // (/var/usrlocal) — a DIFFERENT filesystem. `statfs` unavailable ⇒
  // skip the check rather than block updates.
  await ensureFreeSpace(dirname(exePath), 400e6, "the binary install directory");
  await ensureFreeSpace(installDir, 1e9, "the plugins install directory");

  // --- Download ------------------------------------------------------------
  const sumsRes = await (async () => {
    const tmp = join(installDir, ".loadout-sha256sums");
    await downloadToFile(assetUrl(tag, "SHA256SUMS"), tmp, deps.fetchFn);
    const text = await Bun.file(tmp).text();
    await rm(tmp, { force: true });
    return parseSha256Sums(text);
  })();
  const binSum = sumsRes.get(binAsset);
  const pluginsSum = sumsRes.get(pluginsAsset);
  if (!binSum || !pluginsSum) {
    throw new Error(`SHA256SUMS for ${tag} is missing entries for the release assets`);
  }

  await downloadToFile(assetUrl(tag, binAsset), newBin, deps.fetchFn);
  await downloadToFile(assetUrl(tag, pluginsAsset), pluginsTar, deps.fetchFn);

  // --- Verify ----------------------------------------------------------------
  // Both artifacts are already on disk; on ANY mismatch remove BOTH so a
  // failed verify never leaves a partial download for the next attempt
  // or the boot cleanup to trip over.
  status = { phase: "verifying", tag };
  const gotBinSum = await deps.sha256File(newBin);
  if (gotBinSum !== binSum) {
    await rm(newBin, { force: true });
    await rm(pluginsTar, { force: true });
    throw new Error(`checksum mismatch for ${binAsset}`);
  }
  const gotPluginsSum = await deps.sha256File(pluginsTar);
  if (gotPluginsSum !== pluginsSum) {
    await rm(newBin, { force: true });
    await rm(pluginsTar, { force: true });
    throw new Error(`checksum mismatch for ${pluginsAsset}`);
  }

  // --- Apply -----------------------------------------------------------------
  status = { phase: "applying", tag };

  // Stage plugins fully before touching anything live.
  await rm(pluginsStaging, { recursive: true, force: true });
  await mkdir(pluginsStaging, { recursive: true });
  const untar = await deps.run(["tar", "-xJf", pluginsTar, "-C", pluginsStaging]);
  if (untar.exitCode !== 0) {
    throw new Error(`plugins extract failed: ${untar.stderr.trim() || untar.exitCode}`);
  }
  const stagedPlugins = join(pluginsStaging, "plugins");
  const stagedModules = join(pluginsStaging, "node_modules");
  await stat(stagedPlugins); // throws if the archive layout is unexpected
  await stat(stagedModules);

  // We extract as root; hand the tree to the user so it matches what
  // install.sh produces and stays hand-editable (the service re-chowns
  // config it writes via target-user, but bulk trees are cheaper here).
  const target = getTargetUser();
  if (target) {
    await deps.run(["chown", "-R", `${target.uid}:${target.gid}`, pluginsStaging]);
  }

  // Swap plugins + hoisted node_modules FIRST, binary LAST. The
  // plugins swap is the failure-prone half (multiple renames across a
  // user-writable tree); the binary rename is a single atomic op. If
  // the binary were swapped first and the plugins swap then failed,
  // the error path would leave a NEW binary silently armed for the
  // next unrelated restart against OLD plugins — a skew nothing
  // surfaces. This order confines a plugins failure to "nothing
  // changed". The hot-reload watcher may fire against the half-swapped
  // tree for a moment; that's tolerable because the service restarts
  // within ~1s of `done`.
  const modulesDir = join(installDir, "node_modules");
  const pluginsOld = `${pluginsDir}.old`;
  const modulesOld = `${modulesDir}.old`;
  await rm(pluginsOld, { recursive: true, force: true });
  await rm(modulesOld, { recursive: true, force: true });
  await deps.rename(pluginsDir, pluginsOld).catch(() => {}); // may not exist on a broken install
  await deps.rename(modulesDir, modulesOld).catch(() => {});
  try {
    await deps.rename(stagedPlugins, pluginsDir);
    await deps.rename(stagedModules, modulesDir);
  } catch (err) {
    // Roll the old tree back so the restart doesn't come up pluginless.
    // If `stagedPlugins`→`pluginsDir` already succeeded (so the failure
    // was on the modules rename), move the new plugins back out first —
    // otherwise `pluginsOld`→`pluginsDir` hits an occupied target and
    // the rollback silently fails, leaving new-plugins/old-modules skew.
    await deps.rename(pluginsDir, stagedPlugins).catch(() => {});
    await deps.rename(pluginsOld, pluginsDir).catch(() => {});
    await deps.rename(modulesOld, modulesDir).catch(() => {});
    throw err;
  }

  // Swap the binary: rename(2) over the running executable is atomic
  // on the same filesystem and dodges ETXTBSY (the old inode lives on
  // until the process exits). A `.loadout.old` copy of the current
  // binary is kept first — the checksum proves the download is the
  // intended asset, not that it RUNS on this device; if the new binary
  // crash-loops, the copy is the SSH-recoverable escape hatch. It is
  // reaped by cleanupStaleSelfUpdateArtifacts, which only a WORKING
  // binary ever executes, so it survives exactly as long as it's
  // needed. restorecon keeps the bin_t label on SELinux-enforcing
  // distros (Bazzite/Fedora).
  try {
    await deps.copyFile(exePath, oldBin).catch(() => {}); // best-effort rollback copy
    await chmod(newBin, 0o755);
    await deps.rename(newBin, exePath);
  } catch (err) {
    // Binary swap failed after the plugins landed — put the old
    // plugins back too, so the still-running old binary doesn't face
    // new plugins on its next restart.
    await deps.rename(pluginsDir, stagedPlugins).catch(() => {});
    await deps.rename(modulesDir, stagedModules).catch(() => {});
    await deps.rename(pluginsOld, pluginsDir).catch(() => {});
    await deps.rename(modulesOld, modulesDir).catch(() => {});
    await rm(oldBin, { force: true }).catch(() => {});
    throw err;
  }
  if (await deps.commandExists("restorecon")) {
    const rc = await deps.run(["restorecon", "-F", exePath]);
    if (rc.exitCode !== 0) {
      log.warn(`[self-update] restorecon failed (non-fatal): ${rc.stderr.trim()}`);
    }
  }

  // Cleanup (best-effort — boot-time cleanup covers a crash here).
  // `.loadout.old` is deliberately NOT removed; see above.
  await rm(pluginsOld, { recursive: true, force: true }).catch(() => {});
  await rm(modulesOld, { recursive: true, force: true }).catch(() => {});
  await rm(pluginsStaging, { recursive: true, force: true }).catch(() => {});
  await rm(pluginsTar, { force: true }).catch(() => {});
}

/** Refuse to start when the target filesystem lacks headroom; skip
 *  silently when statfs is unavailable. */
async function ensureFreeSpace(path: string, needBytes: number, label: string): Promise<void> {
  try {
    const s = await statfs(path);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < needBytes) {
      throw new Error(
        `not enough free space at ${label}: need ~${Math.round(needBytes / 1e6)} MB, ` +
          `have ${(free / 1e9).toFixed(1)} GB`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("not enough free space")) throw err;
    // statfs missing/unsupported — don't block the update on it.
  }
}

/**
 * Schedule a restart of our own service — used by `POST /api/restart`
 * (the Settings "Restart plugin server" button; the previous
 * `systemctl --user restart loadout` path broke when the installer
 * moved the backend to a root system unit).
 */
export function scheduleServiceRestart(deps: SelfUpdateDeps = DEFAULT_DEPS): void {
  deps.scheduleRestart();
}

/**
 * Remove leftovers from a self-update that died mid-flight. Called
 * once at server boot; every target is best-effort.
 *
 * Restorative FIRST: if the process died between the plugins/modules
 * swap renames, the live dir is missing while its `.old` sibling still
 * holds the previous tree. Blindly deleting `.old` (as this used to)
 * would erase the last surviving copy and boot the server permanently
 * pluginless (finding 2).
 *
 * The restore is COHERENT across the two dirs: a crash between the
 * `plugins` and `node_modules` renames can leave the pairs from
 * different generations (new plugins already live, modules still
 * renamed away). Restoring only the missing pair would boot a mixed
 * new-plugins/old-modules tree that nothing detects — so when ANY pair
 * needs restoring, every pair that still has an `.old` is rolled back
 * to it, discarding its half-applied new dir.
 */
export async function cleanupStaleSelfUpdateArtifacts(
  pluginsDir: string,
  deps: SelfUpdateDeps = DEFAULT_DEPS,
): Promise<void> {
  const installDir = dirname(pluginsDir);
  const modulesDir = join(installDir, "node_modules");
  const swapPairs: Array<[live: string, old: string]> = [
    [pluginsDir, `${pluginsDir}.old`],
    [modulesDir, `${modulesDir}.old`],
  ];
  const states = await Promise.all(
    swapPairs.map(async ([live, old]) => ({
      live,
      old,
      liveExists: !!(await stat(live).catch(() => null)),
      oldExists: !!(await stat(old).catch(() => null)),
    })),
  );
  const anyMidSwap = states.some((p) => !p.liveExists && p.oldExists);
  if (anyMidSwap) {
    for (const p of states) {
      if (!p.oldExists) continue;
      if (p.liveExists) {
        // Half-applied new dir from the interrupted swap — discard it
        // so both dirs come from the same (old) generation.
        await rm(p.live, { recursive: true, force: true }).catch(() => {});
      }
      await rename(p.old, p.live).catch(() => {});
    }
  }

  const targets = [
    join(installDir, ".loadout-plugins.tar.xz"),
    join(installDir, ".loadout-sha256sums"),
    join(installDir, ".plugins-staging"),
    `${pluginsDir}.old`,
    `${modulesDir}.old`,
  ];
  try {
    // Reap the binary staging leftover AND the `.loadout.old` rollback
    // copy — reaching this code means the running binary works, which
    // is the condition that ends the binary rollback window.
    const exeDir = dirname(deps.resolveExePath());
    targets.push(join(exeDir, ".loadout.new"), join(exeDir, ".loadout.old"));
  } catch {
    // /proc/self/exe unreadable — nothing to clean there.
  }
  for (const t of targets) {
    await rm(t, { recursive: true, force: true }).catch(() => {});
  }
}
