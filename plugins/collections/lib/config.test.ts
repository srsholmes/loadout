import { describe, expect, it } from "bun:test";
import {
  COLLECTIONS_SCHEMA_VERSION,
  coerceConfig,
  defaultConfig,
  defaultSettings,
  orderedTabs,
  resolveDefaultTab,
  uniqueTabId,
  validateConfig,
} from "./config";
import { builtinTabs } from "./templates";
import type { Tab } from "./types";

/** A minimal valid tab, for building malformed variants from. */
function validTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "custom",
    label: "Custom",
    visible: true,
    autoHide: false,
    root: { id: "root", kind: "group", combinator: "all", children: [] },
    sort: [{ field: "sortAs", dir: "asc" }],
    limit: null,
    group: { kind: "none" },
    display: { tileWidth: 150, showLabels: true, badges: [] },
    mirror: { enabled: false, steamName: "Custom" },
    indeterminatePolicy: "pass",
    ...overrides,
  };
}

describe("defaultConfig", () => {
  it("validates", () => {
    expect(validateConfig(defaultConfig())).toEqual([]);
  });

  it("seeds the builtin tabs and an order covering all of them", () => {
    const config = defaultConfig();
    expect(config.tabs.map((t) => t.id)).toEqual(builtinTabs().map((t) => t.id));
    expect(config.tabOrder).toEqual(config.tabs.map((t) => t.id));
  });

  it("stamps the current schema version", () => {
    expect(defaultConfig().schemaVersion).toBe(COLLECTIONS_SCHEMA_VERSION);
  });

  it("starts with mirroring off — we never touch Steam uninvited", () => {
    const config = defaultConfig();
    expect(config.mirror.autoSync).toBe(false);
    expect(config.mirror.ledger.entries).toEqual([]);
    expect(config.tabs.every((t) => t.mirror.enabled === false)).toBe(true);
  });

  it("returns a fresh object each call", () => {
    const a = defaultConfig();
    a.tabs.push(validTab());
    expect(defaultConfig().tabs).toHaveLength(builtinTabs().length);
  });
});

