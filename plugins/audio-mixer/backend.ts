import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { runFull, commandExists } from "@loadout/exec";
import {
  createPerGameEngine,
  createPluginStoragePersistence,
  type PerGameEngine,
} from "@loadout/per-game-profiles";
import {
  buildMixerState,
  mixerChanged,
  type AudioDevice,
  type AudioStream,
  type DeviceKind,
  type MixerState,
  type PwObject,
  type StreamKind,
} from "./lib/mixer-state";

// Re-export the RPC-visible types so existing import sites (and the
// UI in `app.tsx`) can keep pulling them from the backend module.
export type { AudioDevice, AudioStream, DeviceKind, MixerState, StreamKind };

const PLUGIN_ID = "audio-mixer";

interface SavedAppVolume {
  volume: number;
  muted: boolean;
}

/** The part of a per-game audio profile that the engine treats as payload. */
export interface AudioProfilePayload {
  /** Stable PipeWire `node.name` of the desired default sink (e.g.
   *  "bluez_output.AC_..."). Resolved to a numeric id at launch time. */
  defaultSinkName?: string;
  /** Linear master volume 0.0 – 1.5 to apply to the default sink. */
  masterVolume?: number;
}

/** Public RPC shape — engine entry flattened. */
export interface AudioGameProfile extends AudioProfilePayload {
  appId: number;
  gameName: string;
}

interface PersistedState {
  /** Per-app stream settings keyed by `application.name`. */
  apps: Record<string, SavedAppVolume>;
}

function toRpcProfile(entry: {
  appId: number;
  gameName: string;
  payload: AudioProfilePayload;
}): AudioGameProfile {
  return {
    appId: entry.appId,
    gameName: entry.gameName,
    defaultSinkName: entry.payload.defaultSinkName,
    masterVolume: entry.payload.masterVolume,
  };
}

interface AudioGameSnapshot {
  defaultSinkName: string | null;
  masterVolume: number | null;
}

// ---------------------------------------------------------------------------
// Backend implementation
// ---------------------------------------------------------------------------

