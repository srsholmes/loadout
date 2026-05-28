import { describe, it, expect } from "bun:test";
import {
  buildMixerState,
  cubedToLinear,
  deviceLabel,
  mixerChanged,
  parseDefaults,
  pickProp,
  readNodeVolume,
  streamLabel,
  type MixerState,
  type PwObject,
} from "./mixer-state";

// ---------------------------------------------------------------------------
// Sample pw-dump payloads (mirrors the snapshot the backend feeds in)
// ---------------------------------------------------------------------------

const PW_DUMP_TYPICAL: PwObject[] = [
  // Default sink
  {
    id: 42,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "media.class": "Audio/Sink",
        "node.name": "alsa_output.pci-0000_03_00.6.analog-stereo",
        "node.description": "Built-in Audio Speakers",
      },
      params: {
        Props: [{ volume: 0.125, mute: false, channelVolumes: [0.125, 0.125] }],
      },
    },
  },
  // Second sink (USB headset)
  {
    id: 43,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "media.class": "Audio/Sink",
        "node.name": "alsa_output.usb-headset.analog-stereo",
        "node.description": "USB Headset",
      },
      params: {
        Props: [{ volume: 0.343, mute: false, channelVolumes: [0.343, 0.343] }],
      },
    },
  },
  // Default source (real mic)
  {
    id: 50,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "media.class": "Audio/Source",
        "node.name": "alsa_input.pci-0000_03_00.6.analog-stereo",
        "node.description": "Built-in Microphone",
      },
      params: { Props: [{ volume: 1, mute: false, channelVolumes: [1, 1] }] },
    },
  },
  // Monitor (should be filtered out)
  {
    id: 51,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "media.class": "Audio/Source",
        "node.name": "alsa_output.pci-0000_03_00.6.analog-stereo.monitor",
        "node.description": "Monitor of Built-in Audio Speakers",
      },
      params: { Props: [{ volume: 1, mute: false, channelVolumes: [1, 1] }] },
    },
  },
  // Playback stream — Firefox
  {
    id: 100,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "media.class": "Stream/Output/Audio",
        "application.name": "Firefox",
        "media.name": "AudioStream",
        "node.name": "Firefox",
      },
      params: {
        Props: [{ volume: 1, mute: false, channelVolumes: [1, 1] }],
      },
    },
  },
  // Playback stream — game (muted)
  {
    id: 101,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "media.class": "Stream/Output/Audio",
        "application.name": "Hades II",
        "node.name": "Hades II",
      },
      params: {
        Props: [{ volume: 0.5, mute: true, channelVolumes: [0.5, 0.5] }],
      },
    },
  },
  // Recording stream — Discord
  {
    id: 200,
    type: "PipeWire:Interface:Node",
    info: {
      props: {
        "media.class": "Stream/Input/Audio",
        "application.name": "Discord",
        "media.name": "input",
      },
      params: {
        Props: [{ volume: 0.8, mute: false, channelVolumes: [0.8, 0.8] }],
      },
    },
  },
  // Non-audio object — must be ignored
  {
    id: 999,
    type: "PipeWire:Interface:Device",
    info: { props: { "device.name": "alsa_card.0" } },
  },
];

