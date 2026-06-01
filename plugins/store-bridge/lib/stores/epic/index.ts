import { join } from "node:path";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { createExternalCache } from "@loadout/external-cache";
import type {
  AuthStatus,
  InstalledGame,
  LaunchSpec,
  LibraryEntry,
  PipelineEmit,
} from "../../types";
import type { PreflightResult, RemoteSizeEstimate, StoreDriver } from "../driver";
import { registerDriver } from "../registry";
import {
  installLegendary,
  probeLegendary,
  resolveLegendaryBinary,
} from "./install-legendary";
import { Legendary, EPIC_LOGIN_URL } from "./legendary";
import { identifyEpicInstall, sanitiseTitle } from "./identify";
import type { LegendaryInfoEntry, LegendaryInstalledEntry } from "./types";

/**
 * Disk-cached `legendary info` results. Manifest sizes only change
 * when Epic ships a new build of a game, which is rare enough that
 * a 24h freshness window is fine — and a single `info` call is
 * ~500 ms even on cache hit, which would feel slow on every
 * detail-view open. `external-cache` already namespaces by plugin
 * id so the data lives at `~/.cache/loadout/store-bridge-epic-info/`.
 */
const infoCache = createExternalCache("store-bridge-epic-info");
const INFO_CACHE_TTL_SEC = 24 * 60 * 60;

/**
 * Pluggable settings hook — the backend wires this on boot so the
 * driver can read the user-overridden legendary binary path. Doing
 * it via a setter (rather than importing state directly) keeps the
 * driver decoupled from the persistence layer.
 */
// Async getters so the backend can route reads through its state
// mutex (`readState`). A sync getter would observe stale values when
// called concurrent with an in-flight `updateSettings` write — e.g.
// user clicks Save (pinnedVersion) and Reinstall back-to-back, and
// Reinstall sees the pre-save value. Async lets the backend await
// the mutex tail before returning.
let getOverridePath: () => Promise<string | undefined> = async () => undefined;
let setOverridePath: (path: string) => Promise<void> = async () => {};
let getPinnedVersion: () => Promise<string | undefined> = async () => undefined;

export function configureEpicDriver(opts: {
  getOverride?: () => Promise<string | undefined> | string | undefined;
  setOverride?: (path: string) => Promise<void>;
  getPinnedVersion?: () => Promise<string | undefined> | string | undefined;
}): void {
  if (opts.getOverride) {
    const g = opts.getOverride;
    getOverridePath = async () => g();
  }
  if (opts.setOverride) setOverridePath = opts.setOverride;
  if (opts.getPinnedVersion) {
    const g = opts.getPinnedVersion;
    getPinnedVersion = async () => g();
  }
}

/** Pick the "tall portrait" cover URL legendary surfaces in metadata. */
function pickCover(keyImages?: Array<{ type: string; url: string }>): string | undefined {
  if (!keyImages) return undefined;
  const preferred = ["DieselGameBoxTall", "OfferImageTall", "Thumbnail"];
  for (const t of preferred) {
    const hit = keyImages.find((k) => k.type === t);
    if (hit) return hit.url;
  }
  return keyImages[0]?.url;
}

function pickHero(keyImages?: Array<{ type: string; url: string }>): string | undefined {
  return keyImages?.find((k) => k.type === "DieselGameBox" || k.type === "OfferImageWide")?.url;
}

function pickLogo(keyImages?: Array<{ type: string; url: string }>): string | undefined {
  return keyImages?.find((k) => k.type === "DieselGameBoxLogo" || k.type === "OfferImageLogo")?.url;
}

class EpicDriverImpl implements StoreDriver {
  readonly id = "epic" as const;
  readonly displayName = "Epic Games";

  /**
   * Live `legendary install` subprocesses keyed by AppName. Populated
   * inside `install()` via the `onSpawn` hook, dropped on exit (the
   * runStreaming await resolves either way). `cancelInstall` signals
   * the process if still in the map.
   *
   * We also keep cancelled AppNames in a separate Set so the
   * post-install verification in `install()` can distinguish
   * cancel-by-user from a real failure — the listInstalled probe
   * is meaningless after a user-initiated kill.
   */
  private liveInstalls = new Map<string, ReturnType<typeof Bun.spawn>>();
  private cancelledAppNames = new Set<string>();

  private async resolveBinary(): Promise<string | null> {
    return resolveLegendaryBinary(await getOverridePath());
  }

