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
    const content = `"appid"  "440"\n"name"  "Team Fortress 2: Source"`;
    expect(parseAcf(content)).toEqual({
      appId: "440",
      name: "Team Fortress 2: Source",
    });
  });

  it("returns null when appid is missing", () => {
    expect(parseAcf(`"name"  "No App"`)).toBeNull();
  });

  it("returns null when name is missing", () => {
    expect(parseAcf(`"appid"  "730"`)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseAcf("")).toBeNull();
  });

  it("returns null when appid is non-numeric", () => {
    expect(parseAcf(`"appid"  "abc"\n"name"  "X"`)).toBeNull();
  });
});
