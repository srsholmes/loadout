import { describe, expect, it } from "bun:test";
import {
  SHARE_KIND,
  decodeShareString,
  encodeShareString,
  exportTabs,
  importTabs,
} from "./share";
import { defaultConfig, validateConfig } from "./config";
import { templates } from "./templates";
import type { Tab } from "./types";
import { epoch } from "../test/fixtures/library";

const NOW = epoch("2026-07-30");

function customTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "mine",
    label: "Mine",
    visible: true,
    autoHide: false,
    root: {
      id: "root",
      kind: "group",
      combinator: "all",
      children: [{ id: "r1", kind: "installed" }],
    },
    sort: [{ field: "sortAs", dir: "asc" }],
    limit: null,
    group: { kind: "none" },
    display: { tileWidth: 150, showLabels: true, badges: [] },
    mirror: { enabled: false, collectionName: "Mine" },
    indeterminatePolicy: "pass",
    ...overrides,
  };
}

describe("exportTabs", () => {
  it("stamps the kind and current schema", () => {
    const env = exportTabs([customTab()], NOW * 1000);
    expect(env.kind).toBe(SHARE_KIND);
    expect(env.schemaVersion).toBe(defaultConfig().schemaVersion);
    expect(env.exportedAt).toBe(NOW * 1000);
  });

  it("deep-clones, so later edits can't mutate a held envelope", () => {
    const tab = customTab();
    const env = exportTabs([tab]);
    tab.label = "renamed";
    expect(env.tabs[0]!.label).toBe("Mine");
  });
});