  private async legendary(): Promise<Legendary> {
    const bin = await this.resolveBinary();
    if (!bin) {
      throw new Error(
        "legendary is not installed. Run preflight and self-install from the plugin UI, or set a path in Settings.",
      );
    }
    return new Legendary(bin);
  }

  async preflight(): Promise<PreflightResult> {
    const bin = await this.resolveBinary();
    if (!bin) {
      return {
        ok: false,
        missing: ["legendary"],
        canSelfInstall: true,
        installHint:
          "Click 'Install legendary' to download the upstream binary, or run `pipx install legendary-gl` and set the path in Settings.",
      };
    }
    const probe = await probeLegendary(bin);
    if (!probe.ok) {
      return {
        ok: false,
        missing: ["legendary"],
        canSelfInstall: true,
        installHint: `legendary at ${bin} failed to run: ${probe.error}`,
      };
    }
    return { ok: true, missing: [], canSelfInstall: true };
  }

  async selfInstall(emit: PipelineEmit): Promise<void> {
    const path = await installLegendary(emit, {
      pinnedVersion: await getPinnedVersion(),
    });
    // Persist the resolved path so subsequent boots find it without
    // relying on the bundled-binary fallback heuristic.
    await setOverridePath(path).catch(() => {
      /* settings module not wired yet — non-fatal */
    });
  }

  async authStatus(): Promise<AuthStatus> {
    const bin = await this.resolveBinary();
    if (!bin) return "unknown";
    try {
      return await new Legendary(bin).authStatus();
    } catch {
      return "unknown";
    }
  }

  async startAuth(): Promise<{ url: string }> {
    const bin = await this.resolveBinary();
    if (!bin) return { url: EPIC_LOGIN_URL };
    return new Legendary(bin).startAuth();
  }

  async completeAuth(code: string): Promise<void> {
    const lg = await this.legendary();
    await lg.completeAuth(code);
  }

  async signOut(): Promise<void> {
    const lg = await this.legendary();
    await lg.signOut();
  }

  async listLibrary(): Promise<LibraryEntry[]> {
    const lg = await this.legendary();
    const raw = await lg.listLibrary();
    return raw.map((entry) => {
      const meta = entry.metadata ?? {};
      const releaseDate =
        meta.releaseInfo?.find((r) => r.dateAdded)?.dateAdded ??
        meta.creationDate;
      const platforms = unique(
        (meta.releaseInfo ?? []).flatMap((r) => r.platform ?? []),
      );
      return {
        id: entry.app_name,
        title: meta.title ?? entry.app_title,
        coverUrl: pickCover(meta.keyImages),
        heroUrl: pickHero(meta.keyImages),
        logoUrl: pickLogo(meta.keyImages),
        tags: meta.categories?.map((c) => c.path).filter(Boolean),
        description: meta.description ?? undefined,
        longDescription: meta.longDescription ?? undefined,
        developer: meta.developer ?? undefined,
        publisher: meta.publisher ?? undefined,
        releaseDate,
        platforms: platforms.length > 0 ? platforms : undefined,
      };
    });
  }

  async install(
    appName: string,
    installDir: string,
    emit: PipelineEmit,
  ): Promise<InstalledGame> {
    const lg = await this.legendary();
    this.cancelledAppNames.delete(appName);
    // legendary installs into `<base-path>/<AppName>/`; we honour that
    // by passing the *parent* dir as --base-path. The parent comes
    // from `storeInstallDir(storeId)`; the per-game `installDir` is
    // the resolved one (parent/AppName).
    let wasCancelled = false;
    try {
      await lg.install(appName, parentOf(installDir), emit, {
        onSpawn: (proc) => {
          this.liveInstalls.set(appName, proc);
        },
      });
      // Snapshot the cancel flag BEFORE finally clears it — the
      // tight race we guard for is "process exited cleanly moments
      // before our kill arrived", in which case the throw at line
      // 218 needs to fire even though the install command exited 0.
      wasCancelled = this.cancelledAppNames.has(appName);
    } finally {
      // Both cleanups run regardless of whether the install
      // succeeded, errored, or was cancelled. The set is a token
      // for "the user pressed Cancel during this run"; once we
      // exit the function the token has done its job. Without the
      // delete here the SIGTERM-throws path leaks set entries that
      // accumulate over the session.
      this.liveInstalls.delete(appName);
      this.cancelledAppNames.delete(appName);
    }
    if (wasCancelled) {
      throw new Error("Install cancelled");
    }
    // Verify the install actually took effect. legendary's install
    // command can exit 0 without doing anything in degenerate
    // cases — most notably when a second `legendary install` runs
    // concurrently and bails on the install-db lock without
    // propagating a non-zero exit. We trust list-installed as the
    // source of truth: the game must appear there post-install,
    // otherwise the plugin would record a phantom entry the user
    // can't actually launch.
    const list = await lg.listInstalled().catch(() => []);
    if (!list.find((g) => g.app_name === appName)) {
      throw new Error(
        `legendary install exited 0 but ${appName} isn't in list-installed — install was likely blocked by a concurrent run. Try again with no other Epic installs in flight.`,
      );
    }
    return this.buildInstalledRecord(lg, appName, installDir, "installed");
  }

