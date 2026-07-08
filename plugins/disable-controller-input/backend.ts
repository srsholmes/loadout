import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { runFull } from "@loadout/exec";
import {
  djb2,
  parseStringProp,
  parseObjectPathArrayProp,
  pickCompositePaths,
} from "./lib/parse";

/**
 * Disable Controller Input — silences a controller by asking InputPlumber
 * to set its composite device's target list to "null". The author of
 * InputPlumber confirmed this is the canonical way to make a controller
 * invisible to Steam, the running game, and our own overlay's input
 * pipeline. This is cleaner than EVIOCGRAB on the source /dev/input/event*
 * (no kernel grab to fight, no EBUSY collisions with the overlay's
 * existing input-intercept layer).
 *
 * State on disk persists user *intent*: a device the user has disabled
 * stays remembered even when unplugged, and the silence is re-asserted
 * whenever the device reappears on the bus. The DBus state itself
 * outlives the loader process — if we crash, InputPlumber keeps the
 * silenced target until *it* restarts; on next boot we reconcile from
 * the cache.
 */

const PLUGIN_ID = "disable-controller-input";

const SERVICE = "org.shadowblip.InputPlumber";
const COMPOSITE_IFACE = "org.shadowblip.Input.CompositeDevice";
const TARGET_IFACE = "org.shadowblip.Input.Target";

// Reconcile cadence. The loop only has real work when at least one
// device is disabled — its silence must be re-asserted promptly if it
// re-appears on the bus (hotplug, InputPlumber restart). With nothing
// disabled there's nothing to re-assert, so we back off from the fast
// cadence to an idle one; this drops the bulk of the plugin's busctl
// traffic (the common case is zero disabled controllers, where it used
// to poll every 2s forever). The UI still gets fresh data on demand via
// refreshControllers(), independent of this cadence.
const RECONCILE_FAST_MS = 2_000;
const RECONCILE_IDLE_MS = 30_000;

// What we hand to SetTargetDevices to silence a controller. InputPlumber
// recognises "null" as a no-op sink kind.
const NULL_KINDS: readonly string[] = ["null"];
// What we hand back if the user enables a device for which we never
// captured a kind list (first-time disable while unplugged). Matches
// InputPlumber's typical default for a generic gamepad on a handheld.
const DEFAULT_KINDS: readonly string[] = ["xb360", "mouse", "keyboard"];

interface KnownDevice {
  /** djb2(name) — small stable id for the UI. Kept on disk so the UI
   *  can refer to a device whose DBus path has changed across
   *  reconnects. */
  hash: number;
  /** InputPlumber composite device Name. Stable across reconnects;
   *  doubles as our cache key. */
  name: string;
  /** Most recent CompositeDevice<N> path we saw for this device. The
   *  index part shifts as devices come and go, so this is just a hint —
   *  we re-resolve via the bus walk on every operation. */
  lastDbusPath: string;
  /** Wall-clock ms of the last bus walk that observed this device. */
  lastSeenMs: number;
  /** User intent — survives unplug. */
  disabled: boolean;
  /** Target kinds captured at disable time, so re-enable restores the
   *  user's prior config instead of guessing. Empty if we disabled
   *  before ever seeing the device on the bus. */
  savedKinds: string[];
}

interface State {
  version: 1;
  devices: KnownDevice[];
}

/** What `listControllers` returns to the UI. */
interface ControllerRow {
  hash: number;
  name: string;
  connected: boolean;
  disabled: boolean;
  savedKinds: string[];
}

interface ListResult {
  unavailable: boolean;
  controllers: ControllerRow[];
}

// ---------- helpers ----------

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

// Audit D-009: busctl can hang forever during an InputPlumber restart —
// the daemon is on the bus but not answering, so the call blocks until
// the system-bus default timeout (often 25s) elapses. That stalls the
// 2s reconcile loop and every UI RPC behind it. Hand `runFull` an
// explicit 5s ceiling so a stuck call fails fast and the plugin keeps
// ticking.
const BUSCTL_TIMEOUT_MS = 5000;

async function exec(cmd: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr, exitCode } = await runFull(cmd, {
      timeoutMs: BUSCTL_TIMEOUT_MS,
    });
    return { ok: exitCode === 0, stdout, stderr, code: exitCode };
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      code: -1,
    };
  }
}

function busctl(args: string[]): Promise<ExecResult> {
  return exec(["busctl", "--system", "--no-pager", ...args]);
}

