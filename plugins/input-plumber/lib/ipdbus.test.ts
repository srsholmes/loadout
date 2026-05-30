import { describe, it, expect } from "bun:test";
import {
  parseStringProp,
  parseStringArrayProp,
  parseObjectPathArrayProp,
  pickCompositePaths,
} from "./ipdbus";

describe("parseStringArrayProp", () => {
  it("parses a Capabilities `as` array", () => {
    const line = 'as 3 "Gamepad:Button:South" "Gamepad:Button:RightPaddle1" "Keyboard:KeyRecord"';
    expect(parseStringArrayProp(line)).toEqual([
      "Gamepad:Button:South",
      "Gamepad:Button:RightPaddle1",
      "Keyboard:KeyRecord",
    ]);
  });

  it("returns [] for an empty array", () => {
    expect(parseStringArrayProp("as 0")).toEqual([]);
  });

  it("returns null for a non-string-array shape", () => {
    expect(parseStringArrayProp('s "hello"')).toBeNull();
    expect(parseStringArrayProp('ao 1 "/path"')).toBeNull();
  });

  it("unescapes quotes and backslashes", () => {
    expect(parseStringArrayProp('as 1 "a\\"b"')).toEqual(['a"b']);
  });
});

describe("parseStringProp", () => {
  it("parses a string property", () => {
    expect(parseStringProp('s "OrangePi Apex"')).toBe("OrangePi Apex");
  });
});

describe("parseObjectPathArrayProp", () => {
  it("parses object-path arrays", () => {
    expect(parseObjectPathArrayProp('ao 2 "/org/a/Target0" "/org/a/Target1"')).toEqual([
      "/org/a/Target0",
      "/org/a/Target1",
    ]);
  });
});

describe("pickCompositePaths", () => {
  it("plucks only top-level CompositeDevice paths", () => {
    const tree = [
      "/org/shadowblip/InputPlumber",
      "/org/shadowblip/InputPlumber/CompositeDevice0",
      "/org/shadowblip/InputPlumber/CompositeDevice0/dbus",
      "/org/shadowblip/InputPlumber/CompositeDevice1",
      "/org/shadowblip/InputPlumber/Manager",
    ].join("\n");
    expect(pickCompositePaths(tree)).toEqual([
      "/org/shadowblip/InputPlumber/CompositeDevice0",
      "/org/shadowblip/InputPlumber/CompositeDevice1",
    ]);
  });
});