export default class AudioMixerBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private available = false;
  private unavailableReason: string | null = null;
  private pollInterval?: Timer;
  private lastSnapshot: MixerState | null = null;

  // Persisted per-app settings keyed by application.name. Loaded once at
  // startup; mutated whenever the user changes a stream's volume or mute.
  private apps: Record<string, SavedAppVolume> = {};

  // Stream IDs (PipeWire object ids) we've already pushed saved values
  // onto. Reset when a stream id disappears so reconnects re-restore.
  private restoredStreamIds = new Set<number>();

  // Per-game state. The engine owns the {profiles, perGameEnabled,
  // snapshot, boundAppId} state machine and persists alongside `apps`
  // in the same plugin-storage file (createPluginStoragePersistence
  // does the read-merge-write so `apps` survives every save).
  private profileEngine: PerGameEngine<AudioProfilePayload> = createPerGameEngine<
    AudioProfilePayload,
    AudioGameSnapshot
  >({
    persistence: createPluginStoragePersistence(PLUGIN_ID),
    guard: () => this.available,
    onSnapshot: () => this.captureGameSnapshot(),
    onApply: async (payload, ctx) => {
      await this.applyGameProfile(payload, ctx);
    },
    onRestore: async (snap) => {
      await this.restoreGameSnapshot(snap);
    },
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async onLoad(): Promise<void> {
    const [hasWpctl, hasPwDump] = await Promise.all([
      commandExists("wpctl"),
      commandExists("pw-dump"),
    ]);

    if (!hasWpctl || !hasPwDump) {
      this.available = false;
      this.unavailableReason = !hasWpctl
        ? "wpctl not found (install wireplumber)"
        : "pw-dump not found (install pipewire)";
      console.warn(`[audio-mixer] ${this.unavailableReason}`);
      return;
    }

    this.available = true;
    this.unavailableReason = null;

    // Load persisted per-app volumes before priming, so the first
    // snapshot already restores any apps that are running at startup.
    const stored = await readPluginStorage<PersistedState>(PLUGIN_ID);
    this.apps = stored.apps ?? {};
    // Per-game state is loaded by the engine from the same file.
    await this.profileEngine.load();

    // Prime once, replay saved values for any app stream already up,
    // and re-snapshot if anything was restored so callers see the
    // post-restore values immediately.
    let primed = await this.snapshot();
    if (await this.applySavedToStreams(primed)) {
      primed = await this.snapshot();
    }
    this.lastSnapshot = primed;

    // Audit F-005: was polling every 1s, which burned a wpctl + pw-dump
    // pair every second even with no subscribers. 2s halves that cost
    // and is still well under any human-perceptible mixer-update latency
    // (sliders + per-app volumes don't change faster than the user can
    // drag them).
    this.pollInterval = setInterval(() => {
      this.poll().catch((e) =>
        console.error(`[audio-mixer] Poll error:`, e),
      );
    }, 2000);

    console.log("[audio-mixer] Loaded");
  }

  async onUnload(): Promise<void> {
    if (this.pollInterval) clearInterval(this.pollInterval);
    console.log("[audio-mixer] Unloaded");
  }

  // -----------------------------------------------------------------------
  // RPC
  // -----------------------------------------------------------------------

  /** Get the full mixer state. */
  async getMixerState(): Promise<MixerState> {
    if (!this.available) {
      return {
        available: false,
        unavailableReason: this.unavailableReason,
        sinks: [],
        sources: [],
        playbackStreams: [],
        recordingStreams: [],
      };
    }
    const state = await this.snapshot();
    this.lastSnapshot = state;
    return state;
  }

  /** Set linear volume (0.0 – 1.5) on any node id (device or stream). */
  async setVolume(
    id: number,
    volume: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.available) {
      return { success: false, error: "Audio mixer unavailable" };
    }
    const res = await this._writeVolume(id, volume);
    if (!res.success) return res;
    // Push fresh snapshot so the UI sees the change immediately.
    void this.poll();
    return res;
  }

  /** Lower-level volume write — no follow-up poll. Used by
   *  applyGameProfile to avoid a redundant poll round on game launch. */
  private async _writeVolume(
    id: number,
    volume: number,
  ): Promise<{ success: boolean; error?: string }> {
    const clamped = Math.max(0, Math.min(1.5, volume));
    const { exitCode, stderr } = await runFull([
      "wpctl",
      "set-volume",
      String(id),
      clamped.toFixed(3),
    ]);
    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "wpctl failed" };
    }
    await this.persistAppForId(id, { volume: clamped });
    return { success: true };
  }

  /** Mute/unmute / toggle on any node id. */
  async setMute(
    id: number,
    mute: boolean | "toggle",
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.available) {
      return { success: false, error: "Audio mixer unavailable" };
    }
    // Resolve the resulting mute state from the last snapshot so we can
    // persist a concrete bool even when the caller sent "toggle".
    let resolvedMute: boolean | null = null;
    if (mute === "toggle") {
      const stream = this._streamForId(id);
      if (stream) resolvedMute = !stream.muted;
    } else {
      resolvedMute = mute;
    }

    const arg = mute === "toggle" ? "toggle" : mute ? "1" : "0";
    const { exitCode, stderr } = await runFull([
      "wpctl",
      "set-mute",
      String(id),
      arg,
    ]);
    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "wpctl failed" };
    }
    if (resolvedMute !== null) {
      await this.persistAppForId(id, { muted: resolvedMute });
    }
    void this.poll();
    return { success: true };
  }

  /** Make this sink (or source) the system default. */
  async setDefault(
    id: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.available) {
      return { success: false, error: "Audio mixer unavailable" };
    }
    const res = await this._writeDefault(id);
    if (!res.success) return res;
    void this.poll();
    return res;
  }

  /** Lower-level default-sink write — no follow-up poll. */
  private async _writeDefault(
    id: number,
  ): Promise<{ success: boolean; error?: string }> {
    const { exitCode, stderr } = await runFull([
      "wpctl",
      "set-default",
      String(id),
    ]);
    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "wpctl failed" };
    }
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // Snapshot + polling
  // -----------------------------------------------------------------------

  private async snapshot(): Promise<MixerState> {
    const [dumpResult, statusResult] = await Promise.all([
      runFull(["pw-dump", "--no-colors"]),
      runFull(["wpctl", "status"]),
    ]);

    if (dumpResult.exitCode !== 0) {
      return {
        available: false,
        unavailableReason: `pw-dump failed: ${dumpResult.stderr.trim()}`,
        sinks: [],
        sources: [],
        playbackStreams: [],
        recordingStreams: [],
      };
    }

    let dump: PwObject[];
    try {
      dump = JSON.parse(dumpResult.stdout) as PwObject[];
    } catch (e) {
      return {
        available: false,
        unavailableReason: `pw-dump returned invalid JSON: ${e}`,
        sinks: [],
        sources: [],
        playbackStreams: [],
        recordingStreams: [],
      };
    }

    return buildMixerState(dump, statusResult.stdout);
  }

  private async poll(): Promise<void> {
    let next = await this.snapshot();
    // Replay saved volumes for any stream we haven't restored yet.
    // If anything was applied, re-snapshot so subscribers see the
    // post-restore values rather than the pre-restore ones.
    if (await this.applySavedToStreams(next)) {
      next = await this.snapshot();
    }
    if (!this.lastSnapshot || mixerChanged(this.lastSnapshot, next)) {
      this.lastSnapshot = next;
      this.emit?.({ event: "mixerChanged", data: next });
    }
  }

  // -----------------------------------------------------------------------
  // Persistence helpers
  // -----------------------------------------------------------------------

  /** Find a stream by PipeWire object id in the most recent snapshot.
   *  Underscore prefix is the contract marker that keeps it off the RPC wire. */
  _streamForId(id: number): AudioStream | null {
    if (!this.lastSnapshot) return null;
    return (
      [
        ...this.lastSnapshot.playbackStreams,
        ...this.lastSnapshot.recordingStreams,
      ].find((s) => s.id === id) ?? null
    );
  }

  /**
   * If the given node id corresponds to an app stream, merge the patch
   * into the persisted entry for that app and write to disk. Calls
   * targeting devices (sinks/sources) are silently ignored — WirePlumber
   * already persists those natively.
   *
   * Defensive: if `lastSnapshot` hasn't been primed yet (a setVolume races
   * onLoad), take a single inline snapshot rather than persisting with an
   * empty app name (which would write apps[""] garbage).
   */
  private async persistAppForId(
    id: number,
    patch: Partial<SavedAppVolume>,
  ): Promise<void> {
    if (this.lastSnapshot === null) {
      this.lastSnapshot = await this.snapshot();
    }
    const stream = this._streamForId(id);
    if (!stream || !stream.appName) return;
    const prev = this.apps[stream.appName] ?? {
      volume: stream.volume,
      muted: stream.muted,
    };
    this.apps[stream.appName] = { ...prev, ...patch };
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      // Read-merge-write so the engine's perGameEnabled + gameProfiles
      // keys (written separately) survive every apps update.
      const existing = await readPluginStorage<Record<string, unknown>>(
        PLUGIN_ID,
      );
      await writePluginStorage(PLUGIN_ID, {
        ...existing,
        apps: this.apps,
      });
    } catch (e) {
      console.warn("[audio-mixer] persist failed:", e);
    }
  }

  /**
   * For each app stream we haven't restored yet, push the saved volume
   * + mute via wpctl. Tracks restored ids so we don't fight the user
   * if they later move the slider. Forgets ids that have disappeared
   * so reconnects re-restore. Returns true iff any wpctl call ran, so
   * callers can re-snapshot.
   */
  private async applySavedToStreams(state: MixerState): Promise<boolean> {
    let restored = false;
    const seen = new Set<number>();
    const allStreams = [...state.playbackStreams, ...state.recordingStreams];

    for (const stream of allStreams) {
      seen.add(stream.id);
      if (this.restoredStreamIds.has(stream.id)) continue;
      if (!stream.appName) continue;
      const saved = this.apps[stream.appName];
      if (!saved) continue;

      // Apply only when the live value differs — avoids spamming wpctl
      // on every reconnect when state is already correct.
      if (Math.abs(stream.volume - saved.volume) > 0.001) {
        const r = await runFull([
          "wpctl",
          "set-volume",
          String(stream.id),
          saved.volume.toFixed(3),
        ]);
        if (r.exitCode === 0) restored = true;
      }
      if (stream.muted !== saved.muted) {
        const r = await runFull([
          "wpctl",
          "set-mute",
          String(stream.id),
          saved.muted ? "1" : "0",
        ]);
        if (r.exitCode === 0) restored = true;
      }
      this.restoredStreamIds.add(stream.id);
    }

    // Drop ids whose streams have gone away; PipeWire reuses ids freely
    // so we want to restore again next time we see one.
    for (const id of [...this.restoredStreamIds]) {
      if (!seen.has(id)) this.restoredStreamIds.delete(id);
    }

    return restored;
  }

  // -----------------------------------------------------------------------
  // Per-game profiles
  // -----------------------------------------------------------------------

  async getPerGameEnabled(): Promise<boolean> {
    return this.profileEngine.isPerGameEnabled();
  }

  async setPerGameEnabled(
    enabled: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    await this.profileEngine.setPerGameEnabled(Boolean(enabled));
    this.emit?.({
      event: "perGameEnabledChanged",
      data: { enabled: this.profileEngine.isPerGameEnabled() },
    });
    return { success: true };
  }

  async getGameProfiles(): Promise<AudioGameProfile[]> {
    return this.profileEngine.getProfiles().map(toRpcProfile);
  }

  async getGameProfile(appId: number): Promise<AudioGameProfile | null> {
    const found = this.profileEngine.getProfile(appId);
    return found ? toRpcProfile(found) : null;
  }

  async setGameProfile(
    appId: number,
    gameName: string,
    profile: { defaultSinkName?: string; masterVolume?: number },
  ): Promise<{ success: boolean; error?: string }> {
    if (typeof appId !== "number" || !Number.isFinite(appId)) {
      return { success: false, error: "Invalid appId" };
    }
    // Merge with the existing entry so partial updates (just masterVolume,
    // just defaultSinkName) leave the other field alone — matches the
    // pre-engine behaviour.
    const existing = this.profileEngine.getProfile(appId);
    const payload: AudioProfilePayload = {
      defaultSinkName:
        typeof profile.defaultSinkName === "string"
          ? profile.defaultSinkName
          : existing?.payload.defaultSinkName,
      masterVolume:
        typeof profile.masterVolume === "number"
          ? Math.max(0, Math.min(1.5, profile.masterVolume))
          : existing?.payload.masterVolume,
    };
    const next = await this.profileEngine.setProfile(
      appId,
      gameName ?? "",
      payload,
    );
    this.emit?.({
      event: "gameProfileChanged",
      data: { appId, profile: toRpcProfile(next) },
    });
    return { success: true };
  }

  async removeGameProfile(
    appId: number,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.profileEngine.getProfile(appId)) {
      await this.profileEngine.removeProfile(appId);
      this.emit?.({
        event: "gameProfileChanged",
        data: { appId, profile: null },
      });
    }
    return { success: true };
  }

  async handleGameLaunch(appId: number, gameName: string): Promise<void> {
    await this.profileEngine.handleGameLaunch(appId, gameName);
  }

  async handleGameExit(appId: number): Promise<void> {
    await this.profileEngine.handleGameExit(appId);
  }

  /** Snapshot the audio device state the engine needs to restore on exit. */
  private async captureGameSnapshot(): Promise<AudioGameSnapshot> {
    const state = await this.snapshot();
    this.lastSnapshot = state;
    const currentDefault = state.sinks.find((s) => s.isDefault) ?? null;
    return {
      defaultSinkName: currentDefault?.nodeName ?? null,
      masterVolume: currentDefault?.volume ?? null,
    };
  }

  /** Apply a per-game audio profile. Engine handles bound-app bookkeeping.
   *
   *  Uses the lower-level `_writeVolume` / `_writeDefault` paths so we don't
   *  trigger the public `setVolume`/`setDefault` post-poll — that would race
   *  the snapshot we already have in flight and burn an extra pw-dump pair.
   *  We emit a single `mixerChanged` at the end instead.
   *
   *  If the stored `defaultSinkName` no longer exists (e.g. user unplugged
   *  the bluetooth headset they bound the profile to), emit a
   *  `staleSinkProfile` event so the UI can prompt the user to re-pick. */
  private async applyGameProfile(
    payload: AudioProfilePayload,
    ctx: { appId: number; gameName: string },
  ): Promise<void> {
    const state = this.lastSnapshot ?? (await this.snapshot());
    this.lastSnapshot = state;

    if (payload.defaultSinkName) {
      const target = state.sinks.find(
        (s) => s.nodeName === payload.defaultSinkName,
      );
      if (target) {
        await this._writeDefault(target.id);
      } else {
        console.warn(
          `[audio-mixer] Per-game default sink "${payload.defaultSinkName}" not found for ${ctx.gameName || `App ${ctx.appId}`}`,
        );
        this.emit?.({
          event: "staleSinkProfile",
          data: {
            appId: ctx.appId,
            gameName: ctx.gameName,
            missingSinkName: payload.defaultSinkName,
          },
        });
      }
    }
    if (typeof payload.masterVolume === "number") {
      // Re-resolve default sink after the (possibly new) setDefault took
      // effect. Cheap: one pw-dump pair.
      const post = await this.snapshot();
      this.lastSnapshot = post;
      const sink = post.sinks.find((s) => s.isDefault);
      if (sink) {
        await this._writeVolume(sink.id, payload.masterVolume);
      }
    }
    // Single fan-out to subscribers instead of one poll per write.
    void this.poll();
  }

  /** Restore the pre-game audio device state from the engine snapshot.
   *  Uses the lower-level write paths to skip per-write polls; single
   *  fan-out poll at the end. */
  private async restoreGameSnapshot(snap: AudioGameSnapshot): Promise<void> {
    const state = await this.snapshot();
    this.lastSnapshot = state;

    if (snap.defaultSinkName) {
      const target = state.sinks.find(
        (s) => s.nodeName === snap.defaultSinkName,
      );
      if (target) {
        await this._writeDefault(target.id);
      }
    }
    if (typeof snap.masterVolume === "number") {
      const post = await this.snapshot();
      this.lastSnapshot = post;
      const sink = post.sinks.find((s) => s.isDefault);
      if (sink) {
        await this._writeVolume(sink.id, snap.masterVolume);
      }
    }
    void this.poll();
  }
}