  async cancelInstall(appName: string, installDir: string): Promise<boolean> {
    const proc = this.liveInstalls.get(appName);
    if (!proc) return false;
    this.cancelledAppNames.add(appName);
    // SIGTERM first, give legendary a beat to flush its log buffer,
    // then escalate to SIGKILL if it's still alive. The `runStreaming`
    // await in `install()` returns once `proc.exited` settles.
    try { proc.kill("SIGTERM"); } catch { /* already exited */ }
    // Clear the 3s grace timer as soon as `proc.exited` settles —
    // otherwise the setTimeout handle survives until its deadline,
    // pointlessly keeping the event loop alive past cancellation.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      proc.exited.finally(() => {
        if (killTimer) clearTimeout(killTimer);
      }),
      new Promise<void>((r) => {
        killTimer = setTimeout(r, 3000);
      }),
    ]);
    try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    // Now scrub everything legendary may have left on disk:
    // partial files in the per-game install dir + the resume marker
    // in `~/.config/legendary/tmp/<AppName>.resume`.
    await rm(installDir, { recursive: true, force: true }).catch(() => {});
    const resumePath = join(homedir(), ".config", "legendary", "tmp", `${appName}.resume`);
    await rm(resumePath, { force: true }).catch(() => {});
    return true;
  }

  async uninstall(appName: string): Promise<void> {
    const lg = await this.legendary();
    await lg.uninstall(appName);
  }

  launchSpec(installed: InstalledGame): LaunchSpec {
    // Prefer the actual executable legendary tracks for this install
    // (e.g. "Alba.exe"). Steam runs that exe directly through Proton —
    // overlay + playtime + screenshots all attach correctly. This is
    // the same shape recomp uses for Windows-on-Linux titles.
    //
    // Fallback (e.g. record migrated from an older plugin version
    // before we stored `executable`): `legendary launch <id>` so we
    // still produce something runnable. The launch path is degraded
    // — Steam won't know it's a Windows game and won't auto-set a
    // Proton compat tool — but a Re-add-to-Steam flips the shortcut
    // to the proper exe-direct path once `info` runs.
    if (installed.executable) {
      const abs = join(installed.installDir, installed.executable);
      return {
        exe: abs,
        args: installed.launchParameters ?? "",
        cwd: installed.installDir,
      };
    }
    const bin = "/usr/bin/env"; // resolved via PATH at run-time, no install dep
    return {
      exe: bin,
      args: `legendary launch ${installed.id} --skip-version-check`,
      cwd: installed.installDir,
    };
  }

  async identifyInstall(dir: string): Promise<{ id: string; title: string } | null> {
    return identifyEpicInstall(dir);
  }

  async importExisting(
    appName: string,
    dir: string,
    _emit: PipelineEmit,
  ): Promise<InstalledGame> {
    const lg = await this.legendary();
    await lg.importInstall(appName, dir);
    return this.buildInstalledRecord(lg, appName, dir, "imported");
  }

  /**
   * Public hook: refresh launch metadata for a record that's already
   * in state (e.g. the user installed it before we started capturing
   * `executable`). Used by the backend's `addInstalledToSteam` so a
   * Remove-from-Steam + Re-add-to-Steam fixes broken shortcuts
   * without forcing a full reinstall.
   */
  async refreshLaunchMetadata(
    existing: InstalledGame,
  ): Promise<InstalledGame | null> {
    const bin = await this.resolveBinary();
    if (!bin) return null;
    const lg = new Legendary(bin);
    return this.buildInstalledRecord(
      lg,
      existing.id,
      existing.installDir,
      existing.source,
      existing,
    );
  }

  async getRemoteSize(appName: string): Promise<RemoteSizeEstimate | null> {
    const bin = await this.resolveBinary();
    if (!bin) return null;
    // legendary doesn't need to be authed to print manifest sizes
    // (the manifest is cached locally after the first list-library),
    // so cache key just on app name is safe.
    const cached = await infoCache
      .getOrFetch<RemoteSizeEstimate | null>(
        `epic-size:${appName}`,
        async () => {
          const info = await new Legendary(bin).info(appName);
          if (!info) return null;
          const download = info.manifest?.download_size;
          const disk = info.manifest?.disk_size;
          const version =
            info.manifest?.build_version ??
            (typeof info.manifest?.version === "number"
              ? String(info.manifest.version)
              : info.game?.version);
          if (download == null && disk == null) return null;
          return {
            downloadSize: download ?? undefined,
            installSize: disk ?? undefined,
            version: version ?? undefined,
          };
        },
        { ttlSec: INFO_CACHE_TTL_SEC },
      )
      .catch(() => null);
    return cached;
  }

  private async buildInstalledRecord(
    lg: Legendary,
    appName: string,
    fallbackDir: string,
    source: "installed" | "imported",
    base?: InstalledGame,
  ): Promise<InstalledGame> {
    // `list-installed` is cheap and ships executable + version in
    // newer legendary builds. `info` is the fallback on older builds
    // that only emit those fields under the per-title detail.
    const list = (await lg.listInstalled().catch(() => [])) as LegendaryInstalledEntry[];
    const fromList = list.find((g) => g.app_name === appName);
    let info: LegendaryInfoEntry | null = null;
    if (!fromList?.executable) {
      info = await lg.info(appName).catch(() => null);
    }
    const installPath =
      fromList?.install_path ??
      info?.install?.install_path ??
      base?.installDir ??
      fallbackDir;
    const executable = fromList?.executable ?? info?.install?.executable;
    const launchParameters =
      fromList?.launch_parameters ?? info?.install?.launch_parameters;
    const platformRaw =
      fromList?.platform ?? info?.install?.platform ?? guessPlatform(executable);
    // Cap the title at 256 chars + strip control characters and
    // path separators. The cap lives in identify.ts for the
    // scan-import boundary too, but `legendary list-installed` and
    // `legendary info` JSON ultimately surface attacker-controlled
    // text from `.egstore` manifests on USB drives. Without these
    // filters a megabyte title would corrupt state.json + the Steam
    // shortcut display name, and an embedded `\n` / `/` could
    // corrupt `shortcuts.vdf` or smuggle a path separator into a
    // filename downstream. The review flagged this as the MEDIUM
    // control-char hygiene gap.
    const rawTitle =
      fromList?.title ?? info?.game?.title ?? base?.title ?? appName;
    return {
      id: appName,
      title: sanitiseTitle(rawTitle),
      installedAt: base?.installedAt ?? new Date().toISOString(),
      installDir: installPath,
      installSize: fromList?.install_size ?? info?.install?.install_size ?? base?.installSize,
      version: fromList?.version ?? info?.install?.version ?? info?.game?.version ?? base?.version,
      executable,
      launchParameters,
      platform: normalisePlatform(platformRaw),
      source,
      addedToSteam: false,
    };
  }
}

