import { describe, it, expect } from "bun:test";
import { buildAppManifestMap } from "./manifests";

const acf = (appId: string, name: string) => `
"AppState"
{
  "appid"   "${appId}"
  "name"    "${name}"
}`;

describe("buildAppManifestMap", () => {
  it("returns an empty map for empty input", () => {
    expect(buildAppManifestMap([])).toEqual(new Map());
  });

  it("collects multiple manifests into a single map", () => {
    const result = buildAppManifestMap([
      { name: "appmanifest_730.acf", content: acf("730", "Counter-Strike 2") },
      { name: "appmanifest_440.acf", content: acf("440", "Team Fortress 2") },
    ]);
    expect(result.size).toBe(2);
    expect(result.get("730")).toBe("Counter-Strike 2");
    expect(result.get("440")).toBe("Team Fortress 2");
  });

  it("skips filenames that aren't appmanifest_*.acf", () => {
    const result = buildAppManifestMap([
      { name: "appmanifest_730.acf", content: acf("730", "Counter-Strike 2") },
      { name: "libraryfolders.vdf", content: acf("99", "Should be ignored") },
      { name: "appmanifest_730.acf.bak", content: acf("99", "Should be ignored") },
      { name: "appmanifest_440", content: acf("99", "Should be ignored — missing .acf") },
      { name: "shadercache", content: acf("99", "Should be ignored — dir name") },
    ]);
    expect(result.size).toBe(1);
    expect(result.has("99")).toBe(false);
    expect(result.get("730")).toBe("Counter-Strike 2");
  });

  it("silently skips entries whose ACF body can't be parsed", () => {
    const result = buildAppManifestMap([
      { name: "appmanifest_1.acf", content: "" },
      { name: "appmanifest_2.acf", content: '"AppState" { "appid" "2" }' }, // missing "name"
      { name: "appmanifest_3.acf", content: '"AppState" { "name" "X" }' }, // missing "appid"
      { name: "appmanifest_730.acf", content: acf("730", "Counter-Strike 2") },
    ]);
    expect(result.size).toBe(1);
    expect(result.get("730")).toBe("Counter-Strike 2");
  });

  it("last-write-wins on duplicate appIds (extracted from different files)", () => {
    const result = buildAppManifestMap([
      { name: "appmanifest_730.acf", content: acf("730", "Old Name") },
      { name: "appmanifest_730.acf.dup", content: acf("730", "Also ignored") }, // filename filter drops it
      { name: "appmanifest_730_v2.acf", content: acf("730", "New Name") },
    ]);
    expect(result.get("730")).toBe("New Name");
  });
});
