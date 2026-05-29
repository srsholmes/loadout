import { describe, it, expect } from "bun:test";
import { parseAcf } from "./parse-acf";

describe("parseAcf", () => {
  it("extracts appid + name from a typical Steam ACF", () => {
    const content = `
"AppState"
{
  "appid"   "730"
  "Universe"  "1"
  "name"    "Counter-Strike 2"
  "StateFlags"  "4"
}`;
    expect(parseAcf(content)).toEqual({
      appId: "730",
      name: "Counter-Strike 2",
    });
  });

  it("handles names with spaces and punctuation", () => {
    const content = `"AppState" { "appid" "440" "name" "Team Fortress 2: Source" }`;
    expect(parseAcf(content)).toEqual({
      appId: "440",
      name: "Team Fortress 2: Source",
    });
  });

  it("ignores appid/name inside nested blocks like InstalledDepots", () => {
    // Real ACF files carry nested blocks (UserConfig, MountedDepots,
    // InstalledDepots, ...). A naive first-match would happily grab a
    // depot's appid override. The parser must only look at depth 1
    // keys of AppState.
    const content = `
"AppState"
{
  "appid"   "730"
  "name"    "Counter-Strike 2"
  "InstalledDepots"
  {
    "734"
    {
      "appid"     "999999"
      "name"      "FakeName"
    }
  }
  "UserConfig"
  {
    "name"      "ShouldNotWin"
  }
}`;
    expect(parseAcf(content)).toEqual({
      appId: "730",
      name: "Counter-Strike 2",
    });
  });

  it("returns null when there is no AppState block", () => {
    expect(parseAcf(`"appid" "730" "name" "Stray"`)).toBeNull();
  });

  it("returns null when appid is missing", () => {
    expect(parseAcf(`"AppState" { "name" "No App" }`)).toBeNull();
  });

  it("returns null when name is missing", () => {
    expect(parseAcf(`"AppState" { "appid" "730" }`)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseAcf("")).toBeNull();
  });

  it("returns null when appid is non-numeric", () => {
    expect(parseAcf(`"AppState" { "appid" "abc" "name" "X" }`)).toBeNull();
  });
});
