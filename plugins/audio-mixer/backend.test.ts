import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import type { EmitPayload } from "@loadout/types";
import * as fsPromises from "node:fs/promises";

// In-memory "filesystem" mirroring what readPluginStorage / writePluginStorage
// poke at. Spy on the live `node:fs/promises` exports so the helpers see
// the same Map without us having to mock-module-replace the whole module.
const files = new Map<string, string>();

const readFileSpy = spyOn(fsPromises, "readFile").mockImplementation(
  // @ts-expect-error — only the (path, encoding) overload is hit here.
  async (path: string) => {
    const val = files.get(path);
    if (val === undefined) throw new Error(`ENOENT: ${path}`);
    return val;
  },
);
const writeFileSpy = spyOn(fsPromises, "writeFile").mockImplementation(
  // @ts-expect-error — partial overload match is fine for tests.
  async (path: string, data: string) => {
    files.set(path, data);
  },
);
const mkdirSpy = spyOn(fsPromises, "mkdir").mockImplementation(
  // @ts-expect-error — partial overload match.
  async () => undefined,
);
const renameSpy = spyOn(fsPromises, "rename").mockImplementation(
  async (from: string | Buffer | URL, to: string | Buffer | URL) => {
    const f = String(from);
    const t = String(to);
    const val = files.get(f);
    if (val === undefined) throw new Error(`ENOENT: ${f}`);
    files.set(t, val);
    files.delete(f);
  },
);
void readFileSpy;
void writeFileSpy;
void mkdirSpy;
void renameSpy;

import AudioMixerBackend from "./backend";
import { pluginStoragePath } from "@loadout/plugin-storage";

const STORAGE_PATH = pluginStoragePath("audio-mixer");

// ---------------------------------------------------------------------------
// Helpers — fake Bun.spawn
// ---------------------------------------------------------------------------

interface FakeRun {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function makeProc({ exitCode = 0, stdout = "", stderr = "" }: FakeRun) {
  const enc = new TextEncoder();
  return {
    stdout: new ReadableStream({
      start(c) {
        if (stdout) c.enqueue(enc.encode(stdout));
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        if (stderr) c.enqueue(enc.encode(stderr));
        c.close();
      },
    }),
    stdin: null,
    exited: Promise.resolve(exitCode),
    exitCode,
  } as unknown as ReturnType<typeof Bun.spawn>;
}

/**
 * Build a router that maps the spawned argv[0] (or full argv) to a fake
 * run result. Anything not matched falls through to a non-zero exit.
 */
function spawnRouter(routes: Array<(argv: string[]) => FakeRun | null>) {
  return (cmd: string[] | { cmd: string[] }) => {
    const argv = Array.isArray(cmd) ? cmd : cmd.cmd;
    for (const r of routes) {
      const out = r(argv);
      if (out) return makeProc(out);
    }
    return makeProc({ exitCode: 1, stderr: `unrouted: ${argv.join(" ")}` });
  };
}

// ---------------------------------------------------------------------------
// Sample pw-dump payloads
// ---------------------------------------------------------------------------

const PW_DUMP_TYPICAL = JSON.stringify([
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
]);

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

describe("AudioMixerBackend", () => {
  let backend: AudioMixerBackend;
  let emitted: EmitPayload[];
  let spawnSpy: ReturnType<typeof spyOn>;

  function mountSpawn(handler: (argv: string[]) => FakeRun | null) {
    spawnSpy.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (cmd: any) => spawnRouter([handler])(cmd) as any,
    );
  }

  beforeEach(() => {
    files.clear();
    backend = new AudioMixerBackend();
    emitted = [];
    backend.emit = (p) => emitted.push(p);
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => makeProc({ exitCode: 1 }) as any,
    );
  });

  afterEach(async () => {
    spawnSpy.mockRestore();
    await backend.onUnload();
  });

  describe("availability", () => {
    it("marks unavailable when wpctl is missing", async () => {
      mountSpawn((argv) => {
        // commandExists routes through `command -v <name>`.
        if (argv.includes("wpctl")) return { exitCode: 1 };
        if (argv.includes("pw-dump")) return { exitCode: 0, stdout: "/usr/bin/pw-dump" };
        return null;
      });
      await backend.onLoad();
      const state = await backend.getMixerState();
      expect(state.available).toBe(false);
      expect(state.unavailableReason).toContain("wpctl");
    });

    it("marks unavailable when pw-dump is missing", async () => {
      mountSpawn((argv) => {
        if (argv.includes("wpctl")) return { exitCode: 0, stdout: "/usr/bin/wpctl" };
        if (argv.includes("pw-dump")) return { exitCode: 1 };
        return null;
      });
      await backend.onLoad();
      const state = await backend.getMixerState();
      expect(state.available).toBe(false);
      expect(state.unavailableReason).toContain("pw-dump");
    });
  });

