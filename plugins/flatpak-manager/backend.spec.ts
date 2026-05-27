import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// Mock @loadout/exec
const mockRun = mock(() => Promise.resolve({ stdout: "", exitCode: 0 }));
mock.module("@loadout/exec", () => ({
  run: mockRun,
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
  });

  describe("updateApp()", () => {
    it("rejects invalid appId with flag injection attempt", async () => {
      await expect(backend.updateApp("--help")).rejects.toThrow(
        "Invalid Flatpak app ID",
      );

      await expect(
        backend.updateApp("-y; rm -rf /"),
      ).rejects.toThrow("Invalid Flatpak app ID");

      // Verify run was never called with an invalid appId
      expect(mockRun).not.toHaveBeenCalled();
    });

    it("rejects appId starting with a number", async () => {
      await expect(backend.updateApp("123.bad.id")).rejects.toThrow(
        "Invalid Flatpak app ID",
      );
    });

    it("accepts valid appId format", async () => {
      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: "Updated.", exitCode: 0 }),
      );

      const result = await backend.updateApp("com.valvesoftware.Steam");
      expect(result).toBe("Updated.");
      expect(mockRun).toHaveBeenCalledTimes(1);

      const callArgs = mockRun.mock.calls[0][0] as string[];
      expect(callArgs).toContain("com.valvesoftware.Steam");
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

    it("skips malformed lines with fewer than 5 columns", async () => {
      const output = [
        "Steam\tcom.valvesoftware.Steam\t1.0.0\t500.0 MB\tflathub",
        "Broken\tonly-two-cols",
        "",
      ].join("\n");

      mockRun.mockImplementation(() =>
        Promise.resolve({ stdout: output, exitCode: 0 }),
      );

      const apps = await backend.getInstalled();
      expect(apps).toHaveLength(1);
      expect(apps[0].name).toBe("Steam");
    });
  });
});
