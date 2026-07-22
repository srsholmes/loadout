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

import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runFull, commandExists, spawn } from "@loadout/exec";
import { RELEASE_TAG_RE, parseVersion, compareVersions } from "@loadout/types";
import { LOADER_VERSION } from "../version";
import { getTargetUser } from "./target-user";
import { log } from "./logger";

const REPO = "srsholmes/loadout";

/** Hosts a release-asset redirect chain may pass through. Checked on
 *  EVERY hop (same rationale as plugins/store-bridge/lib/github-release.ts:
 *  an attacker-controlled hop must fail before its body is fetched). */
const TRUSTED_GITHUB_HOSTS = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

export function isTrustedGithubHost(host: string): boolean {
  const lower = host.toLowerCase();
  return TRUSTED_GITHUB_HOSTS.some((t) => lower === t || lower.endsWith(`.${t}`));
}

/** Parse a `sha256sum`-format manifest ("<hex>  <filename>" lines)
 *  into filename → lowercase hex. Tolerates the `*` binary-mode
 *  marker and blank lines. */
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

export type SelfUpdatePhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "applying"
  | "done"
  | "error";

export interface SelfUpdateStatus {
  phase: SelfUpdatePhase;
  tag?: string;
  message?: string;
}

let status: SelfUpdateStatus = { phase: "idle" };

export function getSelfUpdateStatus(): SelfUpdateStatus {
  return status;
}

function inFlight(): boolean {
  return (
    status.phase === "downloading" ||
    status.phase === "verifying" ||
    status.phase === "applying"
  );
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
};

/**
 * Download `url` to `dest`, walking redirects manually and re-pinning
 * the hostname on every hop. Streams to disk — the plugins archive is
 * tens of MB and buffering it in RAM buys nothing.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const headers: Record<string, string> = { "User-Agent": "Loadout-Updater" };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;

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
    res = await fetchFn(currentUrl, { headers, redirect: "manual" });
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
  await Bun.write(dest, res);
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
  const pluginsTar = join(installDir, ".loadout-plugins.tar.xz");
  const pluginsStaging = join(installDir, ".plugins-staging");

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
  status = { phase: "verifying", tag };
  const gotBinSum = await deps.sha256File(newBin);
  if (gotBinSum !== binSum) {
    await rm(newBin, { force: true });
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

  // Swap the binary first: rename(2) over the running executable is
  // atomic on the same filesystem and dodges ETXTBSY (the old inode
  // lives on until the process exits). restorecon keeps the bin_t
  // label on SELinux-enforcing distros (Bazzite/Fedora).
  await chmod(newBin, 0o755);
  await rename(newBin, exePath);
  if (await commandExists("restorecon")) {
    const rc = await deps.run(["restorecon", "-F", exePath]);
    if (rc.exitCode !== 0) {
      log.warn(`[self-update] restorecon failed (non-fatal): ${rc.stderr.trim()}`);
    }
  }

  // Swap plugins + hoisted node_modules. The hot-reload watcher may
  // fire against the half-swapped tree for a moment; that's tolerable
  // because the service restarts within ~1s of `done`.
  const modulesDir = join(installDir, "node_modules");
  const pluginsOld = `${pluginsDir}.old`;
  const modulesOld = `${modulesDir}.old`;
  await rm(pluginsOld, { recursive: true, force: true });
  await rm(modulesOld, { recursive: true, force: true });
  await rename(pluginsDir, pluginsOld).catch(() => {}); // may not exist on a broken install
  await rename(modulesDir, modulesOld).catch(() => {});
  try {
    await rename(stagedPlugins, pluginsDir);
    await rename(stagedModules, modulesDir);
  } catch (err) {
    // Roll the old tree back so the restart doesn't come up pluginless.
    await rename(pluginsOld, pluginsDir).catch(() => {});
    await rename(modulesOld, modulesDir).catch(() => {});
    throw err;
  }

  // Cleanup (best-effort — boot-time cleanup covers a crash here).
  await rm(pluginsOld, { recursive: true, force: true }).catch(() => {});
  await rm(modulesOld, { recursive: true, force: true }).catch(() => {});
  await rm(pluginsStaging, { recursive: true, force: true }).catch(() => {});
  await rm(pluginsTar, { force: true }).catch(() => {});
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
 */
export async function cleanupStaleSelfUpdateArtifacts(
  pluginsDir: string,
  deps: SelfUpdateDeps = DEFAULT_DEPS,
): Promise<void> {
  const installDir = dirname(pluginsDir);
  const targets = [
    join(installDir, ".loadout-plugins.tar.xz"),
    join(installDir, ".loadout-sha256sums"),
    join(installDir, ".plugins-staging"),
    `${pluginsDir}.old`,
    join(installDir, "node_modules.old"),
  ];
  try {
    targets.push(join(dirname(deps.resolveExePath()), ".loadout.new"));
  } catch {
    // /proc/self/exe unreadable — nothing to clean there.
  }
  for (const t of targets) {
    await rm(t, { recursive: true, force: true }).catch(() => {});
  }
}
