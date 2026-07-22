import { describe, expect, test } from "bun:test";
import {
  RELEASE_TAG_RE,
  parseVersion,
  compareVersions,
  isNewerVersion,
  versionsEqual,
} from "./version";

describe("RELEASE_TAG_RE", () => {
  test("accepts plain vX.Y.Z tags", () => {
    expect(RELEASE_TAG_RE.test("v0.6.0")).toBe(true);
    expect(RELEASE_TAG_RE.test("v12.34.56")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(RELEASE_TAG_RE.test("rolling")).toBe(false);
    expect(RELEASE_TAG_RE.test("0.6.0")).toBe(false); // no v prefix
    expect(RELEASE_TAG_RE.test("v0.6")).toBe(false);
    expect(RELEASE_TAG_RE.test("v0.6.0-rc1")).toBe(false);
    expect(RELEASE_TAG_RE.test("v0.6.0\n")).toBe(false);
    expect(RELEASE_TAG_RE.test("xv0.6.0")).toBe(false);
    expect(RELEASE_TAG_RE.test("")).toBe(false);
  });
});

describe("parseVersion", () => {
  test("parses bare and v-prefixed versions", () => {
    expect(parseVersion("0.6.0")).toEqual([0, 6, 0]);
    expect(parseVersion("v1.22.333")).toEqual([1, 22, 333]);
    expect(parseVersion(" v1.2.3 ")).toEqual([1, 2, 3]); // tolerates whitespace
  });

  test("tolerates quote-wrapped versions from pre-fix binaries", () => {
    // Binaries built before the build.sh --define quoting fix report
    // e.g. `"0.6.0"` (literal quotes) via /api/status.
    expect(parseVersion('"0.6.0"')).toEqual([0, 6, 0]);
    expect(parseVersion('"dev"')).toBeNull();
    expect(parseVersion('"0.6.0')).toBeNull(); // unbalanced — not our quirk
  });

  test("returns null for dev builds and junk", () => {
    expect(parseVersion("dev")).toBeNull();
    expect(parseVersion("dev-abc1234")).toBeNull();
    expect(parseVersion("rolling")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("1.2.3.4")).toBeNull();
    expect(parseVersion("1.2.x")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions([1, 0, 0], [0, 9, 9])).toBe(1);
    expect(compareVersions([0, 6, 0], [0, 6, 1])).toBe(-1);
    expect(compareVersions([0, 10, 0], [0, 9, 0])).toBe(1); // numeric, not lexical
    expect(compareVersions([2, 3, 4], [2, 3, 4])).toBe(0);
  });
});

describe("isNewerVersion", () => {
  test("true only when candidate is strictly newer", () => {
    expect(isNewerVersion("v0.7.0", "0.6.0")).toBe(true);
    expect(isNewerVersion("v0.6.0", "0.6.0")).toBe(false);
    expect(isNewerVersion("v0.5.9", "0.6.0")).toBe(false);
    expect(isNewerVersion("v0.6.10", "0.6.9")).toBe(true);
  });

  test("false when either side is unparsable (dev builds)", () => {
    expect(isNewerVersion("v0.7.0", "dev")).toBe(false);
    expect(isNewerVersion("rolling", "0.6.0")).toBe(false);
    expect(isNewerVersion("dev-abc", "dev")).toBe(false);
  });
});

describe("versionsEqual", () => {
  test("ignores the v prefix", () => {
    expect(versionsEqual("v0.6.0", "0.6.0")).toBe(true);
    expect(versionsEqual("0.6.0", "0.6.1")).toBe(false);
  });

  test("false when unparsable", () => {
    expect(versionsEqual("dev", "dev")).toBe(false);
  });
});
