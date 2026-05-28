/**
 * Pure parsing + diff helpers for the audio-mixer backend.
 *
 * All of this is no-`this`, no-I/O logic that turns a `pw-dump --no-colors`
 * JSON blob + a `wpctl status` text blob into the {sinks, sources,
 * playbackStreams, recordingStreams} snapshot the backend serves over RPC.
 * Lives here (not in backend.ts) per the migration rule: pure logic SHOULD
 * be testable without mocks.
 */

// ---------------------------------------------------------------------------
// RPC-visible types
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
// pw-dump shape (only the fields we read)
// ---------------------------------------------------------------------------

export interface PwPropsParam {
  volume?: number;
  mute?: boolean;
  channelVolumes?: number[];
}

export interface PwObject {
  id: number;
  type: string;
  info?: {
    props?: Record<string, unknown>;
    params?: { Props?: PwPropsParam[] };
    state?: string;
  };
}

// ---------------------------------------------------------------------------
// Property + volume helpers
// ---------------------------------------------------------------------------

/**
 * PipeWire stores volumes as a "cubed" scalar internally for nodes
 * (params.Props[0].volume). The user-facing linear volume that wpctl
 * shows is volume^(1/3). We expose the linear value and convert when
 * writing to wpctl (which itself takes linear).
 */
export function cubedToLinear(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.cbrt(v);
}

export function pickProp(
  props: Record<string, unknown> | undefined,
  key: string,
): string {
  if (!props) return "";
  const v = props[key];
  return typeof v === "string" ? v : "";
}

export function deviceLabel(props: Record<string, unknown> | undefined): {
  label: string;
  description: string;
} {
  const desc = pickProp(props, "node.description");
  const nick = pickProp(props, "node.nick");
  const name = pickProp(props, "node.name");
  const label = desc || nick || name || "Unknown device";
  return { label, description: desc || nick || "" };
}

export function streamLabel(props: Record<string, unknown> | undefined): {
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

export function readNodeVolume(node: PwObject): {
  volume: number;
  muted: boolean;
} {
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
export function parseDefaults(wpctlStatus: string): {
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
    if (
      /^\s*├─|^\s*└─|^\s*Audio|^\s*Video/.test(line) &&
      !/Sinks:|Sources:/.test(line)
    ) {
      // section header for something else — leave only if we've parsed past
      if (
        /(Sink Endpoints|Source Endpoints|Streams|Filters|Devices|Clients|Video)/.test(
          line,
        )
      ) {
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
// Snapshot builder
// ---------------------------------------------------------------------------

/**
 * Project a parsed pw-dump array + a wpctl-status string into a MixerState.
 * Pure: every input is provided by the caller, every output is on the return.
 */
export function buildMixerState(
  dump: PwObject[],
  wpctlStatus: string,
): MixerState {
  const { defaultSinkId, defaultSourceId } = parseDefaults(wpctlStatus);

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