  describe("getMixerState (happy path)", () => {
    beforeEach(() => {
      mountSpawn((argv) => {
        // commandExists probes (`command -v wpctl` etc.) — succeed.
        if (argv[0] !== "wpctl" && argv[0] !== "pw-dump") {
          return { exitCode: 0, stdout: "/usr/bin/" + (argv.at(-1) ?? "") };
        }
        if (argv[0] === "pw-dump") {
          return { exitCode: 0, stdout: PW_DUMP_TYPICAL };
        }
        if (argv[0] === "wpctl" && argv[1] === "status") {
          return { exitCode: 0, stdout: WPCTL_STATUS_TYPICAL };
        }
        if (argv[0] === "wpctl") return { exitCode: 0 };
        return null;
      });
    });

    it("parses sinks and marks the default", async () => {
      await backend.onLoad();
      const state = await backend.getMixerState();
      expect(state.available).toBe(true);
      expect(state.sinks).toHaveLength(2);
      const def = state.sinks.find((s) => s.isDefault);
      expect(def).toBeDefined();
      expect(def?.id).toBe(42);
      expect(def?.label).toBe("Built-in Audio Speakers");
    });

    it("converts cubed PipeWire volume to linear (0.125 → 0.5)", async () => {
      await backend.onLoad();
      const state = await backend.getMixerState();
      const def = state.sinks.find((s) => s.isDefault)!;
      // cbrt(0.125) = 0.5 — what users see in wpctl/pavucontrol
      expect(def.volume).toBeCloseTo(0.5, 5);
    });

    it("filters out monitor sources", async () => {
      await backend.onLoad();
      const state = await backend.getMixerState();
      expect(state.sources).toHaveLength(1);
      expect(state.sources[0].id).toBe(50);
    });

    it("collects playback streams with app names", async () => {
      await backend.onLoad();
      const state = await backend.getMixerState();
      const labels = state.playbackStreams.map((s) => s.label).sort();
      expect(labels).toEqual(["Firefox", "Hades II"]);
      const hades = state.playbackStreams.find((s) => s.label === "Hades II")!;
      expect(hades.muted).toBe(true);
    });

    it("collects recording streams", async () => {
      await backend.onLoad();
      const state = await backend.getMixerState();
      expect(state.recordingStreams).toHaveLength(1);
      expect(state.recordingStreams[0].label).toBe("Discord");
    });

    it("places default sink first", async () => {
      await backend.onLoad();
      const state = await backend.getMixerState();
      expect(state.sinks[0].isDefault).toBe(true);
    });
  });

  describe("setVolume / setMute / setDefault", () => {
    let calls: string[][] = [];

    beforeEach(() => {
      calls = [];
      mountSpawn((argv) => {
        calls.push(argv);
        if (argv[0] !== "wpctl" && argv[0] !== "pw-dump") {
          return { exitCode: 0, stdout: "/usr/bin/" + (argv.at(-1) ?? "") };
        }
        if (argv[0] === "pw-dump") {
          return { exitCode: 0, stdout: PW_DUMP_TYPICAL };
        }
        if (argv[0] === "wpctl" && argv[1] === "status") {
          return { exitCode: 0, stdout: WPCTL_STATUS_TYPICAL };
        }
        return { exitCode: 0 };
      });
    });

    it("clamps volume into [0, 1.5]", async () => {
      await backend.onLoad();
      await backend.setVolume(42, 9);
      const setCall = calls.find(
        (c) => c[0] === "wpctl" && c[1] === "set-volume" && c[2] === "42",
      );
      expect(setCall).toBeDefined();
      // Clamped to 1.5 with 3 decimals
      expect(setCall![3]).toBe("1.500");
    });

    it("does not allow negative volumes", async () => {
      await backend.onLoad();
      await backend.setVolume(42, -1);
      const setCall = calls.find(
        (c) => c[0] === "wpctl" && c[1] === "set-volume" && c[2] === "42",
      );
      expect(setCall![3]).toBe("0.000");
    });

    it("setMute supports toggle", async () => {
      await backend.onLoad();
      await backend.setMute(42, "toggle");
      const muteCall = calls.find(
        (c) => c[0] === "wpctl" && c[1] === "set-mute",
      );
      expect(muteCall).toEqual(["wpctl", "set-mute", "42", "toggle"]);
    });

    it("setMute supports explicit on/off", async () => {
      await backend.onLoad();
      await backend.setMute(42, true);
      await backend.setMute(42, false);
      const muteCalls = calls.filter(
        (c) => c[0] === "wpctl" && c[1] === "set-mute",
      );
      expect(muteCalls.map((c) => c[3])).toEqual(["1", "0"]);
    });

    it("setDefault calls wpctl set-default", async () => {
      await backend.onLoad();
      await backend.setDefault(43);
      const defCall = calls.find(
        (c) => c[0] === "wpctl" && c[1] === "set-default",
      );
      expect(defCall).toEqual(["wpctl", "set-default", "43"]);
    });

    it("returns failure when not available", async () => {
      mountSpawn((argv) => {
        if (argv.includes("wpctl") && !["wpctl"].includes(argv[0]))
          return { exitCode: 1 };
        if (argv[0] === "wpctl") return { exitCode: 0 };
        return { exitCode: 0 };
      });
      await backend.onLoad();
      const r = await backend.setVolume(42, 0.5);
      expect(r.success).toBe(false);
      expect(r.error).toContain("unavailable");
    });
  });

