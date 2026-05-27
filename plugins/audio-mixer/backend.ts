import type { PluginBackend, EmitPayload } from "@loadout/types";
import {
  readPluginStorage,
  writePluginStorage,
} from "@loadout/plugin-storage";
import { runFull as runShared, commandExists } from "@loadout/exec";
import {
  createPerGameEngine,
  createPluginStoragePersistence,
  type PerGameEngine,
} from "@loadout/per-game-profiles";

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
// Types exposed via RPC
// ---------------------------------------------------------------------------

export type StreamKind = "playback" | "recording";
export type DeviceKind = "sink" | "source";

export interface AudioStream {
  /** PipeWire object id. */
  id: number;
  /** Best human label we can produce: app name → media name → node name. */
  label: string;
  /** application.name from pw properties (may be empty). */
  appName: string;
  /** Window/icon hint (application.icon-name). */
  iconName: string | null;
  /** media.name (track / stream title) when present. */
  mediaName: string | null;
  /** 0.0 – 1.5 (cubed-volume aware: we always read & write the linear value). */
  volume: number;
  muted: boolean;
  kind: StreamKind;
}

export interface AudioDevice {
  id: number;
  /** Stable PipeWire node.name (used to address this device across sessions). */
  nodeName: string;
  label: string;
  description: string;
  isDefault: boolean;
  volume: number;
  muted: boolean;
  kind: DeviceKind;
}

