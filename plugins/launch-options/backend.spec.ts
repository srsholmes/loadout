import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// Mock @loadout/steam-paths
mock.module("@loadout/steam-paths", () => ({
  getUserdataDir: () => "/home/testuser/.local/share/Steam/userdata",
}));

// Mock @loadout/vdf
//
// `patchVdfValue` here is *realistic* (parses JSON, sets the value at the
// keyPath, re-serializes) instead of returning a constant. The concurrent
// regression test below depends on read-modify-write composition: if a
// writer overwrites a previous writer's appId entry, the test fails. A
// stubbed-constant `patchVdfValue` would mask the race.
mock.module("@loadout/vdf", () => ({
  parseVdf: (content: string) => JSON.parse(content),
  patchVdfValue: (content: string, keyPath: string[], value: string) => {
    const obj = JSON.parse(content);
    let cur = obj;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const k = keyPath[i];
      if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
    cur[keyPath[keyPath.length - 1]] = value;
    return JSON.stringify(obj);
  },
  removeVdfKey: (content: string, keyPath: string[]) => {
    const obj = JSON.parse(content);
    let cur = obj;
    for (let i = 0; i < keyPath.length - 1; i++) {
      const k = keyPath[i];
      if (typeof cur?.[k] !== "object" || cur[k] === null) return content;
      cur = cur[k];
    }
    delete cur[keyPath[keyPath.length - 1]];
    return JSON.stringify(obj);
  },
  // Real launch-options helpers — they're pure and don't reach the
  // filesystem, so we use the actual implementations to keep
  // appendLaunchToken / removeLaunchToken / hasLaunchToken behaviour
  // realistic in integration tests below.
  appendLaunchToken: (existing: string, token: string) =>
    existing.includes(token)
      ? existing
      : (existing.includes("%command%")
          ? existing.replace("%command%", `${token} %command%`)
          : `${existing}${existing ? " " : ""}${token} %command%`),
  removeLaunchToken: (existing: string, key: string) =>
    existing
      .split(/\s+/)
      .filter((t) => t !== key)
      .join(" ")
      .replace(/^%command%$/, "")
      .trim(),
  hasLaunchToken: (existing: string, key: string) =>
    existing.split(/\s+/).includes(key),
}));

// Mock @loadout/steam-cdp — by default, simulate Steam unreachable
// so setLaunchOptions falls through to the direct VDF write. Tests that
// want to exercise the SteamClient-success path override this per-test
// with `mockSetAppLaunchOptions.mockResolvedValueOnce(...)`.
const mockSetAppLaunchOptions = mock(
  (): Promise<void> =>
    Promise.reject(new Error("test default: Steam unreachable")),
);
mock.module("@loadout/steam-cdp", () => ({
  withSteamClient: async <T>(
    fn: (sc: { apps: { setAppLaunchOptions: typeof mockSetAppLaunchOptions } }) => Promise<T>,
  ): Promise<T> => {
    return fn({ apps: { setAppLaunchOptions: mockSetAppLaunchOptions } });
  },
}));

// Track fs/promises calls
const mockReaddir = mock(() => Promise.resolve([]));
const mockReadFile = mock(() => Promise.resolve(""));
const mockWriteFile = mock(() => Promise.resolve());
const mockCopyFile = mock(() => Promise.resolve());
const mockMkdir = mock(() => Promise.resolve());

mock.module("fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  copyFile: mockCopyFile,
  mkdir: mockMkdir,
}));

import LaunchOptionsBackend from "./backend";