/** legendary surfaces "Win32"/"Win64"/"Mac"/"Linux"; we squash to our 3-value enum. */
function normalisePlatform(p?: string): "windows" | "linux" | "macos" | undefined {
  if (!p) return undefined;
  const lc = p.toLowerCase();
  if (lc.startsWith("win")) return "windows";
  if (lc === "linux") return "linux";
  if (lc === "mac" || lc === "macos" || lc === "darwin") return "macos";
  return undefined;
}

/** De-dupe a list of strings while preserving first-seen order. */
function unique<T>(xs: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/** Heuristic fallback when legendary's platform field is empty. */
function guessPlatform(exe?: string): "windows" | "linux" | "macos" | undefined {
  if (!exe) return undefined;
  const lc = exe.toLowerCase();
  if (lc.endsWith(".exe")) return "windows";
  if (lc.endsWith(".app")) return "macos";
  return "linux";
}

/**
 * Resolve the parent of a directory path with no trailing slash
 * surprises. legendary expects `--base-path` to be the *containing*
 * directory; we'd accidentally double-stem the AppName if we passed
 * the install dir itself.
 */
function parentOf(p: string): string {
  const idx = p.replace(/\/+$/, "").lastIndexOf("/");
  if (idx <= 0) return p;
  return p.slice(0, idx);
}

export const epicDriver = new EpicDriverImpl();

// Side-effect register: importing `./stores/epic` from backend.ts is
// enough to wire the driver into the registry. New stores follow the
// same pattern.
registerDriver(epicDriver);