// ---------- DBus wrappers ----------

async function inputPlumberAvailable(): Promise<boolean> {
  // `busctl tree <service>` returns non-zero if the service isn't
  // currently owned. `list` would also work but requires parsing.
  const r = await busctl(["tree", "--list", SERVICE]);
  return r.ok;
}

async function listCompositeDevicePaths(): Promise<string[]> {
  const r = await busctl(["tree", "--list", SERVICE]);
  if (!r.ok) return [];
  return pickCompositePaths(r.stdout);
}

async function getCompositeName(path: string): Promise<string | null> {
  const r = await busctl([
    "get-property",
    SERVICE,
    path,
    COMPOSITE_IFACE,
    "Name",
  ]);
  if (!r.ok) return null;
  return parseStringProp(r.stdout);
}

async function getTargetPaths(path: string): Promise<string[]> {
  const r = await busctl([
    "get-property",
    SERVICE,
    path,
    COMPOSITE_IFACE,
    "TargetDevices",
  ]);
  if (!r.ok) return [];
  return parseObjectPathArrayProp(r.stdout) ?? [];
}

async function getTargetKind(path: string): Promise<string | null> {
  const r = await busctl([
    "get-property",
    SERVICE,
    path,
    TARGET_IFACE,
    "DeviceType",
  ]);
  if (!r.ok) return null;
  return parseStringProp(r.stdout);
}

/** Snapshot the current target kinds for a composite device. Used right
 *  before disabling so we can restore the user's config on re-enable. */
async function getTargetKinds(compositePath: string): Promise<string[]> {
  const targetPaths = await getTargetPaths(compositePath);
  const kinds: string[] = [];
  for (const tp of targetPaths) {
    const kind = await getTargetKind(tp);
    if (kind && kind !== "null") kinds.push(kind);
  }
  return kinds;
}

async function setTargetKinds(
  compositePath: string,
  kinds: readonly string[],
): Promise<ExecResult> {
  // SetTargetDevices(as) — the busctl signature for an array of
  // strings is `as <count> <items...>`.
  const args = [
    "call",
    SERVICE,
    compositePath,
    COMPOSITE_IFACE,
    "SetTargetDevices",
    "as",
    String(kinds.length),
    ...kinds,
  ];
  return busctl(args);
}

// ---------- backend ----------