  describe("persistence", () => {
    let calls: string[][] = [];

    beforeEach(() => {
      calls = [];
      mountSpawn((argv) => {
        calls.push(argv);
        if (argv[0] !== "wpctl" && argv[0] !== "pw-dump") {
          return { exitCode: 0, stdout: "/usr/bin/" + (argv.at(-1) ?? "") };
        }
        if (argv[0] === "pw-dump") {
          return { exitCode: 0, stdout: PW_DUMP_TYPICAL };
        }
        if (argv[0] === "wpctl" && argv[1] === "status") {
          return { exitCode: 0, stdout: WPCTL_STATUS_TYPICAL };
        }
        return { exitCode: 0 };
      });
    });

    it("persists app stream volume to disk", async () => {
      await backend.onLoad();
      // Stream id 100 = Firefox in PW_DUMP_TYPICAL.
      await backend.setVolume(100, 0.4);
      const written = files.get(STORAGE_PATH);
      expect(written).toBeDefined();
      const parsed = JSON.parse(written!);
      expect(parsed.apps.Firefox).toEqual({ volume: 0.4, muted: false });
    });

    it("persists app stream mute (explicit)", async () => {
      await backend.onLoad();
      await backend.setMute(100, true); // Firefox
      const parsed = JSON.parse(files.get(STORAGE_PATH)!);
      expect(parsed.apps.Firefox.muted).toBe(true);
    });

    it("persists app stream mute (toggle resolves via lastSnapshot)", async () => {
      await backend.onLoad();
      // Hades II (id 101) is muted in PW_DUMP_TYPICAL → toggle → false.
      await backend.setMute(101, "toggle");
      const parsed = JSON.parse(files.get(STORAGE_PATH)!);
      expect(parsed.apps["Hades II"].muted).toBe(false);
    });

    it("does not persist for device ids (no appName)", async () => {
      await backend.onLoad();
      // id 42 is the default sink. Sinks have no appName → no save.
      await backend.setVolume(42, 0.7);
      expect(files.has(STORAGE_PATH)).toBe(false);
    });

    it("restores saved app volume when stream appears at startup", async () => {
      // Seed disk with a saved Firefox volume at 0.25 (linear).
      files.set(
        STORAGE_PATH,
        JSON.stringify({ apps: { Firefox: { volume: 0.25, muted: false } } }),
      );
      await backend.onLoad();
      // applySavedToStreams should have called set-volume on Firefox (100).
      const restoreCall = calls.find(
        (c) =>
          c[0] === "wpctl" &&
          c[1] === "set-volume" &&
          c[2] === "100" &&
          c[3] === "0.250",
      );
      expect(restoreCall).toBeDefined();
    });

    it("restores saved mute when stream appears", async () => {
      // Firefox in dump is unmuted; saved state says it should be muted.
      files.set(
        STORAGE_PATH,
        JSON.stringify({ apps: { Firefox: { volume: 1, muted: true } } }),
      );
      await backend.onLoad();
      const muteCall = calls.find(
        (c) =>
          c[0] === "wpctl" &&
          c[1] === "set-mute" &&
          c[2] === "100" &&
          c[3] === "1",
      );
      expect(muteCall).toBeDefined();
    });

    it("does not restore twice for the same stream id", async () => {
      files.set(
        STORAGE_PATH,
        JSON.stringify({ apps: { Firefox: { volume: 0.25, muted: false } } }),
      );
      await backend.onLoad();
      const before = calls.filter(
        (c) => c[0] === "wpctl" && c[1] === "set-volume" && c[2] === "100",
      ).length;
      // Force another poll: applySavedToStreams should skip Firefox now.
      await (backend as unknown as { poll: () => Promise<void> }).poll();
      const after = calls.filter(
        (c) => c[0] === "wpctl" && c[1] === "set-volume" && c[2] === "100",
      ).length;
      expect(after).toBe(before);
    });

    it("skips wpctl write when live volume already matches saved", async () => {
      // Firefox in dump is at linear 1.0. Save 1.0 — restore should no-op.
      files.set(
        STORAGE_PATH,
        JSON.stringify({ apps: { Firefox: { volume: 1, muted: false } } }),
      );
      await backend.onLoad();
      const setVolCalls = calls.filter(
        (c) => c[0] === "wpctl" && c[1] === "set-volume" && c[2] === "100",
      );
      expect(setVolCalls).toHaveLength(0);
    });

    it("falls back to inline pw-dump when lastSnapshot is null on persist", async () => {
      // Regression for review item #6: if `persistAppForId` is reached
      // before the priming snapshot has populated `lastSnapshot`, it
      // must NOT write apps[""] garbage — it should take a single
      // inline snapshot to resolve the appName.
      await backend.onLoad();
      // Force lastSnapshot back to null to simulate the race.
      (backend as unknown as { lastSnapshot: null }).lastSnapshot = null;
      await backend.setVolume(100, 0.4); // Firefox stream id
      const written = files.get(STORAGE_PATH);
      expect(written).toBeDefined();
      const parsed = JSON.parse(written!);
      // App name was resolved from the inline snapshot, not lost.
      expect(parsed.apps.Firefox).toBeDefined();
      expect(parsed.apps.Firefox.volume).toBe(0.4);
      // And no apps[""] garbage key was written.
      expect(parsed.apps[""]).toBeUndefined();
    });
  });

