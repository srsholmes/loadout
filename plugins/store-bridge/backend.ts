import type { PluginBackend, EmitPayload, PluginLogger } from "@loadout/types";
import { resolve as resolvePath } from "node:path";
import {
  loadState,
  updateInstalledGame,
  removeInstalledGame,
  updateStoreLibrary,
  updateAuthStatus,
  updateSettings,
  addScanPath as stateAddScanPath,
  removeScanPath as stateRemoveScanPath,
  defaultStoreState,
} from "./lib/state";
import { storeInstallDir } from "./lib/platform";
import type {
  PersistedState,
  PipelineEvent,
  StoreId,
  DetectedInstall,
  Settings,
  InstalledGame,
  LibraryEntry,
} from "./lib/types";
import { addToSteamPipelineId } from "./lib/types";
import { listDrivers, getDriver } from "./lib/stores/registry";
import { checkPreflight } from "./lib/preflight";
import { addToSteam, removeFromSteam } from "./lib/steam-shortcut";
import { launchGame as launchInstalled } from "./lib/launcher";
import { applyArtwork } from "./lib/artwork";
import { scanForInstalls } from "./lib/scan";
import {
  configureEpicDriver,
} from "./lib/stores/epic";

// Cache TTL for legendary's library — re-fetched on demand by the
// UI but never on every render. 6h is generous; the user can hit
// "refresh" any time.
const LIBRARY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

interface GameInfo {
  storeId: StoreId;
  id: string;
  title: string;
  coverUrl?: string;
  heroUrl?: string;
  logoUrl?: string;
  installSize?: number;
  status: "library" | "installed" | "imported";
  installed?: InstalledGame;
  description?: string;
  longDescription?: string;
  developer?: string;
  publisher?: string;
  releaseDate?: string;
  tags?: string[];
  platforms?: string[];
}

/** Snapshot of an in-flight install. The detail view re-derives
 *  the "Installing…" button state from this on mount so screen
 *  changes during a long install don't reset the local UI back to
 *  "Install". Latest percent doubles as the initial progress-bar
 *  value before the next pipelineEvent lands. */
export interface InProgressInstall {
  storeId: StoreId;
  gameId: string;
  percent: number;
  label?: string;
}

export default class StoreBridgeBackend implements PluginBackend {
  log?: PluginLogger;
  emit?: (payload: EmitPayload) => void;

  private state!: PersistedState;

  /**
   * Active installs keyed by `storeId/gameId`. Populated when
   * `installGame` / `importDetected` start emitting `pipelineEvent`
   * and dropped on terminal events. Survives frontend remounts —
   * exposed via `getInProgressInstall` so the detail view picks up
   * the running install when the user comes back to its page.
   */
  private inFlight = new Map<string, InProgressInstall>();

  /**
   * Serialise install + import calls. Two `legendary install` runs
   * at once lock-contend on `~/.config/legendary/installed.json.lock`
   * and the loser bails silently with exit 0, leaving us to record a
   * phantom entry with no on-disk files. Chaining through a single
   * promise means the second click queues behind the first; the
   * `inFlight` registry is seeded up-front so queued installs still
   * show as "Installing…" in the UI rather than briefly snapping
   * back to "Install".
   *
   * The chain is reset to a resolved promise on every failure so a
   * single bad install can't poison the whole queue.
   */
  private installQueue: Promise<void> = Promise.resolve();

  /**
   * Live install attempt ids per (storeId, gameId) key. Each
   * `installGame` / `importDetected` call mints a fresh attempt id
   * (monotonic counter) and registers it here SYNCHRONOUSLY — i.e.
   * before any await — so that if `cancelInstall` lands between the
   * enqueue and the dequeue, the cancel call can snapshot every
   * currently-live attempt for the key without missing any.
   */
  private liveAttempts = new Map<string, Set<number>>();

  /**
   * Cancel tokens for queued-or-running installs, keyed by
   * `storeId/gameId` and storing the set of attempt ids the user
   * has cancelled. The install unit checks "is MY attempt in the
   * cancelled set?" — not "does the key have any entries?" — so a
   * fast cancel+reinstall double-click can't un-cancel the new
   * attempt that just got enqueued.
   *
   * The set-per-key (not boolean) shape is the load-bearing fix: a
   * boolean `Map<key, true>` can't distinguish "the user cancelled
   * the OLD attempt" from "the new attempt is also cancelled" when
   * a new install for the same gameId is enqueued microseconds
   * after the cancel call. The PR review flagged this as the HIGH
   * concurrency bug.
   */
  private cancelledAttempts = new Map<string, Set<number>>();

  /**
   * Monotonic attempt counter — one id per `installGame` /
   * `importDetected` call. Keeps each attempt's cancel state
   * independent of any previous-or-concurrent attempt for the same
   * gameId.
   */
  private nextAttemptId = 1;