export default class DisableControllerInputBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private state: State = { version: 1, devices: [] };
  private unavailable = false;
  private reconcileTimer?: ReturnType<typeof setTimeout>;
  // Cadence the next reconcile is scheduled at. Drives the "connected"
  // freshness window so it tracks the actual poll rate (a device seen
  // within the last two ticks counts as present) instead of a fixed 2s.
  private currentIntervalMs = RECONCILE_FAST_MS;
  /**
   * `_reconcile` skip-if-busy flag — keeps the 2 s timer from piling up
   * extra ticks behind a slow walk (e.g. busctl back-pressure on a host
   * with many composite devices). RPC calls don't honour this flag; they
   * serialize via `opLock` instead.
   */
  private reconciling = false;
  /**
   * Tail of the operation queue. RPC methods (`setDisabled`,
   * `forgetController`) and `_reconcile` all run their critical sections
   * via `_serialize`, which chains onto this promise — so a reconcile
   * tick can't read stale cache state mid-RPC, and an RPC can't observe
   * the bus mid-snapshot. Resolves the race the review flagged where a
   * reconcile would re-snapshot just-re-enabled targets back into
   * `savedKinds`.
   */
  private opLock: Promise<void> = Promise.resolve();

  async onLoad(): Promise<void> {
    console.log("[disable-controller-input] Plugin loaded");

    const stored = await readPluginStorage<State>(PLUGIN_ID);
    if (stored.version === 1 && Array.isArray(stored.devices)) {
      this.state = { version: 1, devices: stored.devices };
    }

    this.unavailable = !(await inputPlumberAvailable());
    if (this.unavailable) {
      console.warn(
        "[disable-controller-input] InputPlumber service not detected on the system bus. Plugin will render an info banner.",
      );
      return;
    }

    await this._reconcile();
    this._scheduleReconcile();
  }

  /** True if the reconcile loop has work to do — i.e. at least one
   *  device the user has disabled, whose silence we must keep asserting. */
  private _hasPendingWork(): boolean {
    return this.state.devices.some((d) => d.disabled);
  }

  /** "Connected" freshness window: a device seen within the last two
   *  poll ticks counts as present. Tracks the live cadence so it stays
   *  meaningful when we back off to the idle rate. */
  private _connectedWindowMs(): number {
    return this.currentIntervalMs * 2;
  }

  /** Schedule the next reconcile, picking fast vs idle cadence from
   *  whether there's pending work. Self-reschedules after each run so the
   *  cadence re-evaluates every tick. */
  private _scheduleReconcile(): void {
    clearTimeout(this.reconcileTimer);
    this.currentIntervalMs = this._hasPendingWork()
      ? RECONCILE_FAST_MS
      : RECONCILE_IDLE_MS;
    this.reconcileTimer = setTimeout(() => {
      this._reconcile()
        .catch((e) =>
          console.error("[disable-controller-input] reconcile error:", e),
        )
        .finally(() => this._scheduleReconcile());
    }, this.currentIntervalMs);
  }

  async onUnload(): Promise<void> {
    clearTimeout(this.reconcileTimer);
    // Deliberately do NOT release silenced devices — the whole point is
    // for the silence to persist across plugin reloads. Cache on disk
    // is the source of truth; next onLoad reconciles.
    console.log("[disable-controller-input] Plugin unloaded");
  }

  // ---------- RPC ----------

  async listControllers(): Promise<ListResult> {
    if (this.unavailable) {
      return {
        unavailable: true,
        controllers: this.state.devices.map((d) => ({
          hash: d.hash,
          name: d.name,
          connected: false,
          disabled: d.disabled,
          savedKinds: d.savedKinds,
        })),
      };
    }
    // Cheap: just project the cache. Reconcile keeps it warm.
    return {
      unavailable: false,
      controllers: this.state.devices.map((d) => ({
        hash: d.hash,
        name: d.name,
        // Heuristic: a device is "connected" if reconcile observed it
        // within the last two ticks. Avoids a per-call bus walk.
        connected: Date.now() - d.lastSeenMs < this._connectedWindowMs(),
        disabled: d.disabled,
        savedKinds: d.savedKinds,
      })),
    };
  }

  async refreshControllers(): Promise<ListResult> {
    if (!this.unavailable) await this._reconcile();
    return this.listControllers();
  }

  async setDisabled(
    hash: number,
    disabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    return this._serialize(async () => {
      const dev = this.state.devices.find((d) => d.hash === hash);
      if (!dev) return { ok: false, error: "Unknown device" };

      const connected =
        Date.now() - dev.lastSeenMs < this._connectedWindowMs();

      if (disabled) {
        if (connected) {
          const kinds = await getTargetKinds(dev.lastDbusPath);
          if (kinds.length > 0) dev.savedKinds = kinds;
          const r = await setTargetKinds(dev.lastDbusPath, NULL_KINDS);
          if (!r.ok) {
            return {
              ok: false,
              error: `SetTargetDevices failed: ${r.stderr.trim() || `exit ${r.code}`}`,
            };
          }
        }
        dev.disabled = true;
      } else {
        if (connected) {
          const kinds = dev.savedKinds.length > 0 ? dev.savedKinds : DEFAULT_KINDS;
          const r = await setTargetKinds(dev.lastDbusPath, kinds);
          if (!r.ok) {
            return {
              ok: false,
              error: `SetTargetDevices failed: ${r.stderr.trim() || `exit ${r.code}`}`,
            };
          }
        }
        dev.disabled = false;
      }

      await this._persist();
      // Disabling/enabling changes whether the loop has work — re-pick
      // the cadence now instead of waiting up to a full idle interval.
      this._scheduleReconcile();
      this.emit?.({ event: "controllersChanged", data: undefined });
      return { ok: true };
    });
  }

  async forgetController(
    hash: number,
  ): Promise<{ ok: boolean; error?: string }> {
    return this._serialize(async () => {
      const idx = this.state.devices.findIndex((d) => d.hash === hash);
      if (idx === -1) return { ok: false, error: "Unknown device" };
      const dev = this.state.devices[idx];
      if (!dev) return { ok: false, error: "Unknown device" };

      // Don't strand a silenced target on the bus. Re-enable first if
      // the device is reachable. If the re-enable busctl call itself
      // fails, log it — the device drops from the cache regardless
      // (the user asked us to forget it), but the orphaned silenced
      // target stays on the bus until InputPlumber restarts. Surfacing
      // that in the journal is the only way an operator can tell
      // something needs cleanup.
      const connected =
        !this.unavailable &&
        Date.now() - dev.lastSeenMs < this._connectedWindowMs();
      if (dev.disabled && connected) {
        const kinds = dev.savedKinds.length > 0 ? dev.savedKinds : DEFAULT_KINDS;
        const r = await setTargetKinds(dev.lastDbusPath, kinds);
        if (!r.ok) {
          console.warn(
            `[disable-controller-input] forget: re-enable failed for ${dev.name}; silenced target may remain on the bus until InputPlumber restarts: ${r.stderr.trim() || `exit ${r.code}`}`,
          );
        }
      }

      this.state.devices.splice(idx, 1);
      await this._persist();
      // Forgetting a disabled device may remove the loop's last bit of
      // work — re-pick the cadence.
      this._scheduleReconcile();
      this.emit?.({ event: "controllersChanged", data: undefined });
      return { ok: true };
    });
  }

  // ---------- internals ----------

  private async _persist(): Promise<void> {
    await writePluginStorage<State>(PLUGIN_ID, this.state);
  }

  /**
   * Run `fn` as the sole holder of the operation lock. The next caller
   * waits on the promise we publish to `opLock`. We swap `opLock`
   * before awaiting the previous tail so the queue chains correctly
   * even if multiple callers arrive synchronously.
   */
  private async _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.opLock;
    let release!: () => void;
    this.opLock = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Walk the bus, merge fresh observations into the cache, and
   *  re-assert silence on any cached `disabled: true` device that has
   *  just reappeared. */
  private async _reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      await this._serialize(async () => {
      // Re-check service availability cheaply — the daemon may have
      // come up since onLoad.
      if (this.unavailable) {
        this.unavailable = !(await inputPlumberAvailable());
        if (this.unavailable) return;
        console.log(
          "[disable-controller-input] InputPlumber service detected — resuming",
        );
      }

      const paths = await listCompositeDevicePaths();

      let dirty = false;
      let topologyChanged = false;
      const seenHashes = new Set<number>();
      const now = Date.now();

      for (const path of paths) {
        const name = await getCompositeName(path);
        if (!name) continue;
        const hash = djb2(name);
        seenHashes.add(hash);

        let dev = this.state.devices.find((d) => d.hash === hash);
        if (!dev) {
          dev = {
            hash,
            name,
            lastDbusPath: path,
            lastSeenMs: now,
            disabled: false,
            savedKinds: [],
          };
          this.state.devices.push(dev);
          dirty = true;
          topologyChanged = true;
        } else {
          if (dev.lastDbusPath !== path) {
            dev.lastDbusPath = path;
            dirty = true;
          }
          // lastSeenMs always changes — track topology separately so we
          // don't churn disk every 2 s when nothing meaningful moved.
          if (now - dev.lastSeenMs > this._connectedWindowMs()) {
            // Was previously offline; transition is interesting.
            topologyChanged = true;
          }
          dev.lastSeenMs = now;
        }

        // Re-assert silence if user intent says disabled.
        if (dev.disabled) {
          const currentTargets = await getTargetPaths(path);
          // If targets are non-empty and at least one is non-"null",
          // the daemon has restored defaults (e.g. across an
          // InputPlumber restart). Snapshot them, then silence.
          if (currentTargets.length > 0) {
            const liveKinds: string[] = [];
            for (const tp of currentTargets) {
              const kind = await getTargetKind(tp);
              if (kind && kind !== "null") liveKinds.push(kind);
            }
            if (liveKinds.length > 0) {
              dev.savedKinds = liveKinds;
              dirty = true;
              const r = await setTargetKinds(path, NULL_KINDS);
              if (!r.ok) {
                console.warn(
                  `[disable-controller-input] re-silence failed for ${name}: ${r.stderr.trim() || r.code}`,
                );
              }
            }
          }
        }
      }

      // Mark devices that vanished — we keep them in the cache (the
      // user's intent persists), but emit if any flipped offline.
      for (const dev of this.state.devices) {
        if (
          !seenHashes.has(dev.hash) &&
          now - dev.lastSeenMs < this._connectedWindowMs()
        ) {
          // Just-vanished. Don't touch lastSeenMs — letting it age out
          // naturally is what the `connected` heuristic relies on.
          topologyChanged = true;
        }
      }

      if (dirty) await this._persist();
      if (topologyChanged) {
        this.emit?.({ event: "controllersChanged", data: undefined });
      }
      });
    } finally {
      this.reconciling = false;
    }
  }
}
