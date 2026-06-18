import { describe, it, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  currentPlatform,
  dataDir,
  gamesDir,
  tempDir,
  configDir,
  getPlatformValue,
  getEffectivePlatformValue,
} from "./platform";
import type { PlatformAssets } from "./types";

describe("currentPlatform", () => {
  it("is always linux — Loadout is a Linux-only app", () => {
    expect(currentPlatform()).toBe("linux");
  });
});

describe("dataDir", () => {
  it("returns a path under home directory", () => {
    const dir = dataDir();
    expect(dir.startsWith(homedir())).toBe(true);
  });

  it("contains recomp-hub in path", () => {
    const dir = dataDir().toLowerCase();
    expect(dir).toContain("recomp");
  });
});

describe("gamesDir", () => {
  it("is a subdirectory of dataDir", () => {
    expect(gamesDir().startsWith(dataDir())).toBe(true);
  });

  it("ends with games", () => {
    expect(gamesDir().endsWith("games")).toBe(true);
  });
});

describe("tempDir", () => {
  it("is a subdirectory of dataDir", () => {
    expect(tempDir().startsWith(dataDir())).toBe(true);
  });

  it("ends with tmp", () => {
    expect(tempDir().endsWith("tmp")).toBe(true);
  });
});

describe("configDir", () => {
  it("returns path under home .config", () => {
    const dir = configDir();
    expect(dir).toBe(join(homedir(), ".config", "steam-loader", "recomp"));
  });
});

describe("getPlatformValue", () => {
  it("returns the native Linux value (host is always Linux)", () => {
    const assets: PlatformAssets = {
      windows: "game-win.zip",
      linux: "game-linux.tar.gz",
    };
    expect(getPlatformValue(assets)).toBe("game-linux.tar.gz");
  });

  it("returns undefined when there's no Linux value", () => {
    expect(getPlatformValue({})).toBeUndefined();
    // A Windows-only entry has no native Linux value here — the
    // Windows-via-Proton resolution is getEffectivePlatformValue's job.
    expect(getPlatformValue({ windows: "game-win.zip" })).toBeUndefined();
  });
});

describe("getEffectivePlatformValue (Linux→Windows-via-Proton)", () => {
  it("prefers the native Linux value", () => {
    const r = getEffectivePlatformValue({
      linux: "game-linux.tar.gz",
      windows: "game-win.zip",
    });
    expect(r).toEqual({ value: "game-linux.tar.gz", platform: "linux" });
  });

  it("falls back to the Windows binary (run via Proton) when no Linux value", () => {
    const r = getEffectivePlatformValue({ windows: "game-win.zip" });
    expect(r).toEqual({ value: "game-win.zip", platform: "windows" });
  });

  it("treats an explicit null Linux value as 'not shipped' and falls back to Windows", () => {
    const r = getEffectivePlatformValue({
      linux: null as unknown as string,
      windows: "game-win.zip",
    });
    expect(r).toEqual({ value: "game-win.zip", platform: "windows" });
  });

  it("returns undefined when neither Linux nor Windows is available", () => {
    expect(getEffectivePlatformValue({})).toBeUndefined();
  });
});