  /**
   * Serialise every write to `this.state`. Without this the install
   * queue protects install/import flows from each other, but a
   * concurrent `updateSettings` / `updateAuthStatus` / `addScanPath`
   * call still races: each helper does load → mutate → save against
   * `this.state` which is a single shared reference, so the later
   * writer clobbers fields it never touched. Funnelling every
   * `this.state = await ...` through one chain serialises the whole
   * read-modify-write per backend instance.
   */
  private stateMutex: Promise<void> = Promise.resolve();

  async onLoad(): Promise<void> {
    this.state = await loadState();
    // Wire the Epic driver to our settings layer so it can read +
    // persist the user-overridden legendary binary path.
    configureEpicDriver({
      // Async getters go through readState so the driver observes
      // any in-flight `updateSettings` write rather than a stale
      // snapshot — without this, Save + Reinstall back-to-back
      // would use the pre-save pinnedVersion.
      getOverride: async () => {
        const s = await this.readState();
        return s.settings.driverOverrides?.epic?.binary || undefined;
      },
      setOverride: async (path: string) => {
        await this.mutateState((s) =>
          updateSettings(s, {
            driverOverrides: {
              ...s.settings.driverOverrides,
              epic: { ...s.settings.driverOverrides?.epic, binary: path },
            },
          }),
        );
      },
      getPinnedVersion: async () => {
        const s = await this.readState();
        return s.settings.driverOverrides?.epic?.pinnedVersion || undefined;
      },
    });
    this.log?.info(
      `[store-bridge] Loaded — ${listDrivers().length} drivers, ${this.installedCount()} installed`,
    );
  }

  // ── Stores / preflight ────────────────────────────────────────────────────

  async getStores(): Promise<
    { id: StoreId; displayName: string; authStatus: string; enabled: boolean; preflightOk: boolean }[]
  > {
    const enabled = new Set(this.state.settings.enabledStores);
    const out: {
      id: StoreId;
      displayName: string;
      authStatus: string;
      enabled: boolean;
      preflightOk: boolean;
    }[] = [];
    for (const d of listDrivers()) {
      const pf = await d.preflight().catch(() => ({
        ok: false,
        missing: [d.id],
        canSelfInstall: false,
      }));
      out.push({
        id: d.id,
        displayName: d.displayName,
        authStatus: this.state.stores[d.id]?.authStatus ?? "unknown",
        enabled: enabled.has(d.id),
        preflightOk: pf.ok,
      });
    }
    return out;
  }

  async checkPreflight(storeId: StoreId) {
    return checkPreflight(storeId);
  }

