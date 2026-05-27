import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import type { EmitPayload } from "@loadout/types";

// Mock @loadout/exec
const mockRun = mock(() => Promise.resolve({ stdout: "", exitCode: 0 }));
mock.module("@loadout/exec", () => ({
  run: mockRun,
}));

// Mock node:fs/promises (for mkdir in setConfig)
const mockMkdir = mock(() => Promise.resolve());
mock.module("node:fs/promises", () => ({
  mkdir: mockMkdir,
}));

import MangoHudTweaksBackend from "./backend";

describe("MangoHudTweaksBackend", () => {
  let backend: MangoHudTweaksBackend;
  let emittedEvents: EmitPayload[];
  let mockBunFile: ReturnType<typeof spyOn>;
  let mockBunWrite: ReturnType<typeof spyOn>;

  beforeEach(() => {
    backend = new MangoHudTweaksBackend();
    emittedEvents = [];
    backend.emit = (payload: EmitPayload) => {
      emittedEvents.push(payload);
    };
    mockRun.mockClear();

    // Default Bun.file mock — no config file
    mockBunFile = spyOn(Bun, "file").mockReturnValue({
      exists: () => Promise.resolve(false),
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({}),
    } as any);
    mockBunWrite = spyOn(Bun, "write").mockReturnValue(
      Promise.resolve(0) as any,
    );
  });

  afterEach(() => {
    mockBunFile.mockRestore();
    mockBunWrite.mockRestore();
  });

  describe("getConfig()", () => {
    it("parses key=value pairs from MangoHud.conf", async () => {
      mockBunFile.mockReturnValue({
        exists: () => Promise.resolve(true),
        text: () =>
          Promise.resolve(
            [
              "# MangoHud config",
              "fps=1",
              "gpu_stats=1",
              "cpu_temp=1",
              "",
              "# A comment",
              "frame_timing=1",
            ].join("\n"),
          ),
      } as any);

      const config = await backend.getConfig();
      expect(config).toEqual({
        fps: "1",
        gpu_stats: "1",
        cpu_temp: "1",
        frame_timing: "1",
      });
    });

    it("handles missing config file gracefully", async () => {
      mockBunFile.mockReturnValue({
        exists: () => Promise.resolve(false),
        text: () => Promise.reject(new Error("ENOENT")),
      } as any);

      const config = await backend.getConfig();
      expect(config).toEqual({});
    });

    it("skips comment and blank lines", async () => {
      mockBunFile.mockReturnValue({
        exists: () => Promise.resolve(true),
        text: () =>
          Promise.resolve(
            ["# comment", "", "  # indented comment", "fps=1"].join("\n"),
          ),
      } as any);

      const config = await backend.getConfig();
      expect(Object.keys(config)).toEqual(["fps"]);
    });
  });

  describe("applyPreset()", () => {
    it("accepts valid preset names", async () => {
      const result = await backend.applyPreset("minimal");
      expect(result.success).toBe(true);
    });

    it("accepts all built-in preset names", async () => {
      for (const name of ["minimal", "standard", "full", "battery", "off"]) {
        const result = await backend.applyPreset(name);
        expect(result.success).toBe(true);
      }
    });

    it("rejects invalid preset names", async () => {
      const result = await backend.applyPreset("nonexistent_preset");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown preset");
    });
  });

  describe("setConfig()", () => {
    it("reads fresh comments from file to avoid cached state race", async () => {
      // Simulate an existing config with comments
      const existingContent = [
        "# This is a preserved comment",
        "# Another comment",
        "",
        "old_key=old_value",
      ].join("\n");

      mockBunFile.mockReturnValue({
        exists: () => Promise.resolve(true),
        text: () => Promise.resolve(existingContent),
      } as any);

      await backend.setConfig({ fps: "1", gpu_stats: "1" });

      // Verify Bun.write was called
      expect(mockBunWrite).toHaveBeenCalled();

      // Verify the written content preserves comments and has new config
      const writtenContent = mockBunWrite.mock.calls[0][1] as string;
      expect(writtenContent).toContain("# This is a preserved comment");
      expect(writtenContent).toContain("# Another comment");
      expect(writtenContent).toContain("fps=1");
      expect(writtenContent).toContain("gpu_stats=1");
      // Old keys should NOT be in the output (setConfig replaces all config keys)
      expect(writtenContent).not.toContain("old_key=old_value");
    });
  });
});