describe("encode/decode round trip", () => {
  it("survives a full round trip", () => {
    const env = exportTabs([customTab(), customTab({ id: "two", label: "Two" })], 123);
    const decoded = decodeShareString(encodeShareString(env));
    expect(decoded).toEqual(env);
  });

  it("produces a string safe to paste into a URL or chat client", () => {
    const code = encodeShareString(exportTabs([customTab()], 1));
    // base64url: no +, no /, no = padding, so nothing needs escaping.
    expect(code).not.toMatch(/[+/=]/);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("round-trips non-ASCII labels", () => {
    const env = exportTabs([customTab({ label: "日本語 · Café 🎮" })], 1);
    expect(decodeShareString(encodeShareString(env)).tabs[0]!.label).toBe(
      "日本語 · Café 🎮",
    );
  });

  it("round-trips every shipped template", () => {
    const tabs = templates(NOW)
      .filter((t) => t.id !== "blank")
      .map((t) => t.build(`tpl-${t.id}`));
    const decoded = decodeShareString(encodeShareString(exportTabs(tabs, 1)));
    expect(decoded.tabs).toHaveLength(tabs.length);
    expect(decoded.tabs.map((t) => t.id)).toEqual(tabs.map((t) => t.id));
  });
});

describe("decodeShareString — failure messages are for humans", () => {
  it("asks for input when given nothing", () => {
    expect(() => decodeShareString("   ")).toThrow("Paste a share code first");
  });

  it("blames truncation for undecodable base64", () => {
    expect(() => decodeShareString("!!!not base64!!!")).toThrow(/truncated/);
  });

  it("reports damage for valid base64 that isn't JSON", () => {
    expect(() => decodeShareString(encodeURIComponent(btoa("hello")))).toThrow(
      /damaged|truncated/,
    );
  });

  it("rejects a code for something else by kind", () => {
    const foreign = btoa(JSON.stringify({ kind: "some.other.tool", tabs: [] }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(() => decodeShareString(foreign)).toThrow(
      "That code isn't a Collections share code",
    );
  });

  it("rejects an empty tab list", () => {
    const empty = encodeShareString({
      kind: SHARE_KIND,
      schemaVersion: 1,
      exportedAt: 0,
      tabs: [],
    });
    expect(() => decodeShareString(empty)).toThrow("contains no tabs");
  });

  it("never leaks a raw parser error", () => {
    for (const bad of ["", "!!!", btoa("{"), btoa("null")]) {
      try {
        decodeShareString(bad);
      } catch (err) {
        expect((err as Error).message).not.toMatch(/JSON|Unexpected token|atob/i);
      }
    }
  });
});

describe("importTabs — never overwrites", () => {
  it("adds an incoming tab alongside the existing ones", () => {
    const current = defaultConfig();
    const result = importTabs(current, exportTabs([customTab()], 1));
    expect(result.added).toEqual(["mine"]);
    expect(result.config.tabs).toHaveLength(current.tabs.length + 1);
    // Every original tab is untouched.
    for (const tab of current.tabs) {
      expect(result.config.tabs.some((t) => t.id === tab.id)).toBe(true);
    }
  });

  it("does not mutate the config it is given", () => {
    const current = defaultConfig();
    const before = JSON.stringify(current);
    importTabs(current, exportTabs([customTab()], 1));
    expect(JSON.stringify(current)).toBe(before);
  });

  it("suffixes a colliding id and reports the rename", () => {
    const current = { ...defaultConfig() };
    const first = importTabs(current, exportTabs([customTab()], 1));
    const second = importTabs(first.config, exportTabs([customTab()], 1));
    expect(second.added).toEqual(["mine-2"]);
    expect(second.renamed).toContainEqual(["mine", "mine-2"]);
  });

  it("suffixes a colliding label so the strip stays readable", () => {
    const current = { ...defaultConfig() };
    const first = importTabs(current, exportTabs([customTab()], 1));
    const second = importTabs(first.config, exportTabs([customTab()], 1));
    const added = second.config.tabs.find((t) => t.id === "mine-2")!;
    expect(added.label).toBe("Mine (2)");
    expect(second.renamed).toContainEqual(["Mine", "Mine (2)"]);
  });

  it("appends imported tabs to the order", () => {
    const result = importTabs(defaultConfig(), exportTabs([customTab()], 1));
    expect(result.config.tabOrder.at(-1)).toBe("mine");
  });

  it("produces a config that validates", () => {
    const result = importTabs(defaultConfig(), exportTabs([customTab()], 1));
    expect(validateConfig(result.config)).toEqual([]);
  });
});

describe("importTabs — safety rails", () => {
  it("forces mirroring OFF, whatever the envelope claims", () => {
    // Pasting someone's share code must not rewrite your Steam collections
    // as a side effect.
    const shared = customTab({
      mirror: { enabled: true, collectionName: "Their Collection" },
    });
    const result = importTabs(defaultConfig(), exportTabs([shared], 1));
    const added = result.config.tabs.find((t) => t.id === "mine")!;
    expect(added.mirror.enabled).toBe(false);
    expect(added.mirror.collectionName).toBe("Mine");
  });

  it("refuses builtin tabs, with a reason", () => {
    // Builtins are defined by this build; importing one would create a
    // second uneditable "Installed".
    const fake = customTab({ id: "installed", label: "Installed", builtin: "installed" });
    const result = importTabs(defaultConfig(), exportTabs([fake], 1));
    expect(result.added).toEqual([]);
    expect(result.rejected).toEqual([
      { label: "Installed", reason: "Built-in tabs can't be imported" },
    ]);
  });

  it("accepts a raw share string as well as an envelope", () => {
    const code = encodeShareString(exportTabs([customTab()], 1));
    expect(importTabs(defaultConfig(), code).added).toEqual(["mine"]);
  });

  it("propagates a decode error for a bad string", () => {
    expect(() => importTabs(defaultConfig(), "!!!")).toThrow(/truncated/);
  });

  it("runs an older envelope through the migration chain", () => {
    // A code exported by an older build must still land in today's shape.
    const old = { ...exportTabs([customTab()], 1), schemaVersion: 0 };
    const result = importTabs(defaultConfig(), old);
    expect(result.added).toEqual(["mine"]);
    expect(result.config.schemaVersion).toBe(defaultConfig().schemaVersion);
  });

  it("imports several tabs at once, keeping their order", () => {
    const tabs = [
      customTab({ id: "a", label: "A" }),
      customTab({ id: "b", label: "B" }),
      customTab({ id: "c", label: "C" }),
    ];
    const result = importTabs(defaultConfig(), exportTabs(tabs, 1));
    expect(result.added).toEqual(["a", "b", "c"]);
  });

  it("survives a malformed tab inside an otherwise valid envelope", () => {
    const envelope = {
      kind: SHARE_KIND,
      schemaVersion: 1,
      exportedAt: 0,
      tabs: [customTab({ id: "good", label: "Good" }), { label: "Broken" } as never],
    };
    const result = importTabs(defaultConfig(), envelope);
    expect(result.added).toEqual(["good"]);
    expect(validateConfig(result.config)).toEqual([]);
  });
});
