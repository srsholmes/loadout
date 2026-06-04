import { describe, it, expect } from "bun:test";
import { parseDuOutput } from "./parse-du";

describe("parseDuOutput", () => {
  it("parses a multi-line du -sb output into a Map", () => {
    const out = [
      "12345\t/home/deck/.local/share/Steam/steamapps/shadercache/730",
      "67890\t/home/deck/.local/share/Steam/steamapps/shadercache/440",
    ].join("\n");
    const result = parseDuOutput(out);
    expect(result.size).toBe(2);
    expect(result.get("/home/deck/.local/share/Steam/steamapps/shadercache/730")).toBe(12345);
    expect(result.get("/home/deck/.local/share/Steam/steamapps/shadercache/440")).toBe(67890);
  });

  it("returns an empty map for empty input", () => {
    expect(parseDuOutput("")).toEqual(new Map());
  });

  it("skips malformed lines (no leading number, blank lines)", () => {
    const out = [
      "12345\t/path/a",
      "",
      "garbage",
      "  ",
      "67890\t/path/b",
    ].join("\n");
    const result = parseDuOutput(out);
    expect(result.size).toBe(2);
    expect(result.get("/path/a")).toBe(12345);
    expect(result.get("/path/b")).toBe(67890);
  });

  it("preserves paths with spaces in the directory name", () => {
    const out = "98765\t/run/media/My SD Card/SteamLibrary/steamapps/shadercache/730";
    const result = parseDuOutput(out);
    expect(result.size).toBe(1);
    expect(result.get("/run/media/My SD Card/SteamLibrary/steamapps/shadercache/730")).toBe(98765);
  });
});
