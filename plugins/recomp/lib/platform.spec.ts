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
} from "./platform";
import type { PlatformAssets } from "./types";

describe("currentPlatform", () => {
  it("returns a valid platform name", () => {
    const plat = currentPlatform();
    expect(["linux", "windows", "macos"]).toContain(plat);
  });

  it("matches process.platform mapping", () => {
    const plat = currentPlatform();
    if (process.platform === "darwin") {
      expect(plat).toBe("macos");
    } else if (process.platform === "win32") {
      expect(plat).toBe("windows");
    } else {
      expect(plat).toBe("linux");
    }
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
    expect(dir).toBe(join(homedir(), ".config", "loadout", "recomp"));
  });
});

describe("getPlatformValue", () => {
  const assets: PlatformAssets = {
    windows: "game-win.zip",
    linux: "game-linux.tar.gz",
    macos: "game-mac.zip",
  };

  it("returns the correct value for the current platform", () => {
    const value = getPlatformValue(assets);
    const plat = currentPlatform();
    if (plat === "windows") expect(value).toBe("game-win.zip");
    else if (plat === "linux") expect(value).toBe("game-linux.tar.gz");
    else if (plat === "macos") expect(value).toBe("game-mac.zip");
  });

  it("returns undefined when platform has no value", () => {
    const empty: PlatformAssets = {};
    expect(getPlatformValue(empty)).toBeUndefined();
  });

  it("macOS falls back to linux value if macos is missing", () => {
    const linuxOnly: PlatformAssets = { linux: "game-linux.tar.gz" };
    const value = getPlatformValue(linuxOnly);
    const plat = currentPlatform();
    if (plat === "macos") {
      expect(value).toBe("game-linux.tar.gz");
    } else if (plat === "linux") {
      expect(value).toBe("game-linux.tar.gz");
    } else {
      expect(value).toBeUndefined();
    }
  });
});
