import { describe, it, expect } from "bun:test";
import type { AgentDoc } from "@loadout/types";
import {
  baselineFromMethodNames,
  countBySafety,
  inferSafety,
  mergePluginDoc,
  requiresWriteOptIn,
  toIndexEntry,
} from "./merge";

function baseline(partial: Partial<AgentDoc> = {}): AgentDoc {
  return {
    id: "demo",
    generatorVersion: 1,
    methods: [
      {
        name: "getStatus",
        args: [],
        returns: { type: "string" },
        safety: "read",
        safetyInferred: true,
      },
      {
        name: "setValue",
        args: [{ name: "value", schema: { type: "number" }, optional: false }],
        returns: { type: "null" },
        safety: "write",
        safetyInferred: true,
      },
    ],
    ...partial,
  };
}

const meta = { id: "demo", name: "Demo", description: "A demo plugin" };

describe("inferSafety", () => {
  it("treats clear getter prefixes as reads", () => {
    for (const name of [
      "getTdpInfo",
      "listDevices",
      "readSoundFile",
      "fetchLibrary",
      "searchGames",
      "queryState",
      "findMatch",
      "isEnabled",
      "hasDriver",
    ]) {
      expect(inferSafety(name)).toBe("read");
    }
  });

  it("defaults everything else to write", () => {
    for (const name of [
      "setTdp",
      "applyProfile",
      "installGame",
      "toggleRadio",
      "removeShortcut",
      "startAuth",
      // Deliberately not inferred — these may cache or mutate.
      "checkPreflight",
      "scanForInstalls",
    ]) {
      expect(inferSafety(name)).toBe("write");
    }
  });

  it("requires a camelCase boundary so it doesn't match words that merely start with a prefix", () => {
    // "isolate" starts with "is" but isn't a getter.
    expect(inferSafety("isolate")).toBe("write");
    expect(inferSafety("hashPassword")).toBe("write");
    // A bare verb with no suffix is still a getter.
    expect(inferSafety("list")).toBe("read");
  });
});

describe("mergePluginDoc", () => {
  it("uses the baseline when no curation exists", () => {
    const doc = mergePluginDoc({ meta, status: "loaded", baseline: baseline() });
    expect(doc.methods.map((m) => m.name)).toEqual(["getStatus", "setValue"]);
    expect(doc.summary).toBe("A demo plugin");
    expect(doc.degraded).toBe(false);
  });

  it("prefers the curated summary over the manifest description", () => {
    const doc = mergePluginDoc({
      meta: { ...meta, agent: { summary: "Curated summary" } },
      status: "loaded",
      baseline: baseline(),
    });
    expect(doc.summary).toBe("Curated summary");
  });

  it("lets curation override description, safety, example and notes", () => {
    const doc = mergePluginDoc({
      meta: {
        ...meta,
        agent: {
          methods: {
            setValue: {
              description: "Sets the thing.",
              safety: "destructive",
              example: { args: [12] },
              notes: "Takes effect immediately.",
            },
          },
        },
      },
      status: "loaded",
      baseline: baseline(),
    });

    const setValue = doc.methods.find((m) => m.name === "setValue")!;
    expect(setValue.description).toBe("Sets the thing.");
    expect(setValue.safety).toBe("destructive");
    expect(setValue.example).toEqual({ args: [12] });
    expect(setValue.notes).toBe("Takes effect immediately.");
  });

  it("marks a curated safety class as declared and an uncurated one as inferred", () => {
    const doc = mergePluginDoc({
      meta: { ...meta, agent: { methods: { setValue: { safety: "write" } } } },
      status: "loaded",
      baseline: baseline(),
    });

    expect(doc.methods.find((m) => m.name === "setValue")!.safetyInferred).toBe(false);
    expect(doc.methods.find((m) => m.name === "getStatus")!.safetyInferred).toBe(true);
  });

  it("keeps the generated signature when curation only supplies prose", () => {
    const doc = mergePluginDoc({
      meta: {
        ...meta,
        agent: { methods: { setValue: { description: "Just prose." } } },
      },
      status: "loaded",
      baseline: baseline(),
    });

    const setValue = doc.methods.find((m) => m.name === "setValue")!;
    expect(setValue.args).toEqual([{ name: "value", schema: { type: "number" }, optional: false }]);
  });

  it("drops hidden methods", () => {
    const doc = mergePluginDoc({
      meta: { ...meta, agent: { methods: { setValue: { hidden: true } } } },
      status: "loaded",
      baseline: baseline(),
    });
    expect(doc.methods.map((m) => m.name)).toEqual(["getStatus"]);
  });

  it("sorts methods by name for stable output", () => {
    const doc = mergePluginDoc({
      meta,
      status: "loaded",
      baseline: baseline({
        methods: [
          {
            name: "zeta",
            args: [],
            returns: { type: "null" },
            safety: "write",
          },
          {
            name: "alpha",
            args: [],
            returns: { type: "null" },
            safety: "write",
          },
        ],
      }),
    });
    expect(doc.methods.map((m) => m.name)).toEqual(["alpha", "zeta"]);
  });

  it("falls back to reflected method names and flags the doc degraded", () => {
    const doc = mergePluginDoc({
      meta,
      status: "loaded",
      methodNames: ["getThings", "doThing"],
    });

    expect(doc.degraded).toBe(true);
    expect(doc.methods.map((m) => m.name)).toEqual(["doThing", "getThings"]);
    expect(doc.methods.every((m) => m.returns.type === "unknown")).toBe(true);
    expect(doc.methods.find((m) => m.name === "getThings")!.safety).toBe("read");
    expect(doc.methods.find((m) => m.name === "doThing")!.safety).toBe("write");
  });

  it("carries the plugin status through", () => {
    const doc = mergePluginDoc({
      meta,
      status: "disabled",
      baseline: baseline(),
    });
    expect(doc.status).toBe("disabled");
  });
});

describe("baselineFromMethodNames", () => {
  it("says explicitly that signatures are undocumented", () => {
    const doc = baselineFromMethodNames("demo", ["getThings"]);
    expect(doc.methods[0]!.notes).toContain("Signature not documented");
    expect(doc.methods[0]!.returns.type).toBe("unknown");
  });
});

describe("countBySafety / toIndexEntry", () => {
  it("counts each class", () => {
    const doc = mergePluginDoc({ meta, status: "loaded", baseline: baseline() });
    expect(countBySafety(doc.methods)).toEqual({
      read: 1,
      write: 1,
      destructive: 0,
    });
  });

  it("builds an index entry with an escaped href", () => {
    const doc = mergePluginDoc({
      meta: { ...meta, id: "__core:game-library", name: "Game Library" },
      status: "loaded",
      baseline: baseline(),
    });
    expect(toIndexEntry(doc).href).toBe("/api/agent/__core%3Agame-library");
  });
});

describe("requiresWriteOptIn", () => {
  it("gates writes and destructive calls but not reads", () => {
    const [read, write] = mergePluginDoc({
      meta,
      status: "loaded",
      baseline: baseline(),
    }).methods;
    expect(requiresWriteOptIn(read!)).toBe(false);
    expect(requiresWriteOptIn(write!)).toBe(true);
  });
});
