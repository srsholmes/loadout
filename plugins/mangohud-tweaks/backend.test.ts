import {
  describe,
  it,
  expect,
  mock,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import type { EmitPayload } from "@loadout/types";
import * as realFs from "node:fs/promises";

// Mock @loadout/exec — capture which() calls so isInstalled() is testable
// without a real `which mangohud` on the CI host.
const mockRun = mock(() => Promise.resolve({ stdout: "", exitCode: 0 }));
mock.module("@loadout/exec", () => ({
  run: mockRun,
}));

// Mock node:fs/promises so the backend's mkdir + unlink stay in-memory.
// Keep the real module's other exports so anything we spread imports the
// real impl (the backend only uses mkdir + unlink).
const mockMkdir = mock(() => Promise.resolve(undefined));
const mockUnlink = mock(() => Promise.resolve(undefined));
mock.module("node:fs/promises", () => ({
  ...realFs,
  mkdir: mockMkdir,
  unlink: mockUnlink,
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
    mockMkdir.mockClear();
    mockUnlink.mockClear();

    // Default Bun.file mock — no config file
    mockBunFile = spyOn(Bun, "file").mockReturnValue({
      exists: () => Promise.resolve(false),
      text: () => Promise.resolve(""),
      json: () => Promise.resolve({}),
    } as unknown as ReturnType<typeof Bun.file>);
    mockBunWrite = spyOn(Bun, "write").mockReturnValue(
      Promise.resolve(0) as ReturnType<typeof Bun.write>,
    );
  });

  afterEach(() => {
    mockBunFile.mockRestore();
    mockBunWrite.mockRestore();
  });

  describe("isInstalled()", () => {
    it("returns true when `which mangohud` produces output", async () => {
      mockRun.mockImplementationOnce(() =>
        Promise.resolve({ stdout: "/usr/bin/mangohud\n", exitCode: 0 }),
      );
      expect(await backend.isInstalled()).toBe(true);
    });

    it("returns false when `which mangohud` produces no output", async () => {
      mockRun.mockImplementationOnce(() =>
        Promise.resolve({ stdout: "", exitCode: 1 }),
      );
      expect(await backend.isInstalled()).toBe(false);
    });

    it("returns false when the exec call throws", async () => {
      mockRun.mockImplementationOnce(() =>
        Promise.reject(new Error("ENOENT")),
      );
      expect(await backend.isInstalled()).toBe(false);
    });
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
      } as unknown as ReturnType<typeof Bun.file>);

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
      } as unknown as ReturnType<typeof Bun.file>);

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
      } as unknown as ReturnType<typeof Bun.file>);

      const config = await backend.getConfig();
      expect(Object.keys(config)).toEqual(["fps"]);
    });
  });

  describe("getPresets()", () => {
    it("returns all five built-in presets", async () => {
      const presets = await backend.getPresets();
      expect(presets.map((p) => p.name).sort()).toEqual(
        ["battery", "full", "minimal", "off", "standard"].sort(),
      );
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

    it("emits configChanged with the preset's config when applied", async () => {
      await backend.applyPreset("minimal");
      const evt = emittedEvents.find((e) => e.event === "configChanged");
      expect(evt).toBeDefined();
      expect(evt?.data).toEqual({ fps: "1", fps_only: "1" });
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
      } as unknown as ReturnType<typeof Bun.file>);

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

    it("creates the MangoHud config dir on every write", async () => {
      await backend.setConfig({ fps: "1" });
      expect(mockMkdir).toHaveBeenCalled();
      const callArgs = mockMkdir.mock.calls[0];
      expect(callArgs[0]).toContain(".config/MangoHud");
      expect(callArgs[1]).toEqual({ recursive: true });
    });

    it("emits configChanged with the new config", async () => {
      await backend.setConfig({ fps: "1", gpu_stats: "1" });
      const evt = emittedEvents.find((e) => e.event === "configChanged");
      expect(evt?.data).toEqual({ fps: "1", gpu_stats: "1" });
    });
  });

  describe("resetConfig()", () => {
    it("unlinks the config file", async () => {
      await backend.resetConfig();
      expect(mockUnlink).toHaveBeenCalled();
      expect(mockUnlink.mock.calls[0][0]).toContain(
        ".config/MangoHud/MangoHud.conf",
      );
    });

    it("swallows ENOENT when the file does not exist", async () => {
      mockUnlink.mockImplementationOnce(() =>
        Promise.reject(new Error("ENOENT")),
      );
      // Should not throw.
      await backend.resetConfig();
      // And should still emit configChanged with an empty config.
      const evt = emittedEvents.find((e) => e.event === "configChanged");
      expect(evt?.data).toEqual({});
    });

    it("emits configChanged with an empty config", async () => {
      await backend.resetConfig();
      const evt = emittedEvents.find((e) => e.event === "configChanged");
      expect(evt?.data).toEqual({});
    });
  });
});