  async selfInstallTooling(storeId: StoreId): Promise<void> {
    const driver = this.requireDriver(storeId);
    if (!driver.selfInstall) {
      throw new Error(`Driver ${storeId} has no tooling to self-install.`);
    }
    await driver.selfInstall(this.makeEmitter());
    // Re-load state in case selfInstall persisted a binary path.
    await this.mutateState(async () => loadState());
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  async startAuth(storeId: StoreId): Promise<{ url: string }> {
    const driver = this.requireDriver(storeId);
    if (!driver.startAuth) {
      throw new Error(`Driver ${storeId} doesn't expose a browser-auth URL.`);
    }
    return driver.startAuth();
  }

  async completeAuth(storeId: StoreId, code: string): Promise<void> {
    const driver = this.requireDriver(storeId);
    if (!driver.completeAuth) {
      throw new Error(`Driver ${storeId} doesn't support paste-back auth.`);
    }
    await driver.completeAuth(code);
    await this.mutateState((s) => updateAuthStatus(s, storeId, "authed"));
    this.emit?.({ event: "authEvent", data: { storeId, status: "authed" } });
  }

  async signOut(storeId: StoreId): Promise<void> {
    const driver = this.requireDriver(storeId);
    // If the driver doesn't expose a real sign-out (e.g. xCloud auth
    // lives in a browser session we don't manage), don't pretend to
    // have done anything. Throwing makes the UI surface a toast the
    // user can act on, rather than silently flipping our local
    // authStatus to "unknown" — which would leave them out of sync
    // with the actual upstream session.
    if (!driver.signOut) {
      throw new Error(`${driver.displayName} doesn't support sign-out from here.`);
    }
    await driver.signOut();
    await this.mutateState((s) => updateAuthStatus(s, storeId, "unknown"));
    this.emit?.({ event: "authEvent", data: { storeId, status: "unknown" } });
  }

  // ── Library ──────────────────────────────────────────────────────────────

  async getLibrary(storeId: StoreId): Promise<GameInfo[]> {
    const slice = this.state.stores[storeId] ?? defaultStoreState(storeId);
    const stale = Date.now() - slice.libraryCacheFetchedAt > LIBRARY_CACHE_TTL_MS;
    if (Object.keys(slice.library).length === 0 || stale) {
      await this.refreshLibrary(storeId).catch((err: unknown) => {
        // Keep the UI alive on auth/network failure — surface what we
        // have on disk (possibly empty) rather than throwing.
        this.log?.warn(
          `[store-bridge] refreshLibrary failed for ${storeId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    return this.viewForStore(storeId);
  }

  async refreshLibrary(storeId: StoreId): Promise<void> {
    const driver = this.requireDriver(storeId);
    const entries = await driver.listLibrary();
    const map: Record<string, LibraryEntry> = {};
    for (const e of entries) map[e.id] = e;
    await this.mutateState((s) => updateStoreLibrary(s, storeId, map));
    this.emit?.({ event: "libraryRefreshed", data: { storeId, count: entries.length } });
  }

  async getGameDetail(storeId: StoreId, gameId: string): Promise<GameInfo | null> {
    const view = await this.viewForStore(storeId);
    return view.find((g) => g.id === gameId) ?? null;
  }

  /**
   * Fetch a download + install-size estimate for a not-yet-installed
   * title. Returns null when the driver can't get it (no CLI, network
   * down, store doesn't expose it). Detail view calls this lazily so
   * the user sees "this'll be 24 GB" before clicking Install.
   *
   * Results are cached driver-side (24h TTL) so re-visiting the same
   * detail page is instant.
   */
  async getStoreGameSize(
    storeId: StoreId,
    gameId: string,
  ): Promise<{ downloadSize?: number; installSize?: number; version?: string } | null> {
    const driver = this.requireDriver(storeId);
    if (!driver.getRemoteSize) return null;
    return driver.getRemoteSize(gameId);
  }

  // ── Install / uninstall / launch ─────────────────────────────────────────

  async installGame(storeId: StoreId, gameId: string): Promise<void> {
    validateGameId(gameId);
    const driver = this.requireDriver(storeId);
    const installDir = `${storeInstallDir(storeId)}/${gameId}`;
    const key = `${storeId}/${gameId}`;
    // Synchronous claim — captures this attempt in `liveAttempts`
    // before any await, so a `cancelInstall` arriving in the same
    // tick snapshots this attempt id (and a LATER claim that
    // happens after the cancel-snapshot lands does NOT — that's
    // the fix for the HIGH cancel-token race).
    const attemptId = this.claimAttempt(key);
    const emit = this.makeEmitter({ gameId, storeId });
    // Seed the in-flight registry up-front so the Downloads tab and
    // detail view show this install — even while it's queued
    // behind another active install rather than actually running.
    this.inFlight.set(key, { storeId, gameId, percent: 0 });
    // Serialise through the install queue. Two `legendary install`
    // calls running concurrently lock-contend on the install-db
    // file and the loser exits 0 without doing anything; the queue
    // makes the second click wait until the first finishes.
    return this.enqueueInstall(async () => {
      try {
        // Cancel-while-queued: if THIS attempt was cancelled while
        // it was waiting for its turn, bail before invoking the
        // driver — `driver.cancelInstall` had nothing to kill (no
        // process yet) so the cancel token is the only signal that
        // anything happened. We check the attempt id, not the key,
        // so a fast cancel+reinstall double-click doesn't un-cancel
        // a previously-queued attempt or vice versa.
        if (this.isAttemptCancelled(key, attemptId)) {
          emit({
            kind: "error",
            id: `${storeId}:install:${gameId}`,
            message: "Install cancelled",
          });
          return;
        }
        let installed: InstalledGame;
        try {
          installed = await driver.install(gameId, installDir, emit);
        } catch (err) {
          // Suppress the redundant error emit for the cancel path —
          // `cancelInstall` already emitted "Install cancelled"
          // synchronously when the user clicked Cancel, and the
          // live process then throws the same string. Without this
          // guard the user sees two identical toasts.
          const message = err instanceof Error ? err.message : String(err);
          const cancelledByUser = this.isAttemptCancelled(key, attemptId);
          if (!cancelledByUser) {
            emit({
              kind: "error",
              id: `${storeId}:install:${gameId}`,
              message,
            });
          }
          throw err;
        }
        await this.mutateState((s) =>
          updateInstalledGame(s, storeId, gameId, installed),
        );
        // Always register the shortcut + tag + collection. The only
        // reason to install via Store Bridge is to play through
        // Steam, so the implicit add-to-Steam matches RecompHub's
        // behaviour. Repair paths (Remove + Add via detail view)
        // still exist for the edge case where Steam loses the
        // shortcut. We treat add-to-Steam as a separate failure:
        // if it throws the install itself still succeeded (game is
        // on disk + recorded in state), but the user gets a
        // dedicated toast and the gameStatusChanged event reports
        // `addedToSteam: false` so the UI shows an "Add to Steam"
        // button on the tile.
        let addedToSteam = true;
        try {
          await this.addInstalledToSteam(storeId, gameId);
        } catch (err) {
          addedToSteam = false;
          const message = err instanceof Error ? err.message : String(err);
          this.log?.warn(
            `[store-bridge] addInstalledToSteam failed for ${gameId}: ${message}`,
          );
          this.emit?.({
            event: "pipelineEvent",
            data: {
              kind: "error",
              id: addToSteamPipelineId(storeId, gameId),
              message,
              storeId,
              gameId,
            },
          });
        }
        this.emit?.({
          event: "gameStatusChanged",
          data: {
            storeId,
            gameId,
            status: "installed",
            addedToSteam,
            // Title makes the top-level App toast self-sufficient —
            // it doesn't have to plumb the catalog's games snapshot
            // to turn an opaque gameId into something the user
            // recognises.
            title: installed.title,
          },
        });
      } finally {
        // Drop just THIS attempt's cancel token so a future
        // install for the same gameId starts clean. The
        // attempt-scoped key means concurrent attempts can't trip
        // over each other's bookkeeping.
        this.clearAttempt(key, attemptId);
      }
    });
  }

  /**
   * Chain a unit of install work onto `installQueue`. Errors are
   * caught on the stored chain (so the queue continues processing)
   * but re-thrown to the awaiting caller (so the UI sees the
   * failure on its `installGame` promise). `inFlight` cleanup
   * happens via the emit() side-effect on the terminal
   * progress/complete/error event, plus an explicit drop in the
   * `finally` here as a safety net for the queued-but-cancelled
   * path.
   */
  private enqueueInstall(unit: () => Promise<void>): Promise<void> {
    const next = this.installQueue.then(() => unit());
    this.installQueue = next.catch(() => {});
    return next;
  }

  /**
   * Synchronously claim a new attempt id for an install/import on
   * `key` and register it in `liveAttempts`. Must run BEFORE any
   * `await` in the caller so a `cancelInstall` arriving in the same
   * tick captures the attempt in its live-set snapshot.
   */
  private claimAttempt(key: string): number {
    const attemptId = this.nextAttemptId++;
    let set = this.liveAttempts.get(key);
    if (!set) {
      set = new Set();
      this.liveAttempts.set(key, set);
    }
    set.add(attemptId);
    return attemptId;
  }

  /** Has `attemptId` for `key` been cancelled by the user? */
  private isAttemptCancelled(key: string, attemptId: number): boolean {
    return this.cancelledAttempts.get(key)?.has(attemptId) ?? false;
  }

  /**
   * Drop `attemptId` from both the live + cancelled sets for `key`.
   * Called from the install/import unit's `finally` so the
   * bookkeeping doesn't leak across attempts.
   */
  private clearAttempt(key: string, attemptId: number): void {
    const live = this.liveAttempts.get(key);
    if (live) {
      live.delete(attemptId);
      if (live.size === 0) this.liveAttempts.delete(key);
    }
    const cancelled = this.cancelledAttempts.get(key);
    if (cancelled) {
      cancelled.delete(attemptId);
      if (cancelled.size === 0) this.cancelledAttempts.delete(key);
    }
  }

  /**
   * Mark every currently-live attempt for `key` as cancelled. Used
   * by `cancelInstall` — snapshots the set at the moment the user
   * clicks Cancel, so a NEW attempt minted later (e.g. a rapid
   * cancel+reinstall double-click) gets a fresh id that ISN'T in
   * the snapshot and therefore isn't accidentally cancelled.
   */
  private cancelLiveAttempts(key: string): void {
    const live = this.liveAttempts.get(key);
    if (!live || live.size === 0) return;
    let cancelled = this.cancelledAttempts.get(key);
    if (!cancelled) {
      cancelled = new Set();
      this.cancelledAttempts.set(key, cancelled);
    }
    for (const id of live) cancelled.add(id);
  }

  /**
   * Serialise a state mutation through `stateMutex`. Every helper
   * that updates `this.state` must funnel through here, otherwise
   * two concurrent writers can do a read-modify-write race against
   * the shared snapshot — the second writer would persist its own
   * mutation plus the *old* version of every field the first
   * writer touched. Errors propagate to the caller; the stored
   * chain is reset to resolved so one failure doesn't block the
   * queue.
   */
  private async mutateState(
    mutator: (s: PersistedState) => Promise<PersistedState> | PersistedState,
  ): Promise<PersistedState> {
    const next = this.stateMutex.then(async () => {
      this.state = await mutator(this.state);
      return this.state;
    });
    this.stateMutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Read a consistent snapshot of state. Most reads are tick-aligned
   * so direct `this.state` access is safe in single-threaded JS, but
   * any read whose decision depends on a mutateState that may be
   * mid-flight (notably `cancelInstall`'s already-finished branch,
   * which races the install-unit's `updateInstalledGame` write)
   * should funnel through here. We park the read at the tail of
   * `stateMutex` so it observes the same snapshot any concurrent
   * writer would have produced.
   */
  private async readState(): Promise<PersistedState> {
    await this.stateMutex;
    return this.state;
  }

  /**
   * Cancel an in-flight install. Signals the driver to kill the
   * underlying download process, wipes partial files + resume
   * marker, drops the inFlight entry and notifies the UI.
   *
   * Idempotent: calling on a non-existent install just returns —
   * useful when the user double-clicks Cancel or when the install
   * finished moments before they hit the button.
   */
  async cancelInstall(storeId: StoreId, gameId: string): Promise<void> {
    validateGameId(gameId);
    const driver = this.requireDriver(storeId);
    const key = `${storeId}/${gameId}`;
    // Cover three states: (a) install is queued but not yet
    // spawned — driver has nothing to kill, the install unit will
    // check this set on dequeue and bail; (b) install is running —
    // driver kills the live subprocess; (c) install isn't ours to
    // cancel — we still drop the inFlight entry as a no-op to
    // unstick stale UI in case something else got out of sync.
    //
    // We cancel every CURRENTLY-LIVE attempt id for this key,
    // captured at the moment the user clicks Cancel. A new attempt
    // enqueued microseconds later gets a fresh id that's NOT in
    // this set, so the cancel doesn't bleed forward into it — fix
    // for the HIGH bug the PR review flagged.
    this.cancelLiveAttempts(key);
    const installDir = `${storeInstallDir(storeId)}/${gameId}`;
    if (driver.cancelInstall) {
      // Best-effort: a driver that doesn't expose cancel still
      // gets the queued-cancel + inFlight cleanup below.
      await driver.cancelInstall(gameId, installDir).catch((err: unknown) => {
        this.log?.warn(
          `[store-bridge] driver.cancelInstall threw for ${gameId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    // Always clear inFlight + emit error so the frontend's
    // pipelineEvent handler flips the tile back to Install. The
    // central makeEmitter side-effect would also clear inFlight
    // if the running install's stream emits an error in response
    // to the SIGTERM — but we do it here unconditionally because
    // the queued case has no live emit chain.
    if (this.inFlight.has(key)) {
      this.inFlight.delete(key);
      this.emit?.({
        event: "pipelineEvent",
        data: {
          kind: "error",
          id: `${storeId}:install:${gameId}`,
          message: "Install cancelled",
          storeId,
          gameId,
        },
      });
    } else {
      // The install completed (or never started) before cancel
      // landed. Surface a benign message so the user gets a toast
      // confirming the click did *something* — without it the
      // tile-state change is the only feedback and it looks like
      // the button was ignored.
      //
      // Read through `readState` so we observe the same snapshot a
      // concurrent install-unit's `updateInstalledGame` mutation
      // would have produced — without this, a cancel landing in the
      // microsecond between the driver resolving and the state
      // write committing reports "Nothing to cancel" when the
      // install actually finished.
      const snapshot = await this.readState();
      const installed = snapshot.stores[storeId]?.installed[gameId];
      this.emit?.({
        event: "pipelineEvent",
        data: {
          kind: "error",
          id: `${storeId}:install:${gameId}`,
          message: installed
            ? "Install already finished — nothing to cancel"
            : "Nothing to cancel",
          storeId,
          gameId,
        },
      });
    }
  }

  async uninstallGame(storeId: StoreId, gameId: string): Promise<void> {
    validateGameId(gameId);
    const driver = this.requireDriver(storeId);
    // Wrap the read-modify-write in the state mutex so concurrent
    // uninstalls (or an uninstall racing addInstalledToSteam) can't
    // produce a torn intermediate state. Without this, the read of
    // `installed` here could observe a stale snapshot that a
    // concurrent mutation has already moved on from — the review
    // flagged the read-modify-write asymmetry as the MEDIUM bug.
    await this.mutateState(async (s) => {
      const installed = s.stores[storeId]?.installed[gameId];
      // Drive the driver FIRST. If the driver throws (legendary
      // errors, install path missing), leave the Steam shortcut +
      // state.json entry in place so the user can retry without
      // orphaning their shortcut — fix for the MEDIUM bug the
      // review flagged.
      await driver.uninstall(gameId, installed?.installDir ?? "");
      if (installed?.steamAppId) {
        await removeFromSteam(installed.steamAppId);
      }
      return removeInstalledGame(s, storeId, gameId);
    });
    this.emit?.({ event: "gameStatusChanged", data: { storeId, gameId, status: "uninstalled" } });
  }

  async launchGame(storeId: StoreId, gameId: string): Promise<void> {
    validateGameId(gameId);
    // Funnel the read through `readState()` for symmetry with the
    // rest of the backend — see the comment on `addInstalledToSteam`.
    const snapshot = await this.readState();
    const installed = snapshot.stores[storeId]?.installed[gameId];
    if (!installed) throw new Error(`Not installed: ${storeId}/${gameId}`);
    await launchInstalled(installed);
  }

  async addInstalledToSteam(storeId: StoreId, gameId: string): Promise<void> {
    validateGameId(gameId);
    const driver = this.requireDriver(storeId);
    // Read through `readState()` to share the mutex symmetry the
    // rest of the backend established. Direct `this.state` reads
    // can observe a snapshot a concurrent writer is mid-mutating;
    // the review flagged this as the MEDIUM symmetry slip.
    let snapshot = await this.readState();
    let installed = snapshot.stores[storeId]?.installed[gameId];
    if (!installed) throw new Error(`Not installed: ${storeId}/${gameId}`);
    // Refresh launch metadata if the record is missing it — covers
    // records persisted before we started caching executable/platform
    // (e.g. the user installed a title with an older plugin build and
    // is now repairing the shortcut via Remove + Re-add).
    if (!installed.executable && driver.refreshLaunchMetadata) {
      const refreshed = await driver
        .refreshLaunchMetadata(installed)
        .catch((err: unknown) => {
          this.log?.warn(
            `[store-bridge] refreshLaunchMetadata failed for ${gameId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return null;
        });
      if (refreshed) {
        installed = {
          ...installed,
          executable: refreshed.executable,
          launchParameters: refreshed.launchParameters,
          platform: refreshed.platform,
          installDir: refreshed.installDir,
          version: refreshed.version,
          installSize: refreshed.installSize,
        };
      }
    }
    // If the executable still isn't known, the shortcut we'd
    // register would have an empty `Exe` and the eventual launch
    // would either fail silently or fall through to a degraded
    // `legendary launch` wrapping with no Proton compat tool. Bail
    // loudly so the user can decide whether to reinstall or set
    // launch options by hand.
    if (!installed.executable) {
      throw new Error(
        `Can't determine the launch executable for ${installed.title}. ` +
          `Try Uninstall + Reinstall to refresh metadata, or set the launch in Steam manually after Add to Steam.`,
      );
    }
    const { appId, gameId64 } = await addToSteam(driver, installed);
    const updated: InstalledGame = {
      ...installed,
      addedToSteam: true,
      steamAppId: appId,
      steamGameId64: gameId64,
    };
    await this.mutateState((s) => updateInstalledGame(s, storeId, gameId, updated));
    // Best-effort artwork apply — skip silently if Steam isn't running or
    // the store didn't ship cover URLs. Re-read through the mutex so
    // the lookup sees the post-`updateInstalledGame` snapshot rather
    // than a stale pre-write one.
    snapshot = await this.readState();
    const libEntry = snapshot.stores[storeId]?.library[gameId];
    if (libEntry) {
      await applyArtwork(libEntry, appId).catch((err: unknown) => {
        this.log?.warn(
          `[store-bridge] applyArtwork failed for ${gameId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    // Tell the frontend the addedToSteam flag flipped so the detail
    // view's action buttons (Add/Launch/Remove) re-render without
    // waiting for the user to navigate away and back.
    this.emit?.({
      event: "gameStatusChanged",
      data: { storeId, gameId, status: "added-to-steam" },
    });
  }

  async removeFromSteam(storeId: StoreId, gameId: string): Promise<void> {
    validateGameId(gameId);
    // Wrap the read-modify-write in the state mutex — a concurrent
    // `addInstalledToSteam` racing this could otherwise observe the
    // pre-remove `installed` snapshot, run its own update against
    // it, and clobber the remove. The whole block runs through one
    // chain so the read + remove + write are atomic w.r.t. other
    // state mutations.
    await this.mutateState(async (s) => {
      const installed = s.stores[storeId]?.installed[gameId];
      if (!installed?.steamAppId) return s;
      await removeFromSteam(installed.steamAppId);
      const updated: InstalledGame = {
        ...installed,
        addedToSteam: false,
        steamAppId: undefined,
        steamGameId64: undefined,
      };
      return updateInstalledGame(s, storeId, gameId, updated);
    });
    this.emit?.({
      event: "gameStatusChanged",
      data: { storeId, gameId, status: "removed-from-steam" },
    });
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  async getSettings(): Promise<Settings> {
    return this.state.settings;
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const next = await this.mutateState((s) => updateSettings(s, patch));
    return next.settings;
  }

  // ── Scan / import ────────────────────────────────────────────────────────

  async addScanPath(path: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = path.trim();
    if (!trimmed) return { ok: false, error: "Path is empty." };
    if (!trimmed.startsWith("/") && !trimmed.startsWith("~")) {
      return { ok: false, error: "Use an absolute path." };
    }
    // Whitelist the dirs we actually expect users to point scan at —
    // mirrors the `read:` permissions in plugin.json. The plugin host
    // doesn't enforce those permissions at the FS layer, so this is
    // the only gate stopping a user (or a UI bug) from pointing the
    // walker at `/etc`, `/`, or their home dir's hidden configs.
    if (!isAllowedScanPath(trimmed)) {
      return {
        ok: false,
        error:
          "Scan paths must live under ~/Games, ~/.local/share/Heroic, " +
          "~/.steam/steam/steamapps, /run/media, or /mnt. Move the game install " +
          "to one of those locations first.",
      };
    }
    await this.mutateState((s) => stateAddScanPath(s, trimmed));
    return { ok: true };
  }

  async removeScanPath(path: string): Promise<void> {
    await this.mutateState((s) => stateRemoveScanPath(s, path));
  }

  async scanForInstalls(): Promise<{ detected: DetectedInstall[] }> {
    const exclude = new Set<string>();
    for (const slice of Object.values(this.state.stores)) {
      if (!slice) continue;
      for (const game of Object.values(slice.installed)) {
        exclude.add(game.installDir);
      }
    }
    const detected = await scanForInstalls(
      this.state.settings.scanPaths,
      exclude,
      (dir: string) => {
        this.emit?.({ event: "scanProgress", data: { dir } });
      },
    );
    await this.mutateState((s) => updateSettings(s, { lastScanAt: Date.now() }));
    return { detected };
  }

  async importDetected(storeId: StoreId, gameId: string, dir: string): Promise<void> {
    validateGameId(gameId);
    const driver = this.requireDriver(storeId);
    const key = `${storeId}/${gameId}`;
    // Synchronous claim — same race-window reasoning as installGame.
    const attemptId = this.claimAttempt(key);
    const emit = this.makeEmitter({ gameId, storeId });
    this.inFlight.set(key, { storeId, gameId, percent: 0 });
    // Same queue as installGame — `legendary import` also touches
    // the install-db lock and would lose the race against a
    // concurrent install.
    return this.enqueueInstall(async () => {
      try {
        if (this.isAttemptCancelled(key, attemptId)) {
          // Cancel-while-queued: emit a `cancelled`-flavoured
          // pipelineEvent so the catalog tile flips back to its
          // pre-import state. Without this dedicated event the UI
          // sees only the silent inFlight drop and wouldn't surface
          // a toast — the review flagged the import-cancel
          // symmetry gap as a LOW-quality slip.
          emit({
            kind: "error",
            id: `${storeId}:import:${gameId}`,
            message: "Import cancelled",
          });
          return;
        }
        if (!driver.importExisting) {
          throw new Error(`Driver ${storeId} doesn't support import.`);
        }
        let installed: InstalledGame;
        try {
          installed = await driver.importExisting(gameId, dir, emit);
        } catch (err) {
          // Suppress the redundant emit on the user-cancel path —
          // same shape as installGame's catch.
          const message = err instanceof Error ? err.message : String(err);
          if (!this.isAttemptCancelled(key, attemptId)) {
            emit({
              kind: "error",
              id: `${storeId}:import:${gameId}`,
              message,
            });
          }
          throw err;
        }
        await this.mutateState((s) =>
          updateInstalledGame(s, storeId, gameId, installed),
        );
        // Match the installGame flow — add-to-Steam is a separate
        // failure mode and shouldn't fail the import unit. Toast +
        // emit `addedToSteam: false` so the user can retry from
        // the detail view without losing the imported install
        // record.
        let addedToSteam = true;
        try {
          await this.addInstalledToSteam(storeId, gameId);
        } catch (err) {
          addedToSteam = false;
          const message = err instanceof Error ? err.message : String(err);
          this.log?.warn(
            `[store-bridge] addInstalledToSteam failed for imported ${gameId}: ${message}`,
          );
          this.emit?.({
            event: "pipelineEvent",
            data: {
              kind: "error",
              id: addToSteamPipelineId(storeId, gameId),
              message,
              storeId,
              gameId,
            },
          });
        }
        this.emit?.({
          event: "gameStatusChanged",
          data: {
            storeId,
            gameId,
            status: "imported",
            addedToSteam,
            title: installed.title,
          },
        });
      } finally {
        this.clearAttempt(key, attemptId);
      }
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private requireDriver(storeId: StoreId) {
    const d = getDriver(storeId);
    if (!d) throw new Error(`No driver registered for store: ${storeId}`);
    return d;
  }

  private installedCount(): number {
    let n = 0;
    for (const slice of Object.values(this.state.stores)) {
      if (slice) n += Object.keys(slice.installed).length;
    }
    return n;
  }

  /**
   * Pump pipeline events out to the frontend, optionally enriched
   * with the store + game context they belong to. Side-effects:
   * tracks every (storeId, gameId) seen in `inFlight` so the detail
   * view can re-derive its "Installing…" state after a remount.
   */
  private makeEmitter(ctx: { storeId?: StoreId; gameId?: string } = {}): (
    e: PipelineEvent,
  ) => void {
    return (e: PipelineEvent) => {
      // Update the in-flight registry first, before forwarding, so a
      // synchronous getInProgressInstall right after a "complete"
      // event sees the cleared state. Only events that carry a
      // gameId qualify — generic pipeline events (e.g. legendary
      // self-install) don't belong in the per-game registry.
      const storeId = ctx.storeId;
      const gameId = ctx.gameId;
      if (storeId && gameId) {
        const key = `${storeId}/${gameId}`;
        if (e.kind === "progress") {
          this.inFlight.set(key, {
            storeId,
            gameId,
            percent: e.percent,
            label: e.label,
          });
        } else if (e.kind === "complete" || e.kind === "error") {
          this.inFlight.delete(key);
        }
      }
      this.emit?.({ event: "pipelineEvent", data: { ...e, ...ctx } });
    };
  }

  /**
   * Returns the in-flight install for a (storeId, gameId) pair, or
   * null when nothing is running. Detail view calls this on mount
   * to repaint the "Installing…" button + progress bar without
   * waiting for the next pipelineEvent to land.
   */
  async getInProgressInstall(
    storeId: StoreId,
    gameId: string,
  ): Promise<InProgressInstall | null> {
    return this.inFlight.get(`${storeId}/${gameId}`) ?? null;
  }

  /**
   * Snapshot of every running install. Catalog view calls this on
   * mount and seeds its per-tile progress map, so leaving + coming
   * back during a long install paints the right state on first
   * render rather than waiting for the next pipelineEvent.
   */
  async getAllInProgressInstalls(): Promise<InProgressInstall[]> {
    return [...this.inFlight.values()];
  }

  private async viewForStore(storeId: StoreId): Promise<GameInfo[]> {
    const slice = this.state.stores[storeId] ?? defaultStoreState(storeId);
    const out: GameInfo[] = [];
    const installedIds = new Set(Object.keys(slice.installed));
    for (const lib of Object.values(slice.library)) {
      const installed = slice.installed[lib.id];
      out.push({
        storeId,
        id: lib.id,
        title: lib.title,
        coverUrl: lib.coverUrl,
        heroUrl: lib.heroUrl,
        logoUrl: lib.logoUrl,
        installSize: installed?.installSize ?? lib.installSize,
        status: installed
          ? installed.source === "imported"
            ? "imported"
            : "installed"
          : "library",
        installed,
        description: lib.description,
        longDescription: lib.longDescription,
        developer: lib.developer,
        publisher: lib.publisher,
        releaseDate: lib.releaseDate,
        tags: lib.tags,
        platforms: lib.platforms,
      });
    }
    // Imported titles that aren't in the library (yet) still surface,
    // so a user-side "import an old install" doesn't disappear.
    for (const installed of Object.values(slice.installed)) {
      if (installedIds.has(installed.id) && slice.library[installed.id]) continue;
      if (slice.library[installed.id]) continue;
      out.push({
        storeId,
        id: installed.id,
        title: installed.title,
        status: installed.source === "imported" ? "imported" : "installed",
        installed,
      });
    }
    out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    return out;
  }
}

// Default install dir helper re-exported so the UI can show it.
export { storeInstallDir };

/**
 * Allow-list pattern for RPC-supplied `gameId` values. Real Epic
 * AppNames are alphanumerics with optional `_` / `-` (mirrored in
 * `lib/stores/epic/legendary.ts:APP_NAME_RE`). The shape is shared
 * with the legendary argv validator so both layers reject the same
 * malicious-shape inputs.
 *
 * Anything outside this pattern is a security flag: a path-traversal
 * attempt (`../etc/passwd`), a slash that would escape the per-store
 * install root when concatenated, a control character, whitespace,
 * or an empty string. We assert at every RPC entry point that
 * eventually shovels `gameId` into a filesystem path so the
 * `rm -rf` cleanup paths in `cancelInstall` / `uninstall` can't be
 * tricked into wiping arbitrary directories.
 */
const GAME_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const GAME_ID_MAX_LEN = 128;

/**
 * Reject any `gameId` that could escape its per-store install root
 * or smuggle control characters into a subprocess. Throws — every
 * call site is at the boundary of an `await` so the throw turns
 * into a rejected promise the RPC layer surfaces as an error toast.
 *
 * The review flagged the missing gate on `cancelInstall` /
 * `installGame` / `importDetected` / `uninstallGame` as the MEDIUM
 * path-injection hole.
 */
function validateGameId(gameId: unknown): asserts gameId is string {
  if (typeof gameId !== "string") {
    throw new Error(`Invalid gameId: ${JSON.stringify(gameId)}. Must be a string.`);
  }
  if (gameId.length === 0 || gameId.length > GAME_ID_MAX_LEN) {
    throw new Error(
      `Invalid gameId: length ${gameId.length}, expected 1..${GAME_ID_MAX_LEN}.`,
    );
  }
  if (!GAME_ID_RE.test(gameId)) {
    throw new Error(
      `Invalid gameId: ${JSON.stringify(gameId)}. Expected alphanumerics, underscores or dashes (must start with alnum/underscore).`,
    );
  }
}

/**
 * Allow-list for `addScanPath` — must stay in sync with the
 * `read:` filesystem permissions declared in plugin.json. Plugin
 * host doesn't enforce those permissions at runtime, so this gate
 * is the only thing preventing a scan walker pointed at `/etc`.
 *
 * The naive prefix check is bypassable via `..` segments — e.g.
 * `/mnt/games/../etc` startsWith `/mnt/`. Node's path resolver
 * happily traverses those, and so does the kernel when `lib/scan.ts`
 * eventually `stat()`s a candidate. We resolve to absolute first,
 * THEN prefix-check — the resolution strips `..` so an attacker-
 * crafted relative segment can't escape the whitelist root.
 */
function isAllowedScanPath(rawPath: string): boolean {
  const home = process.env.HOME ?? "";
  if (!home) return false;
  const expanded = rawPath.startsWith("~/")
    ? rawPath.replace(/^~/, home)
    : rawPath;
  // Resolve normalises away `..` and `.` segments. Symlinks aren't
  // followed at this layer (no realpath) — that's intentional,
  // resolution-only is enough to close the prefix-traversal hole.
  const resolved = resolvePath(expanded);
  const roots = [
    `${home}/Games`,
    `${home}/.local/share/Heroic`,
    `${home}/.steam/steam/steamapps`,
    "/run/media",
    "/media",
    "/mnt",
  ];
  return roots.some(
    (root) => resolved === root || resolved.startsWith(`${root}/`),
  );
}
