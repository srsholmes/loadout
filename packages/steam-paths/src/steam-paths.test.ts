import { describe, it, expect } from "bun:test";
import {
  getSteamDir,
  getUserdataDir,
  getSteamAppsDir,
  getLibraryPaths,
  getUserIds,
} from "./index";

describe("steam-paths", () => {
  it("getSteamDir() returns a path ending with .local/share/Steam", () => {
    const result = getSteamDir();
    expect(result).toBeString();
    expect(result.endsWith(".local/share/Steam")).toBe(true);
  });

  it("getUserdataDir() returns a path ending with Steam/userdata", () => {
    const result = getUserdataDir();
    expect(result).toBeString();
    expect(result.endsWith("Steam/userdata")).toBe(true);
  });

  it("getSteamAppsDir() returns a path ending with Steam/steamapps", () => {
    const result = getSteamAppsDir();
    expect(result).toBeString();
    expect(result.endsWith("Steam/steamapps")).toBe(true);
  });

  it("getLibraryPaths() returns at least the default steamapps path", async () => {
    const paths = await getLibraryPaths();
    expect(Array.isArray(paths)).toBe(true);
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0]).toBe(getSteamAppsDir());
  });

  it("getUserIds() returns an array (even if empty)", async () => {
    const ids = await getUserIds();
    expect(Array.isArray(ids)).toBe(true);
  });
});