describe("validateConfig", () => {
  it("rejects a non-object", () => {
    expect(validateConfig(null)).toEqual(["The settings file is not an object"]);
    expect(validateConfig([])).toHaveLength(1);
    expect(validateConfig("nope")).toHaveLength(1);
  });

  it("reports every problem, not just the first", () => {
    // A user staring at a restore dialog should learn everything at once.
    const problems = validateConfig({});
    expect(problems.length).toBeGreaterThan(3);
  });

  it("writes messages a person can act on", () => {
    const problems = validateConfig({});
    expect(problems.length).toBeGreaterThan(0);
    for (const message of problems) {
      // No internal noise: no stack traces, no type names, no
      // "expected X got Y". Messages may lead with a lower-case field name
      // ("tabOrder must be…") — that is deliberate, since naming the exact
      // key is what makes the message actionable to someone who has opened
      // the file in an editor.
      expect(message).not.toMatch(/undefined|\[object|TypeError|SyntaxError/);
      expect(message).not.toContain("  ");
      expect(message.trim()).toBe(message);
      expect(message.length).toBeGreaterThan(10);
    }
  });

  it("refuses a config from a newer schema", () => {
    const problems = validateConfig({
      ...defaultConfig(),
      schemaVersion: COLLECTIONS_SCHEMA_VERSION + 5,
    });
    expect(problems.some((p) => /newer version of Loadout/.test(p))).toBe(true);
  });

  it("catches duplicate tab ids", () => {
    const problems = validateConfig({
      ...defaultConfig(),
      collections: [validTab({ id: "dupe" }), validTab({ id: "dupe" })],
    });
    expect(problems.some((p) => p.includes('share the id "dupe"'))).toBe(true);
  });

  it("catches a missing tab name and a missing id", () => {
    expect(
      validateConfig({ ...defaultConfig(), collections: [validTab({ label: "" })] }),
    ).toContain("tabs[0] is missing a name");
    expect(
      validateConfig({ ...defaultConfig(), collections: [validTab({ id: "" })] }),
    ).toContain("tabs[0] is missing an id");
  });

  it("catches a bad sort field and direction", () => {
    expect(
      validateConfig({
        ...defaultConfig(),
        collections: [validTab({ sort: [{ field: "nope", dir: "asc" }] as never })],
      }),
    ).toContain("tabs[0].sort[0] uses an unknown field");
    expect(
      validateConfig({
        ...defaultConfig(),
        collections: [validTab({ sort: [{ field: "sortAs", dir: "sideways" }] as never })],
      }),
    ).toContain("tabs[0].sort[0] has an unknown direction");
  });

  it("catches a bad indeterminatePolicy", () => {
    expect(
      validateConfig({
        ...defaultConfig(),
        collections: [validTab({ indeterminatePolicy: "maybe" as never })],
      }),
    ).toContain('tabs[0].indeterminatePolicy must be "pass" or "fail"');
  });

  it("validates nested rule trees and reports the path", () => {
    const problems = validateConfig({
      ...defaultConfig(),
      collections: [
        validTab({
          root: {
            id: "root",
            kind: "group",
            combinator: "all",
            children: [
              {
                id: "g2",
                kind: "group",
                combinator: "sideways",
                children: [],
              } as never,
            ],
          },
        }),
      ],
    });
    expect(
      problems.some((p) => p.includes("tabs[0].root.children[0]") && p.includes("combinator")),
    ).toBe(true);
  });

  it("catches a rule with no id, at depth", () => {
    const problems = validateConfig({
      ...defaultConfig(),
      collections: [
        validTab({
          root: {
            id: "root",
            kind: "group",
            combinator: "all",
            children: [{ kind: "installed" } as never],
          },
        }),
      ],
    });
    expect(problems).toContain("tabs[0].root.children[0] is missing an id");
  });

  it("rejects a root that is not a group", () => {
    const problems = validateConfig({
      ...defaultConfig(),
      collections: [validTab({ root: { id: "r", kind: "installed" } as never })],
    });
    expect(problems).toContain("tabs[0].root must be a group");
  });

  it("catches a malformed ledger", () => {
    const problems = validateConfig({
      ...defaultConfig(),
      mirror: { autoSync: false, pendingSync: false, ledger: { version: 1 } },
    });
    expect(problems).toContain("The Steam collection ledger is malformed");
  });
});

describe("coerceConfig — salvage", () => {
  it("keeps the good tabs and drops only the bad one", () => {
    // Losing one hand-built tab is bad; losing all of them because one was
    // corrupt is much worse, and that is the failure users are vocal about.
    const { config, dropped } = coerceConfig({
      ...defaultConfig(),
      collections: [validTab({ id: "good", label: "Good" }), { label: "Broken" }],
    });
    expect(config.tabs.map((t) => t.id)).toEqual(["good"]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toContain('"Broken"');
  });

  it("names an unsalvageable tab by index when it has no label", () => {
    const { dropped } = coerceConfig({
      ...defaultConfig(),
      collections: [validTab(), {}],
    });
    expect(dropped[0]).toContain("#2");
  });

  it("falls back to defaults when nothing survives", () => {
    const { config } = coerceConfig({ ...defaultConfig(), collections: [{}, {}] });
    expect(config.tabs.map((t) => t.id)).toEqual(builtinTabs().map((t) => t.id));
  });

  it("falls back to defaults for an unreadable file, and says so", () => {
    const { config, dropped } = coerceConfig("garbage");
    expect(config.tabs).toHaveLength(builtinTabs().length);
    expect(dropped[0]).toContain("could not be read");
  });

  it("de-duplicates tab ids, keeping the first", () => {
    const { config, dropped } = coerceConfig({
      ...defaultConfig(),
      collections: [
        validTab({ id: "dupe", label: "First" }),
        validTab({ id: "dupe", label: "Second" }),
      ],
    });
    expect(config.tabs).toHaveLength(1);
    expect(config.tabs[0]!.label).toBe("First");
    expect(dropped[0]).toContain("Second");
  });

  it("appends tabs that tabOrder forgot, rather than losing them", () => {
    const { config } = coerceConfig({
      ...defaultConfig(),
      collections: [validTab({ id: "a" }), validTab({ id: "b", label: "B" })],
      tabOrder: ["a"],
    });
    expect(config.tabOrder).toEqual(["a", "b"]);
  });

  it("strips tabOrder entries for tabs that no longer exist", () => {
    const { config } = coerceConfig({
      ...defaultConfig(),
      collections: [validTab({ id: "a" })],
      tabOrder: ["a", "ghost"],
    });
    expect(config.tabOrder).toEqual(["a"]);
  });

  it("clears a defaultTabId pointing at a deleted tab, and says so", () => {
    const { config, dropped } = coerceConfig({
      ...defaultConfig(),
      collections: [validTab({ id: "a" })],
      tabOrder: ["a"],
      defaultTabId: "ghost",
    });
    expect(config.defaultTabId).toBeNull();
    expect(dropped.some((d) => /default tab/i.test(d))).toBe(true);
  });

  it("drops malformed ledger entries and warns that those collections stop updating", () => {
    const { config, dropped } = coerceConfig({
      ...defaultConfig(),
      mirror: {
        autoSync: true,
        pendingSync: false,
        ledger: {
          version: 1,
          entries: [
            {
              managedId: "a",
              steamCollectionId: "uc-1",
              steamName: "A",
              appIds: [],
              lastSyncedAt: 1,
            },
            { managedId: "b" },
          ],
        },
      },
    });
    expect(config.mirror.ledger.entries).toHaveLength(1);
    expect(dropped.some((d) => /no longer be updated/.test(d))).toBe(true);
  });

  it("fills missing settings from the defaults", () => {
    const { config } = coerceConfig({ ...defaultConfig(), settings: {} });
    expect(config.settings).toEqual(defaultSettings());
  });

  it("rejects a nonsensical maxBackups rather than keeping zero backups", () => {
    const { config } = coerceConfig({
      ...defaultConfig(),
      settings: { ...defaultSettings(), maxBackups: 0 },
    });
    expect(config.settings.maxBackups).toBe(defaultSettings().maxBackups);
  });

  it("filters unknown badge kinds out of a tab's display", () => {
    const { config } = coerceConfig({
      ...defaultConfig(),
      collections: [
        validTab({
          display: { tileWidth: 150, showLabels: true, badges: ["deckCompat", "bogus"] as never },
        }),
      ],
    });
    expect(config.tabs[0]!.display.badges).toEqual(["deckCompat"]);
  });

  it("defaults a missing mirror collectionName to the tab label", () => {
    const { config } = coerceConfig({
      ...defaultConfig(),
      collections: [validTab({ label: "Backlog", mirror: { enabled: true } as never })],
    });
    expect(config.tabs[0]!.mirror.collectionName).toBe("Backlog");
  });

  it("always produces a config that validates", () => {
    // The point of salvage: whatever went in, what comes out is usable.
    for (const input of [
      null,
      {},
      "garbage",
      { collections: "nope" },
      { ...defaultConfig(), collections: [{}] },
      { ...defaultConfig(), profiles: "nope", gameOverrides: 5 },
    ]) {
      expect(validateConfig(coerceConfig(input).config)).toEqual([]);
    }
  });
});

describe("orderedTabs", () => {
  it("follows tabOrder", () => {
    const config = {
      ...defaultConfig(),
      collections: [validTab({ id: "a" }), validTab({ id: "b", label: "B" })],
      tabOrder: ["b", "a"],
    };
    expect(orderedTabs(config).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("appends tabs missing from tabOrder rather than hiding them", () => {
    const config = {
      ...defaultConfig(),
      collections: [validTab({ id: "a" }), validTab({ id: "b", label: "B" })],
      tabOrder: ["b"],
    };
    expect(orderedTabs(config).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("omits hidden builtins", () => {
    const config = { ...defaultConfig(), hiddenBuiltinTabs: ["installed" as const] };
    expect(orderedTabs(config).map((t) => t.id)).not.toContain("installed");
  });

  it("ignores tabOrder entries with no matching tab", () => {
    const config = {
      ...defaultConfig(),
      collections: [validTab({ id: "a" })],
      tabOrder: ["ghost", "a"],
    };
    expect(orderedTabs(config).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("resolveDefaultTab", () => {
  it("honours defaultTabId", () => {
    const config = { ...defaultConfig(), defaultTabId: "installed" };
    expect(resolveDefaultTab(config)?.id).toBe("installed");
  });

  it("falls back to the first visible tab when unset", () => {
    expect(resolveDefaultTab(defaultConfig())?.id).toBe("all");
  });

  it("does NOT require hiding All Games to change the opening tab", () => {
    // TabMaster's issue #221 asks for exactly this; its only workaround is
    // hiding All Games entirely.
    const config = { ...defaultConfig(), defaultTabId: "installed" };
    expect(orderedTabs(config).map((t) => t.id)).toContain("all");
    expect(resolveDefaultTab(config)?.id).toBe("installed");
  });

  it("falls back when defaultTabId points at a hidden tab", () => {
    const config = {
      ...defaultConfig(),
      defaultTabId: "installed",
      hiddenBuiltinTabs: ["installed" as const],
    };
    expect(resolveDefaultTab(config)?.id).toBe("all");
  });

  it("returns null when every tab is invisible", () => {
    const config = {
      ...defaultConfig(),
      collections: defaultConfig().tabs.map((t) => ({ ...t, visible: false })),
    };
    expect(resolveDefaultTab(config)).toBeNull();
  });
});

describe("uniqueTabId", () => {
  it("returns the base when free", () => {
    expect(uniqueTabId(defaultConfig(), "brand-new")).toBe("brand-new");
  });

  it("suffixes until free", () => {
    const config = {
      ...defaultConfig(),
      collections: [validTab({ id: "x" }), validTab({ id: "x-2", label: "X2" })],
    };
    expect(uniqueTabId(config, "x")).toBe("x-3");
  });
});

describe("coerceConfig — built-in tabs are ours, not the user's", () => {
  it("restores a built-in whose rules were removed", () => {
    // Exactly what happened on a real device: while `recent` had no data to
    // match, the empty-state offered "remove the rule excluding everything",
    // and applying it left a builtin with no rules that then matched the whole
    // library. The damage outlived the missing data.
    const config = defaultConfig();
    const gutted = config.tabs.map((t) =>
      t.id === "recent" ? { ...t, root: { ...t.root, children: [] } } : t,
    );

    const result = coerceConfig({ ...config, collections: gutted });
    const recent = result.config.tabs.find((t) => t.id === "recent")!;
    const shipped = builtinTabs().find((t) => t.id === "recent")!;

    expect(recent.root).toEqual(shipped.root);
    expect(result.dropped.some((d) => d.includes("Recently played"))).toBe(true);
  });

  it("keeps the parts of a built-in the user legitimately controls", () => {
    const config = defaultConfig();
    const customised = config.tabs.map((t) =>
      t.id === "recent"
        ? { ...t, visible: false, limit: 5, root: { ...t.root, children: [] } }
        : t,
    );

    const recent = coerceConfig({ ...config, collections: customised }).config.tabs.find(
      (t) => t.id === "recent",
    )!;
    expect(recent.visible).toBe(false);
    expect(recent.limit).toBe(5);
    // …but the rules came back.
    expect(recent.root.children.length).toBeGreaterThan(0);
  });

  it("leaves an untouched built-in alone, and says nothing about it", () => {
    const result = coerceConfig(defaultConfig());
    expect(result.dropped.filter((d) => d.includes("built-in"))).toEqual([]);
  });

  it("never rewrites a user-created tab", () => {
    const config = defaultConfig();
    const mine = {
      ...config.tabs[0]!,
      id: "mine",
      label: "Mine",
      builtin: undefined,
      root: { id: "mine-root", kind: "group" as const, combinator: "all" as const, children: [] },
    };
    const result = coerceConfig({ ...config, collections: [...config.tabs, mine] });
    expect(result.config.tabs.find((t) => t.id === "mine")!.root.children).toEqual([]);
  });
});