export interface MixerState {
  /** Whether wpctl/pw-dump are available on this system. */
  available: boolean;
  /** Reason if not available. */
  unavailableReason: string | null;
  sinks: AudioDevice[];
  sources: AudioDevice[];
  playbackStreams: AudioStream[];
  recordingStreams: AudioStream[];
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

// Thin alias kept so the existing call sites read naturally.
const run = (args: string[]) => runShared(args);

// ---------------------------------------------------------------------------
// pw-dump JSON parsing
// ---------------------------------------------------------------------------

interface PwObject {
  id: number;
  type: string;
  info?: {
    props?: Record<string, unknown>;
    params?: { Props?: PwPropsParam[] };
    state?: string;
  };
}

interface PwPropsParam {
  volume?: number;
  mute?: boolean;
  channelVolumes?: number[];
}

/**
 * PipeWire stores volumes as a "cubed" scalar internally for nodes
 * (params.Props[0].volume). The user-facing linear volume that wpctl
 * shows is volume^(1/3). We expose the linear value and convert when
 * writing to wpctl (which itself takes linear).
 */
function cubedToLinear(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.cbrt(v);
}

function pickProp(props: Record<string, unknown> | undefined, key: string): string {
  if (!props) return "";
  const v = props[key];
  return typeof v === "string" ? v : "";
}

function deviceLabel(props: Record<string, unknown> | undefined): {
  label: string;
  description: string;
} {
  const desc = pickProp(props, "node.description");
  const nick = pickProp(props, "node.nick");
  const name = pickProp(props, "node.name");
  const label = desc || nick || name || "Unknown device";
  return { label, description: desc || nick || "" };
}

function streamLabel(props: Record<string, unknown> | undefined): {
  label: string;
  appName: string;
  iconName: string | null;
  mediaName: string | null;
} {
  const appName = pickProp(props, "application.name");
  const mediaName = pickProp(props, "media.name");
  const nodeName = pickProp(props, "node.name");
  const iconName = pickProp(props, "application.icon-name") || null;
  const label = appName || mediaName || nodeName || "Audio Stream";
  return {
    label,
    appName,
    iconName,
    mediaName: mediaName || null,
  };
}

function readNodeVolume(node: PwObject): { volume: number; muted: boolean } {
  const params = node.info?.params?.Props;
  if (!params || params.length === 0) {
    return { volume: 1, muted: false };
  }
  const p = params[0];
  // Prefer channelVolumes[0] (matches what wpctl reports per-channel)
  const cv =
    Array.isArray(p.channelVolumes) && p.channelVolumes.length > 0
      ? p.channelVolumes[0]
      : typeof p.volume === "number"
        ? p.volume
        : 1;
  return {
    volume: cubedToLinear(cv),
    muted: p.mute === true,
  };
}

// ---------------------------------------------------------------------------
// Default-id parsing (from `wpctl status`)
// ---------------------------------------------------------------------------

/**
 * `wpctl status` marks the default sink/source with a leading "*". We parse
 * just those marker rows, then look up the matching node id in the pw-dump
 * snapshot, since pw-dump itself doesn't expose the default-id flag.
 */
function parseDefaults(wpctlStatus: string): {
  defaultSinkId: number | null;
  defaultSourceId: number | null;
} {
  const lines = wpctlStatus.split("\n");
  let section: "none" | "sinks" | "sources" = "none";
  let defaultSinkId: number | null = null;
  let defaultSourceId: number | null = null;

  for (const line of lines) {
    if (/Sinks:/.test(line)) {
      section = "sinks";
      continue;
    }
    if (/Sources:/.test(line)) {
      section = "sources";
      continue;
    }
    if (/^\s*├─|^\s*└─|^\s*Audio|^\s*Video/.test(line) && !/Sinks:|Sources:/.test(line)) {
      // section header for something else — leave only if we've parsed past
      if (/(Sink Endpoints|Source Endpoints|Streams|Filters|Devices|Clients|Video)/.test(line)) {
        section = "none";
      }
    }

    // Default rows look like: " │  *   42. ...". Match an id following a "*".
    const match = line.match(/\*\s+(\d+)\./);
    if (!match) continue;
    const id = Number(match[1]);
    if (Number.isNaN(id)) continue;
    if (section === "sinks" && defaultSinkId === null) defaultSinkId = id;
    if (section === "sources" && defaultSourceId === null) defaultSourceId = id;
  }

  return { defaultSinkId, defaultSourceId };
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
    const clamped = Math.max(0, Math.min(1.5, volume));
    const { exitCode, stderr } = await run([
      "wpctl",
      "set-volume",
      String(id),
      clamped.toFixed(3),
    ]);
    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "wpctl failed" };
    }
    await this.persistAppForId(id, { volume: clamped });
    // Push fresh snapshot so the UI sees the change immediately.
    void this.poll();
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
      const stream = this.streamForId(id);
      if (stream) resolvedMute = !stream.muted;
    } else {
      resolvedMute = mute;
    }

    const arg = mute === "toggle" ? "toggle" : mute ? "1" : "0";
    const { exitCode, stderr } = await run([
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
    const { exitCode, stderr } = await run(["wpctl", "set-default", String(id)]);
    if (exitCode !== 0) {
      return { success: false, error: stderr.trim() || "wpctl failed" };
    }
    void this.poll();
    return { success: true };
  }

  // -----------------------------------------------------------------------
  // Snapshot + polling
  // -----------------------------------------------------------------------

  private async snapshot(): Promise<MixerState> {
    const [dumpResult, statusResult] = await Promise.all([
      run(["pw-dump", "--no-colors"]),
      run(["wpctl", "status"]),
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

    const { defaultSinkId, defaultSourceId } = parseDefaults(statusResult.stdout);

    const sinks: AudioDevice[] = [];
    const sources: AudioDevice[] = [];
    const playbackStreams: AudioStream[] = [];
    const recordingStreams: AudioStream[] = [];

    for (const obj of dump) {
      if (obj.type !== "PipeWire:Interface:Node") continue;
      const props = obj.info?.props;
      const mediaClass = pickProp(props, "media.class");
      if (!mediaClass) continue;

      const { volume, muted } = readNodeVolume(obj);

      if (mediaClass === "Audio/Sink") {
        const { label, description } = deviceLabel(props);
        const nodeName = pickProp(props, "node.name");
        sinks.push({
          id: obj.id,
          nodeName,
          label,
          description,
          isDefault: obj.id === defaultSinkId,
          volume,
          muted,
          kind: "sink",
        });
      } else if (mediaClass === "Audio/Source") {
        // Ignore monitor nodes by default — they appear as "Audio/Source"
        // with node.name suffix ".monitor". Users want real mic inputs here.
        const nodeName = pickProp(props, "node.name");
        if (nodeName.endsWith(".monitor")) continue;
        const { label, description } = deviceLabel(props);
        sources.push({
          id: obj.id,
          nodeName,
          label,
          description,
          isDefault: obj.id === defaultSourceId,
          volume,
          muted,
          kind: "source",
        });
      } else if (mediaClass === "Stream/Output/Audio") {
        const { label, appName, iconName, mediaName } = streamLabel(props);
        playbackStreams.push({
          id: obj.id,
          label,
          appName,
          iconName,
          mediaName,
          volume,
          muted,
          kind: "playback",
        });
      } else if (mediaClass === "Stream/Input/Audio") {
        const { label, appName, iconName, mediaName } = streamLabel(props);
        recordingStreams.push({
          id: obj.id,
          label,
          appName,
          iconName,
          mediaName,
          volume,
          muted,
          kind: "recording",
        });
      }
    }

    // Stable order: defaults first, then alphabetical
    const sortDevices = (a: AudioDevice, b: AudioDevice) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.label.localeCompare(b.label);
    };
    sinks.sort(sortDevices);
    sources.sort(sortDevices);
    playbackStreams.sort((a, b) => a.label.localeCompare(b.label));
    recordingStreams.sort((a, b) => a.label.localeCompare(b.label));

    return {
      available: true,
      unavailableReason: null,
      sinks,
      sources,
      playbackStreams,
      recordingStreams,
    };
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

  /** Find a stream by PipeWire object id in the most recent snapshot. */
  private streamForId(id: number): AudioStream | null {
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
   */
  private async persistAppForId(
    id: number,
    patch: Partial<SavedAppVolume>,
  ): Promise<void> {
    const stream = this.streamForId(id);
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
      const existing = await readPluginStorage<Record<string, unknown>>(PLUGIN_ID);
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
        const r = await run([
          "wpctl",
          "set-volume",
          String(stream.id),
          saved.volume.toFixed(3),
        ]);
        if (r.exitCode === 0) restored = true;
      }
      if (stream.muted !== saved.muted) {
        const r = await run([
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
      this.emit?.({ event: "gameProfileChanged", data: { appId, profile: null } });
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

  /** Apply a per-game audio profile. Engine handles bound-app bookkeeping. */
  private async applyGameProfile(
    payload: AudioProfilePayload,
    ctx: { appId: number; gameName: string },
  ): Promise<void> {
    const state = this.lastSnapshot ?? (await this.snapshot());
    this.lastSnapshot = state;

    if (payload.defaultSinkName) {
      const target = state.sinks.find((s) => s.nodeName === payload.defaultSinkName);
      if (target) {
        await this.setDefault(target.id);
      } else {
        console.warn(
          `[audio-mixer] Per-game default sink "${payload.defaultSinkName}" not found for ${ctx.gameName || `App ${ctx.appId}`}`,
        );
      }
    }
    if (typeof payload.masterVolume === "number") {
      const post = await this.snapshot();
      this.lastSnapshot = post;
      const sink = post.sinks.find((s) => s.isDefault);
      if (sink) {
        await this.setVolume(sink.id, payload.masterVolume);
      }
    }
  }

  /** Restore the pre-game audio device state from the engine snapshot. */
  private async restoreGameSnapshot(snap: AudioGameSnapshot): Promise<void> {
    const state = await this.snapshot();
    this.lastSnapshot = state;

    if (snap.defaultSinkName) {
      const target = state.sinks.find((s) => s.nodeName === snap.defaultSinkName);
      if (target) {
        await this.setDefault(target.id);
      }
    }
    if (typeof snap.masterVolume === "number") {
      const post = await this.snapshot();
      this.lastSnapshot = post;
      const sink = post.sinks.find((s) => s.isDefault);
      if (sink) {
        await this.setVolume(sink.id, snap.masterVolume);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Cheap structural compare. Avoids spamming events when nothing visible
 * changed (most poll ticks). Compares ids, volumes, mute, defaults.
 */
export function mixerChanged(a: MixerState, b: MixerState): boolean {
  if (a.available !== b.available) return true;
  if (
    a.sinks.length !== b.sinks.length ||
    a.sources.length !== b.sources.length ||
    a.playbackStreams.length !== b.playbackStreams.length ||
    a.recordingStreams.length !== b.recordingStreams.length
  ) {
    return true;
  }
  const deviceFp = (d: AudioDevice) =>
    `${d.id}:${d.isDefault ? 1 : 0}:${d.muted ? 1 : 0}:${d.volume.toFixed(3)}:${d.label}`;
  const streamFp = (s: AudioStream) =>
    `${s.id}:${s.muted ? 1 : 0}:${s.volume.toFixed(3)}:${s.label}`;
  const join = <T>(arr: T[], fp: (x: T) => string) => arr.map(fp).join("|");

  return (
    join(a.sinks, deviceFp) !== join(b.sinks, deviceFp) ||
    join(a.sources, deviceFp) !== join(b.sources, deviceFp) ||
    join(a.playbackStreams, streamFp) !== join(b.playbackStreams, streamFp) ||
    join(a.recordingStreams, streamFp) !== join(b.recordingStreams, streamFp)
  );
}