const WPCTL_STATUS_TYPICAL = `PipeWire 'pipewire-0' [1.0.5]
 ├─ Devices:
 │      40. Built-in Audio
 │      41. USB Headset
 ├─ Sinks:
 │  *   42. Built-in Audio Speakers   [vol: 0.50]
 │      43. USB Headset               [vol: 0.70]
 ├─ Sources:
 │  *   50. Built-in Microphone       [vol: 1.00]
 ├─ Streams:
 │      100. Firefox
 │      101. Hades II
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cubedToLinear", () => {
  it("rounds cbrt(0.125) to 0.5 within 5dp", () => {
    expect(cubedToLinear(0.125)).toBeCloseTo(0.5, 5);
  });

  it("clamps NaN / negatives / Infinity to 0", () => {
    expect(cubedToLinear(NaN)).toBe(0);
    expect(cubedToLinear(-1)).toBe(0);
    expect(cubedToLinear(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("passes 0 and 1 through unchanged", () => {
    expect(cubedToLinear(0)).toBe(0);
    expect(cubedToLinear(1)).toBe(1);
  });
});

describe("pickProp", () => {
  it("returns the string when present", () => {
    expect(pickProp({ "node.name": "foo" }, "node.name")).toBe("foo");
  });

  it("returns empty string when missing", () => {
    expect(pickProp({}, "node.name")).toBe("");
    expect(pickProp(undefined, "node.name")).toBe("");
  });

  it("returns empty string when not a string", () => {
    expect(pickProp({ "node.name": 42 }, "node.name")).toBe("");
  });
});

describe("deviceLabel", () => {
  it("prefers description > nick > name", () => {
    expect(
      deviceLabel({
        "node.description": "Desc",
        "node.nick": "Nick",
        "node.name": "Name",
      }),
    ).toEqual({ label: "Desc", description: "Desc" });
    expect(
      deviceLabel({ "node.nick": "Nick", "node.name": "Name" }),
    ).toEqual({ label: "Nick", description: "Nick" });
    expect(deviceLabel({ "node.name": "Name" })).toEqual({
      label: "Name",
      description: "",
    });
  });

  it("falls back to 'Unknown device' when nothing is set", () => {
    expect(deviceLabel({})).toEqual({
      label: "Unknown device",
      description: "",
    });
  });
});

describe("streamLabel", () => {
  it("prefers application.name > media.name > node.name", () => {
    expect(
      streamLabel({
        "application.name": "App",
        "media.name": "Media",
        "node.name": "Node",
        "application.icon-name": "icon",
      }),
    ).toEqual({
      label: "App",
      appName: "App",
      iconName: "icon",
      mediaName: "Media",
    });
  });

  it("returns 'Audio Stream' when nothing is set", () => {
    expect(streamLabel({})).toEqual({
      label: "Audio Stream",
      appName: "",
      iconName: null,
      mediaName: null,
    });
  });

  it("nullifies iconName / mediaName when missing", () => {
    expect(
      streamLabel({ "application.name": "App" }),
    ).toEqual({ label: "App", appName: "App", iconName: null, mediaName: null });
  });
});

describe("readNodeVolume", () => {
  it("prefers channelVolumes[0]", () => {
    expect(
      readNodeVolume({
        id: 1,
        type: "PipeWire:Interface:Node",
        info: { params: { Props: [{ channelVolumes: [0.125, 0.5] }] } },
      }),
    ).toEqual({ volume: cubedToLinear(0.125), muted: false });
  });

  it("falls back to scalar volume", () => {
    expect(
      readNodeVolume({
        id: 1,
        type: "PipeWire:Interface:Node",
        info: { params: { Props: [{ volume: 0.343 }] } },
      }),
    ).toEqual({ volume: cubedToLinear(0.343), muted: false });
  });

  it("defaults to {1, false} when params are missing", () => {
    expect(
      readNodeVolume({ id: 1, type: "PipeWire:Interface:Node" }),
    ).toEqual({ volume: 1, muted: false });
  });

  it("reads the mute flag", () => {
    expect(
      readNodeVolume({
        id: 1,
        type: "PipeWire:Interface:Node",
        info: { params: { Props: [{ volume: 1, mute: true }] } },
      }),
    ).toEqual({ volume: 1, muted: true });
  });
});

describe("parseDefaults", () => {
  it("picks the starred sink and source ids", () => {
    expect(parseDefaults(WPCTL_STATUS_TYPICAL)).toEqual({
      defaultSinkId: 42,
      defaultSourceId: 50,
    });
  });

  it("returns nulls on empty input", () => {
    expect(parseDefaults("")).toEqual({
      defaultSinkId: null,
      defaultSourceId: null,
    });
  });

  it("ignores rows without a star", () => {
    const sinksOnly = ` ├─ Sinks:\n │      42. Built-in Audio Speakers\n`;
    expect(parseDefaults(sinksOnly).defaultSinkId).toBeNull();
  });
});

describe("buildMixerState", () => {
  it("parses sinks and marks the default first", () => {
    const state = buildMixerState(PW_DUMP_TYPICAL, WPCTL_STATUS_TYPICAL);
    expect(state.sinks).toHaveLength(2);
    expect(state.sinks[0].isDefault).toBe(true);
    expect(state.sinks[0].id).toBe(42);
    expect(state.sinks[0].label).toBe("Built-in Audio Speakers");
  });

  it("filters monitor sources but keeps real mics", () => {
    const state = buildMixerState(PW_DUMP_TYPICAL, WPCTL_STATUS_TYPICAL);
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].id).toBe(50);
  });

  it("converts cubed PipeWire volume to linear (0.125 → 0.5)", () => {
    const state = buildMixerState(PW_DUMP_TYPICAL, WPCTL_STATUS_TYPICAL);
    const def = state.sinks.find((s) => s.isDefault)!;
    expect(def.volume).toBeCloseTo(0.5, 5);
  });

  it("collects playback streams sorted by label", () => {
    const state = buildMixerState(PW_DUMP_TYPICAL, WPCTL_STATUS_TYPICAL);
    const labels = state.playbackStreams.map((s) => s.label);
    expect(labels).toEqual(["Firefox", "Hades II"]);
    expect(state.playbackStreams.find((s) => s.label === "Hades II")?.muted).toBe(
      true,
    );
  });

  it("collects recording streams", () => {
    const state = buildMixerState(PW_DUMP_TYPICAL, WPCTL_STATUS_TYPICAL);
    expect(state.recordingStreams).toHaveLength(1);
    expect(state.recordingStreams[0].label).toBe("Discord");
  });

  it("skips non-node and unclassed objects", () => {
    // 999 is PipeWire:Interface:Device — must not appear anywhere.
    const state = buildMixerState(PW_DUMP_TYPICAL, WPCTL_STATUS_TYPICAL);
    const allIds = [
      ...state.sinks,
      ...state.sources,
      ...state.playbackStreams,
      ...state.recordingStreams,
    ].map((x) => x.id);
    expect(allIds).not.toContain(999);
  });
});

describe("mixerChanged", () => {
  const baseState: MixerState = {
    available: true,
    unavailableReason: null,
    sinks: [
      {
        id: 1,
        nodeName: "a",
        label: "A",
        description: "",
        isDefault: true,
        volume: 0.5,
        muted: false,
        kind: "sink",
      },
    ],
    sources: [],
    playbackStreams: [],
    recordingStreams: [],
  };

  it("returns false for identical state", () => {
    expect(mixerChanged(baseState, baseState)).toBe(false);
    expect(
      mixerChanged(baseState, { ...baseState, sinks: [...baseState.sinks] }),
    ).toBe(false);
  });

  it("detects volume change", () => {
    const next: MixerState = {
      ...baseState,
      sinks: [{ ...baseState.sinks[0], volume: 0.6 }],
    };
    expect(mixerChanged(baseState, next)).toBe(true);
  });

  it("detects mute change", () => {
    const next: MixerState = {
      ...baseState,
      sinks: [{ ...baseState.sinks[0], muted: true }],
    };
    expect(mixerChanged(baseState, next)).toBe(true);
  });

  it("detects default flip", () => {
    const next: MixerState = {
      ...baseState,
      sinks: [{ ...baseState.sinks[0], isDefault: false }],
    };
    expect(mixerChanged(baseState, next)).toBe(true);
  });

  it("detects new stream appearing", () => {
    const next: MixerState = {
      ...baseState,
      playbackStreams: [
        {
          id: 100,
          label: "Firefox",
          appName: "Firefox",
          iconName: null,
          mediaName: null,
          volume: 1,
          muted: false,
          kind: "playback",
        },
      ],
    };
    expect(mixerChanged(baseState, next)).toBe(true);
  });

  it("detects availability flip", () => {
    expect(
      mixerChanged(baseState, { ...baseState, available: false }),
    ).toBe(true);
  });
});
