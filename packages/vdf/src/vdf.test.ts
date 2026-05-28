import { describe, it, expect } from "bun:test";

// Dynamically load the VDF implementation to bypass Bun's mock.module
// contamination. Other test files (launch-options/backend.spec.ts) call
// mock.module("@loadout/vdf", ...) which globally replaces all imports
// that resolve to files within this package — including relative imports.
// Loading via an absolute-path dynamic import with a cache-busting query
// string gives us a fresh, unmocked module instance.
const _path = import.meta.dir + "/vdf.ts";
const { parseVdf, serializeVdf, patchVdfValue, removeVdfKey } = await import(
  _path + "?real"
);

const SAMPLE_VDF = `"UserLocalConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"apps"
\t\t\t\t{
\t\t\t\t\t"123456"
\t\t\t\t\t{
\t\t\t\t\t\t"LaunchOptions"\t\t"gamemoderun %command%"
\t\t\t\t\t\t"LastPlayed"\t\t"1617000000"
\t\t\t\t\t}
\t\t\t\t\t"789012"
\t\t\t\t\t{
\t\t\t\t\t\t"LaunchOptions"\t\t"mangohud %command%"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}`;

// ---------------------------------------------------------------------------
// parseVdf
// ---------------------------------------------------------------------------

describe("parseVdf", () => {
  it("parses simple key-value pairs", () => {
    const input = `"root"\n{\n\t"key1"\t\t"value1"\n\t"key2"\t\t"value2"\n}`;
    const result = parseVdf(input);
    expect(result.root.key1).toBe("value1");
    expect(result.root.key2).toBe("value2");
  });

  it("parses nested sections", () => {
    const input = `"outer"\n{\n\t"inner"\n\t{\n\t\t"key"\t\t"val"\n\t}\n}`;
    const result = parseVdf(input);
    expect(result.outer.inner.key).toBe("val");
  });

  it("parses deeply nested structures (3+ levels)", () => {
    const result = parseVdf(SAMPLE_VDF);
    expect(
      result.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LaunchOptions,
    ).toBe("gamemoderun %command%");
    expect(
      result.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LastPlayed,
    ).toBe("1617000000");
    expect(
      result.UserLocalConfigStore.Software.Valve.Steam.apps["789012"]
        .LaunchOptions,
    ).toBe("mangohud %command%");
  });

  it("skips comments", () => {
    const input = `// This is a comment\n"root"\n{\n\t// Another comment\n\t"key"\t\t"value"\n}`;
    const result = parseVdf(input);
    expect(result.root.key).toBe("value");
  });

  it("skips empty lines", () => {
    const input = `\n\n"root"\n{\n\n\t"key"\t\t"value"\n\n}\n\n`;
    const result = parseVdf(input);
    expect(result.root.key).toBe("value");
  });

  it("handles empty input", () => {
    const result = parseVdf("");
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// serializeVdf
// ---------------------------------------------------------------------------

describe("serializeVdf", () => {
  it("serializes a flat object", () => {
    const obj = { root: { key1: "value1", key2: "value2" } };
    const out = serializeVdf(obj);
    expect(out).toContain('"root"');
    expect(out).toContain('"key1"\t\t"value1"');
    expect(out).toContain('"key2"\t\t"value2"');
  });

  it("serializes a nested object", () => {
    const obj = { outer: { inner: { key: "val" } } };
    const out = serializeVdf(obj);
    expect(out).toContain('"outer"');
    expect(out).toContain('"inner"');
    expect(out).toContain('"key"\t\t"val"');
  });

  it("round-trips: parseVdf(serializeVdf(obj)) produces equivalent structure", () => {
    const original = {
      UserLocalConfigStore: {
        Software: {
          Valve: {
            Steam: {
              apps: {
                "123456": {
                  LaunchOptions: "gamemoderun %command%",
                  LastPlayed: "1617000000",
                },
                "789012": {
                  LaunchOptions: "mangohud %command%",
                },
              },
            },
          },
        },
      },
    };
    const serialized = serializeVdf(original);
    const reparsed = parseVdf(serialized);
    expect(reparsed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// patchVdfValue
// ---------------------------------------------------------------------------

describe("patchVdfValue", () => {
  it("patches an existing value, preserving all other content", () => {
    const patched = patchVdfValue(
      SAMPLE_VDF,
      [
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "apps",
        "123456",
        "LaunchOptions",
      ],
      "mangohud %command%",
    );

    // The target value should be changed.
    expect(patched).toContain('"LaunchOptions"\t\t"mangohud %command%"');
    // The old value should be gone at the 123456 location.
    expect(patched).not.toContain('"LaunchOptions"\t\t"gamemoderun %command%"');
    // Other keys at the same level should be untouched.
    expect(patched).toContain('"LastPlayed"\t\t"1617000000"');
    // The other app's launch options should be untouched.
    const parsed = parseVdf(patched);
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["789012"]
        .LaunchOptions,
    ).toBe("mangohud %command%");
  });

  it("patches a value in a deeply nested section", () => {
    const patched = patchVdfValue(
      SAMPLE_VDF,
      [
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "apps",
        "123456",
        "LastPlayed",
      ],
      "9999999999",
    );

    const parsed = parseVdf(patched);
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LastPlayed,
    ).toBe("9999999999");
    // LaunchOptions should be untouched
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LaunchOptions,
    ).toBe("gamemoderun %command%");
  });

  it("inserts a new key when it doesn't exist", () => {
    const patched = patchVdfValue(
      SAMPLE_VDF,
      [
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "apps",
        "123456",
        "CloudEnabled",
      ],
      "1",
    );

    const parsed = parseVdf(patched);
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .CloudEnabled,
    ).toBe("1");
    // Existing keys should be untouched.
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LaunchOptions,
    ).toBe("gamemoderun %command%");
  });

  it("preserves comments before and after the patched line", () => {
    const vdfWithComments = `"root"
{
\t// Comment above
\t"key1"\t\t"old_value"
\t// Comment below
\t"key2"\t\t"keep_me"
}`;

    const patched = patchVdfValue(vdfWithComments, ["root", "key1"], "new_value");
    expect(patched).toContain("// Comment above");
    expect(patched).toContain("// Comment below");
    expect(patched).toContain('"key1"\t\t"new_value"');
    expect(patched).toContain('"key2"\t\t"keep_me"');
  });

  it("leaves other keys at the same level untouched", () => {
    const patched = patchVdfValue(
      SAMPLE_VDF,
      [
        "UserLocalConfigStore",
        "Software",
        "Valve",
        "Steam",
        "apps",
        "789012",
        "LaunchOptions",
      ],
      "PROTON_USE_WINED3D=1 %command%",
    );

    const parsed = parseVdf(patched);
    // Patched app
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["789012"]
        .LaunchOptions,
    ).toBe("PROTON_USE_WINED3D=1 %command%");
    // Other app untouched
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LaunchOptions,
    ).toBe("gamemoderun %command%");
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LastPlayed,
    ).toBe("1617000000");
  });
});

// ---------------------------------------------------------------------------
// removeVdfKey
// ---------------------------------------------------------------------------

describe("removeVdfKey", () => {
  it("removes an existing key-value pair", () => {
    const result = removeVdfKey(SAMPLE_VDF, [
      "UserLocalConfigStore",
      "Software",
      "Valve",
      "Steam",
      "apps",
      "123456",
      "LastPlayed",
    ]);

    const parsed = parseVdf(result);
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LaunchOptions,
    ).toBe("gamemoderun %command%");
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LastPlayed,
    ).toBeUndefined();
  });

  it("removes an existing section", () => {
    const result = removeVdfKey(SAMPLE_VDF, [
      "UserLocalConfigStore",
      "Software",
      "Valve",
      "Steam",
      "apps",
      "789012",
    ]);

    const parsed = parseVdf(result);
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["789012"],
    ).toBeUndefined();
    // Other app should still exist.
    expect(
      parsed.UserLocalConfigStore.Software.Valve.Steam.apps["123456"]
        .LaunchOptions,
    ).toBe("gamemoderun %command%");
  });

  it("is a no-op when key doesn't exist", () => {
    const result = removeVdfKey(SAMPLE_VDF, [
      "UserLocalConfigStore",
      "Software",
      "Valve",
      "Steam",
      "apps",
      "123456",
      "NonExistentKey",
    ]);

    // Content should be unchanged.
    expect(result).toBe(SAMPLE_VDF);
  });
});