  describe("per-game profiles", () => {
    let calls: string[][];

    beforeEach(() => {
      calls = [];
      mountSpawn((argv) => {
        calls.push(argv);
        if (argv[0] !== "wpctl" && argv[0] !== "pw-dump") {
          return { exitCode: 0, stdout: "/usr/bin/" + (argv.at(-1) ?? "") };
        }
        if (argv[0] === "pw-dump") {
          return { exitCode: 0, stdout: PW_DUMP_TYPICAL };
        }
        if (argv[0] === "wpctl" && argv[1] === "status") {
          return { exitCode: 0, stdout: WPCTL_STATUS_TYPICAL };
        }
        return { exitCode: 0 };
      });
    });

    it("emits staleSinkProfile when the stored sink no longer exists", async () => {
      await backend.onLoad();
      await backend.setPerGameEnabled(true);
      await backend.setGameProfile(123, "Hades II", {
        defaultSinkName: "alsa_output.usb-vanished-device.analog-stereo",
        masterVolume: 0.6,
      });
      // Reset emit buffer so we only see launch-time events below.
      emitted.length = 0;
      await backend.handleGameLaunch(123, "Hades II");
      const stale = emitted.find((p) => p.event === "staleSinkProfile");
      expect(stale).toBeDefined();
      const data = stale!.data as {
        appId: number;
        gameName: string;
        missingSinkName: string;
      };
      expect(data.appId).toBe(123);
      expect(data.missingSinkName).toBe(
        "alsa_output.usb-vanished-device.analog-stereo",
      );
    });

    it("does NOT emit staleSinkProfile when the stored sink resolves", async () => {
      await backend.onLoad();
      await backend.setPerGameEnabled(true);
      await backend.setGameProfile(124, "Firefox", {
        // This sink IS in PW_DUMP_TYPICAL.
        defaultSinkName: "alsa_output.usb-headset.analog-stereo",
        masterVolume: 0.5,
      });
      emitted.length = 0;
      await backend.handleGameLaunch(124, "Firefox");
      const stale = emitted.find((p) => p.event === "staleSinkProfile");
      expect(stale).toBeUndefined();
    });

    it("applyGameProfile writes via wpctl set-default + set-volume", async () => {
      await backend.onLoad();
      await backend.setPerGameEnabled(true);
      await backend.setGameProfile(125, "Hades II", {
        defaultSinkName: "alsa_output.usb-headset.analog-stereo",
        masterVolume: 0.5,
      });
      const baseline = calls.length;
      await backend.handleGameLaunch(125, "Hades II");
      const newCalls = calls.slice(baseline);
      const setDefault = newCalls.find(
        (c) => c[0] === "wpctl" && c[1] === "set-default" && c[2] === "43",
      );
      const setVolume = newCalls.find(
        (c) => c[0] === "wpctl" && c[1] === "set-volume",
      );
      expect(setDefault).toBeDefined();
      expect(setVolume).toBeDefined();
    });
  });
});