describe("LaunchOptionsBackend", () => {
  let backend: LaunchOptionsBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    backend = new LaunchOptionsBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    mockReaddir.mockClear();
    mockReadFile.mockClear();
    mockWriteFile.mockClear();
    mockCopyFile.mockClear();
    mockMkdir.mockClear();
    mockSetAppLaunchOptions.mockClear();
    // Default per-test: Steam unreachable so VDF fallback path is exercised.
    mockSetAppLaunchOptions.mockImplementation(() =>
      Promise.reject(new Error("test default: Steam unreachable")),
    );
  });

  describe("getPresets()", () => {
    it("returns default presets when no user presets file exists", async () => {
      // readFile throws for missing user presets file
      mockReadFile.mockImplementation(() =>
        Promise.reject(new Error("ENOENT")),
      );

      const presets = await backend.getPresets();
      expect(presets.length).toBeGreaterThanOrEqual(7);

      const names = presets.map((p) => p.name);
      expect(names).toContain("MangoHud");
      expect(names).toContain("GameMode");
      expect(names).toContain("MangoHud + GameMode");
      expect(names).toContain("Disable Steam Deck Mode");
      const sdkPreset = presets.find((p) => p.name === "Disable Steam Deck Mode");
      expect(sdkPreset?.options).toBe("SteamDeck=0 %command%");
    });
  });

  describe("savePreset() + getPresets()", () => {
    it("persists a custom preset and getPresets includes it", async () => {
      // First call to readFile (in savePreset) throws — no existing user presets
      // Second call to readFile (in getPresets) returns the saved data
      let savedData = "{}";
      mockReadFile.mockImplementation(() => {
        return Promise.resolve(savedData);
      });
      mockWriteFile.mockImplementation(
        (_path: string, data: string) => {
          savedData = data;
          return Promise.resolve();
        },
      );

      await backend.savePreset("My Custom", "CUSTOM_VAR=1 %command%");

      // Verify writeFile was called
      expect(mockWriteFile).toHaveBeenCalled();

      // Now getPresets should include the custom preset
      const presets = await backend.getPresets();
      const custom = presets.find((p) => p.name === "My Custom");
      expect(custom).toBeDefined();
      expect(custom!.options).toBe("CUSTOM_VAR=1 %command%");
    });
  });

  describe("deletePreset()", () => {
    it("removes a saved preset", async () => {
      const existingPresets = JSON.stringify({
        "My Custom": "CUSTOM_VAR=1 %command%",
        "Another": "gamemoderun %command%",
      });

      let savedData = existingPresets;
      mockReadFile.mockImplementation(() => Promise.resolve(savedData));
      mockWriteFile.mockImplementation(
        (_path: string, data: string) => {
          savedData = data;
          return Promise.resolve();
        },
      );

      await backend.deletePreset("My Custom");

      const parsed = JSON.parse(savedData);
      expect(parsed["My Custom"]).toBeUndefined();
      expect(parsed["Another"]).toBe("gamemoderun %command%");
    });
  });

  describe("setLaunchOptions()", () => {
    it("creates a backup file before writing (when SteamClient unreachable)", async () => {
      const vdfContent = JSON.stringify({
        UserLocalConfigStore: {
          Software: {
            Valve: {
              Steam: {
                apps: {
                  "12345": { LaunchOptions: "old" },
                },
              },
            },
          },
        },
      });

      // readdir returns one user dir
      mockReaddir.mockImplementation(() => Promise.resolve(["99999"]));

      // readFile returns valid VDF content
      mockReadFile.mockImplementation(() => Promise.resolve(vdfContent));

      // Default mock: SteamClient throws → fallback to VDF write
      await backend.setLaunchOptions("12345", "mangohud %command%");

      // Verify copyFile was called (backup creation)
      expect(mockCopyFile).toHaveBeenCalledTimes(1);
      const copyArgs = mockCopyFile.mock.calls[0];
      expect(copyArgs[1]).toMatch(/\.bak$/);
    });

    it("uses SteamClient API when Steam is reachable — no VDF write", async () => {
      mockSetAppLaunchOptions.mockImplementation(() => Promise.resolve());

      await backend.setLaunchOptions("12345", "mangohud %command%");

      // SteamClient succeeded — no fallback to VDF
      expect(mockSetAppLaunchOptions).toHaveBeenCalledTimes(1);
      expect(mockSetAppLaunchOptions.mock.calls[0]).toEqual([
        "12345",
        "mangohud %command%",
      ]);
      // No backup, no write — Steam owns the file from here on
      expect(mockCopyFile).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("falls back to VDF write when SteamClient throws", async () => {
      mockSetAppLaunchOptions.mockImplementation(() =>
        Promise.reject(new Error("SteamClient unreachable")),
      );

      const vdfContent = JSON.stringify({
        UserLocalConfigStore: {
          Software: {
            Valve: {
              Steam: { apps: { "12345": { LaunchOptions: "old" } } },
            },
          },
        },
      });
      mockReaddir.mockImplementation(() => Promise.resolve(["99999"]));
      mockReadFile.mockImplementation(() => Promise.resolve(vdfContent));

      await backend.setLaunchOptions("12345", "mangohud %command%");

      // SteamClient was tried first
      expect(mockSetAppLaunchOptions).toHaveBeenCalledTimes(1);
      // Then we fell back to VDF — backup + write
      expect(mockCopyFile).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
    });
  });

  describe("setLaunchOptions() — concurrent writes (E-006)", () => {
    it("serialises two concurrent writes for different appIds — both land", async () => {
      // Force the SteamClient path to fail so both calls take the
      // direct-VDF fallback (the path with the read-modify-write race).
      mockSetAppLaunchOptions.mockImplementation(() =>
        Promise.reject(new Error("Steam unreachable")),
      );

      // Stateful in-memory VDF — readFile returns the *current* on-disk
      // state, writeFile updates it. Without the mutex this is the race
      // window: two parallel callers both read the initial state, each
      // mutates their own copy, the later writer clobbers the earlier
      // one's appId entry.
      let currentVdf = JSON.stringify({
        UserLocalConfigStore: {
          Software: { Valve: { Steam: { apps: {} } } },
        },
      });
      mockReaddir.mockImplementation(() => Promise.resolve(["99999"]));
      mockReadFile.mockImplementation(() => Promise.resolve(currentVdf));
      mockWriteFile.mockImplementation(
        (_path: string, data: string) => {
          currentVdf = data;
          return Promise.resolve();
        },
      );

      // Fire both writes concurrently — these resolve via the mutex chain.
      await Promise.all([
        backend.setLaunchOptions("11111", "alpha %command%"),
        backend.setLaunchOptions("22222", "bravo %command%"),
      ]);

      // Both entries must survive in the final on-disk state. Without
      // serialisation the second write was built off the empty pre-state
      // and would clobber the first entry.
      const final = JSON.parse(currentVdf);
      const apps = final.UserLocalConfigStore.Software.Valve.Steam.apps;
      expect(apps["11111"].LaunchOptions).toBe("alpha %command%");
      expect(apps["22222"].LaunchOptions).toBe("bravo %command%");

      // Sanity: both fallback paths actually wrote.
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
      expect(mockCopyFile).toHaveBeenCalledTimes(2);
    });

    it("serialises mixed setLaunchOptions / appendLaunchToken concurrently", async () => {
      // Same setup — Steam unreachable, stateful VDF mock.
      mockSetAppLaunchOptions.mockImplementation(() =>
        Promise.reject(new Error("Steam unreachable")),
      );

      let currentVdf = JSON.stringify({
        UserLocalConfigStore: {
          Software: {
            Valve: {
              Steam: {
                apps: {
                  "33333": { LaunchOptions: "gamemoderun %command%" },
                },
              },
            },
          },
        },
      });
      mockReaddir.mockImplementation(() => Promise.resolve(["99999"]));
      mockReadFile.mockImplementation(() => Promise.resolve(currentVdf));
      mockWriteFile.mockImplementation(
        (_path: string, data: string) => {
          currentVdf = data;
          return Promise.resolve();
        },
      );

      // setLaunchOptions on 11111 and appendLaunchToken on 33333 — the
      // append's read MUST happen after the unrelated write completes,
      // otherwise the append could be built off a stale read and miss a
      // concurrent update. We also start a third unrelated write on 22222.
      await Promise.all([
        backend.setLaunchOptions("11111", "alpha %command%"),
        backend.appendLaunchToken("33333", "/tmp/extra-token"),
        backend.setLaunchOptions("22222", "bravo %command%"),
      ]);

      const final = JSON.parse(currentVdf);
      const apps = final.UserLocalConfigStore.Software.Valve.Steam.apps;
      // All three entries land — proof the mutex serialised cleanly.
      expect(apps["11111"].LaunchOptions).toBe("alpha %command%");
      expect(apps["22222"].LaunchOptions).toBe("bravo %command%");
      expect(apps["33333"].LaunchOptions).toContain("gamemoderun");
      expect(apps["33333"].LaunchOptions).toContain("/tmp/extra-token");
    });
  });

  describe("appendLaunchToken()", () => {
    it("delegates to SteamClient when reachable, no VDF write", async () => {
      mockSetAppLaunchOptions.mockImplementation(() => Promise.resolve());

      // appendLaunchToken reads via getLaunchOptions(VDF) then calls
      // setLaunchOptions — we need a VDF that has the appId so the read
      // path returns existing options.
      const vdfContent = JSON.stringify({
        UserLocalConfigStore: {
          Software: {
            Valve: {
              Steam: {
                apps: { "12345": { LaunchOptions: "mangohud %command%" } },
              },
            },
          },
        },
      });
      mockReaddir.mockImplementation(() => Promise.resolve(["99999"]));
      mockReadFile.mockImplementation(() => Promise.resolve(vdfContent));

      const result = await backend.appendLaunchToken("12345", "/home/u/lsfg");

      expect(mockSetAppLaunchOptions).toHaveBeenCalledTimes(1);
      // The merged string is what gets sent to Steam
      expect(mockSetAppLaunchOptions.mock.calls[0][0]).toBe("12345");
      expect(mockSetAppLaunchOptions.mock.calls[0][1]).toContain(
        "/home/u/lsfg",
      );
      expect(mockSetAppLaunchOptions.mock.calls[0][1]).toContain("mangohud");
      expect(mockSetAppLaunchOptions.mock.calls[0][1]).toContain("%command%");
      // No VDF mutation — Steam owns the persist
      expect(mockWriteFile).not.toHaveBeenCalled();
      // appendLaunchToken returns the new string
      expect(result).toContain("/home/u/lsfg");
    });
  });
});
