import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// Mock @loadout/exec — must come before importing the SUT.
// Use mock.module (not spyOn) for a third-party package; capture the
// mock fn first so we can control its return value per-test.
const mockRun = mock(() => Promise.resolve({ stdout: "", exitCode: 0 }));
const mockSpawn = mock(() => ({
  stdout: { getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) }) },
  exited: Promise.resolve(0),
}));
mock.module("@loadout/exec", () => ({
  run: mockRun,
  spawn: mockSpawn,
}));

import FlatpakManagerBackend from "./backend";

describe("FlatpakManagerBackend", () => {
  let backend: FlatpakManagerBackend;
  let emittedEvents: EmitPayload[];

  beforeEach(() => {
    backend = new FlatpakManagerBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    mockRun.mockClear();
    mockSpawn.mockClear();
  });

  describe("updateApp()", () => {
    it("rejects invalid appId with flag injection attempt", async () => {
      await expect(backend.updateApp("--help")).rejects.toThrow(
        "Invalid Flatpak app ID",
      );

      await expect(backend.updateApp("-y; rm -rf /")).rejects.toThrow(
        "Invalid Flatpak app ID",
      );

      // Verify run was never called with an invalid appId
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("rejects appId starting with a number", async () => {
      await expect(backend.updateApp("123.bad.id")).rejects.toThrow(
        "Invalid Flatpak app ID",
      );
    });

    it("accepts valid appId format and emits start/complete events", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "Updated.", exitCode: 0 }),
      );

      const result = await backend.updateApp("com.valvesoftware.Steam");
      expect(result).toBe("Updated.");
      expect(mockRun).toHaveBeenCalledTimes(1);

      const callArgs = mockRun.mock.calls[0][0] as string[];
      expect(callArgs).toContain("com.valvesoftware.Steam");
      expect(callArgs[0]).toBe("flatpak");

      // Both events fire with the appId carried through.
      const events = emittedEvents.map((e) => e.event);
      expect(events).toContain("updateStarted");
      expect(events).toContain("updateComplete");
    });

    it("accepts appId with hyphens and dots", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "OK", exitCode: 0 }),
      );

      await backend.updateApp("org.mozilla.Firefox");
      expect(mockRun).toHaveBeenCalled();
    });
  });

  describe("getAppInfo()", () => {
    it("rejects invalid appId", async () => {
      await expect(backend.getAppInfo("--system")).rejects.toThrow(
        "Invalid Flatpak app ID",
      );
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("returns info for valid appId", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({
          stdout: "Steam - Valve Corporation - 1.0",
          exitCode: 0,
        }),
      );

      const info = await backend.getAppInfo("com.valvesoftware.Steam");
      expect(info).toContain("Steam");
    });
  });

  describe("getInstalled()", () => {
    it("parses flatpak list output correctly", async () => {
      const tabSeparated = [
        "Steam\tcom.valvesoftware.Steam\t1.0.0\t500.0 MB\tflathub",
        "Firefox\torg.mozilla.firefox\t120.0\t200.0 MB\tflathub",
      ].join("\n");

      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: tabSeparated, exitCode: 0 }),
      );

      const apps = await backend.getInstalled();
      expect(apps).toHaveLength(2);

      expect(apps[0]).toEqual({
        name: "Steam",
        appId: "com.valvesoftware.Steam",
        version: "1.0.0",
        size: "500.0 MB",
        origin: "flathub",
      });

      expect(apps[1]).toEqual({
        name: "Firefox",
        appId: "org.mozilla.firefox",
        version: "120.0",
        size: "200.0 MB",
        origin: "flathub",
      });
    });

    it("returns empty array when no output", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "", exitCode: 0 }),
      );

      const apps = await backend.getInstalled();
      expect(apps).toEqual([]);
    });

    it("invokes flatpak list with the expected column flag", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "", exitCode: 0 }),
      );

      await backend.getInstalled();
      const callArgs = mockRun.mock.calls[0][0] as string[];
      expect(callArgs[0]).toBe("flatpak");
      expect(callArgs).toContain("list");
      expect(callArgs).toContain("--app");
      expect(callArgs.some((a) => a.startsWith("--columns="))).toBe(true);
    });
  });

  describe("checkUpdates()", () => {
    it("invokes flatpak remote-ls --updates", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "", exitCode: 0 }),
      );

      await backend.checkUpdates();
      const callArgs = mockRun.mock.calls[0][0] as string[];
      expect(callArgs[0]).toBe("flatpak");
      expect(callArgs).toContain("remote-ls");
      expect(callArgs).toContain("--updates");
    });
  });

  describe("removeUnused()", () => {
    it("returns an empty list when flatpak prints nothing", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "", exitCode: 0 }),
      );

      const result = await backend.removeUnused();
      expect(result).toEqual({ removed: [] });
    });

    it("returns trimmed removed entries from stdout", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({
          stdout: "org.freedesktop.Platform.GL.default/x86_64/23.08\n\norg.gtk.Gtk3theme.Breeze\n",
          exitCode: 0,
        }),
      );

      const result = await backend.removeUnused();
      expect(result.removed).toHaveLength(2);
      expect(result.removed[0]).toBe("org.freedesktop.Platform.GL.default/x86_64/23.08");
    });
  });
});
