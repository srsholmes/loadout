import { describe, it, expect } from "bun:test";
import {
  djb2,
  parseStringProp,
  parseObjectPathArrayProp,
  parseStringArrayProp,
  pickCompositePaths,
} from "./parse";

describe("djb2", () => {
  it("returns 5381 for the empty string", () => {
    expect(djb2("")).toBe(5381);
  });

  it("is deterministic across calls", () => {
    expect(djb2("Steam Deck Controller")).toBe(djb2("Steam Deck Controller"));
  });

  it("produces distinct hashes for distinct names", () => {
    expect(djb2("Xbox Wireless")).not.toBe(djb2("Steam Deck Controller"));
  });

  it("returns an unsigned 32-bit integer", () => {
    const h = djb2("the quick brown fox jumps over the lazy dog");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe("parseStringProp", () => {
  it("parses a simple quoted string", () => {
    expect(parseStringProp('s "External Pad"')).toBe("External Pad");
  });

  it("trims surrounding whitespace and trailing newline", () => {
    expect(parseStringProp('  s "External Pad"\n')).toBe("External Pad");
  });

  it("returns null for non-string signatures", () => {
    expect(parseStringProp('ao 0')).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseStringProp("")).toBeNull();
  });

  it("unescapes embedded backslash-quote", () => {
    expect(parseStringProp('s "He said \\"hi\\""')).toBe('He said "hi"');
  });

  it("unescapes doubled backslashes", () => {
    expect(parseStringProp('s "C:\\\\path"')).toBe("C:\\path");
  });
});

describe("parseObjectPathArrayProp", () => {
  it("returns [] for an empty array", () => {
    expect(parseObjectPathArrayProp("ao 0")).toEqual([]);
  });

  it("parses a single path", () => {
    expect(
      parseObjectPathArrayProp('ao 1 "/org/shadowblip/InputPlumber/devices/target/xb3600"'),
    ).toEqual(["/org/shadowblip/InputPlumber/devices/target/xb3600"]);
  });

  it("parses multiple paths", () => {
    expect(
      parseObjectPathArrayProp(
        'ao 2 "/org/shadowblip/InputPlumber/devices/target/xb3600" "/org/shadowblip/InputPlumber/devices/target/mouse0"',
      ),
    ).toEqual([
      "/org/shadowblip/InputPlumber/devices/target/xb3600",
      "/org/shadowblip/InputPlumber/devices/target/mouse0",
    ]);
  });

  it("returns null for a non-array signature", () => {
    expect(parseObjectPathArrayProp('s "/just/a/string"')).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseObjectPathArrayProp("garbage")).toBeNull();
  });
});

describe("parseStringArrayProp", () => {
  it("returns [] for an empty `as` array", () => {
    expect(parseStringArrayProp("as 0")).toEqual([]);
  });

  it("parses a multi-element `as` array", () => {
    expect(
      parseStringArrayProp(
        'as 2 "/org/shadowblip/InputPlumber/devices/source/event3" "/org/shadowblip/InputPlumber/devices/source/hidraw0"',
      ),
    ).toEqual([
      "/org/shadowblip/InputPlumber/devices/source/event3",
      "/org/shadowblip/InputPlumber/devices/source/hidraw0",
    ]);
  });

  it("also accepts the `ao` signature", () => {
    expect(parseStringArrayProp('ao 1 "/x"')).toEqual(["/x"]);
  });

  it("returns null for a scalar string signature", () => {
    expect(parseStringArrayProp('s "gamepad"')).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseStringArrayProp("garbage")).toBeNull();
  });
});

describe("pickCompositePaths", () => {
  it("returns top-level CompositeDevice paths only", () => {
    const tree = [
      "/org/shadowblip/InputPlumber",
      "/org/shadowblip/InputPlumber/Manager",
      "/org/shadowblip/InputPlumber/CompositeDevice0",
      "/org/shadowblip/InputPlumber/CompositeDevice1",
      "/org/shadowblip/InputPlumber/CompositeDevice0/Source0",
      "/org/shadowblip/InputPlumber/devices/target/xb3600",
    ].join("\n");
    expect(pickCompositePaths(tree)).toEqual([
      "/org/shadowblip/InputPlumber/CompositeDevice0",
      "/org/shadowblip/InputPlumber/CompositeDevice1",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(pickCompositePaths("")).toEqual([]);
  });

  it("ignores indentation and trailing whitespace", () => {
    const tree = "   /org/shadowblip/InputPlumber/CompositeDevice4   \n";
    expect(pickCompositePaths(tree)).toEqual([
      "/org/shadowblip/InputPlumber/CompositeDevice4",
    ]);
  });
});
