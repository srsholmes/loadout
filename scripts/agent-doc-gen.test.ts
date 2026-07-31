import { describe, it, expect } from "bun:test";
import ts from "typescript";
import type { AgentMethodDoc } from "@loadout/types";
import { generateForBackend, isCallableMethodName, serializeDoc } from "./agent-doc-gen";

/**
 * The generator is exercised against synthetic backends compiled in
 * memory, not against the real plugin tree: the shipped plugins are a
 * moving target, and what needs pinning is the lowering behaviour for
 * each *kind* of type — which is much easier to state exactly with a
 * purpose-built fixture.
 */
const FIXTURE = "/virtual/backend.ts";

function compile(source: string): ts.Program {
  const files = new Map<string, string>([[FIXTURE, source]]);
  const host = ts.createCompilerHost({}, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);

  host.getSourceFile = (name, langVersion, onError, shouldCreate) => {
    const text = files.get(name);
    if (text !== undefined) {
      return ts.createSourceFile(name, text, langVersion, true);
    }
    return originalGetSourceFile(name, langVersion, onError, shouldCreate);
  };
  host.readFile = (name) => files.get(name) ?? originalReadFile(name);
  host.fileExists = (name) => files.has(name) || ts.sys.fileExists(name);

  return ts.createProgram([FIXTURE], { strict: true, noEmit: true }, host);
}

function methodsOf(source: string): Map<string, AgentMethodDoc> {
  const program = compile(source);
  const result = generateForBackend(program, "demo", FIXTURE);
  expect(result).not.toBeNull();
  return new Map(result!.doc.methods.map((m) => [m.name, m]));
}

describe("isCallableMethodName", () => {
  it("mirrors the RPC layer's exclusions", () => {
    expect(isCallableMethodName("getThings")).toBe(true);
    // Lifecycle hooks the dispatcher blocks.
    expect(isCallableMethodName("onLoad")).toBe(false);
    expect(isCallableMethodName("onUnload")).toBe(false);
    expect(isCallableMethodName("emit")).toBe(false);
    // Object.prototype members.
    expect(isCallableMethodName("toString")).toBe(false);
    expect(isCallableMethodName("hasOwnProperty")).toBe(false);
    // The underscore convention.
    expect(isCallableMethodName("_poll")).toBe(false);
  });
});

describe("method selection", () => {
  it("documents public methods and skips everything the RPC layer won't dispatch", () => {
    const methods = methodsOf(`
      export default class B {
        async onLoad(): Promise<void> {}
        async onUnload(): Promise<void> {}
        emit(_p: { event: string; data: unknown }): void {}
        async getThing(): Promise<string> { return "x"; }
        private async _helper(): Promise<void> {}
        private async alsoPrivate(): Promise<void> {}
        protected async prot(): Promise<void> {}
        static async stat(): Promise<void> {}
      }
    `);

    expect([...methods.keys()]).toEqual(["getThing"]);
  });

  it("returns null when the file isn't in the program", () => {
    const program = compile(`export default class B {}`);
    expect(generateForBackend(program, "demo", "/virtual/nope.ts")).toBeNull();
  });

  it("warns rather than throwing when there is no default-exported class", () => {
    const program = compile(`export class NotDefault {}`);
    const result = generateForBackend(program, "demo", FIXTURE)!;
    expect(result.doc.methods).toEqual([]);
    expect(result.warnings[0]).toContain("no default-exported class");
  });

  it("sorts methods by name so output is diff-stable", () => {
    const methods = methodsOf(`
      export default class B {
        async zulu(): Promise<void> {}
        async alpha(): Promise<void> {}
      }
    `);
    expect([...methods.keys()]).toEqual(["alpha", "zulu"]);
  });
});

describe("type lowering", () => {
  it("unwraps Promise and lowers primitives", () => {
    const m = methodsOf(`
      export default class B {
        async getText(): Promise<string> { return ""; }
        async getCount(): Promise<number> { return 0; }
        async getFlag(): Promise<boolean> { return true; }
        async doNothing(): Promise<void> {}
      }
    `);
    expect(m.get("getText")!.returns).toEqual({ type: "string" });
    expect(m.get("getCount")!.returns).toEqual({ type: "number" });
    expect(m.get("getFlag")!.returns).toEqual({ type: "boolean" });
    expect(m.get("doNothing")!.returns).toEqual({ type: "null" });
  });

  it("lowers arrays, including arrays of objects", () => {
    const m = methodsOf(`
      interface Item { id: string; n?: number }
      export default class B {
        async getItems(): Promise<Item[]> { return []; }
      }
    `);
    expect(m.get("getItems")!.returns).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, n: { type: "number" } },
        required: ["id"],
      },
    });
  });

  it("lowers string literal unions to an enum", () => {
    const m = methodsOf(`
      export default class B {
        async getMode(): Promise<"low" | "high"> { return "low"; }
      }
    `);
    expect(m.get("getMode")!.returns).toEqual({
      type: "string",
      enum: ["low", "high"],
    });
  });

  it("does not mistake boolean for a two-member enum", () => {
    const m = methodsOf(`
      export default class B {
        async getFlag(): Promise<boolean> { return true; }
      }
    `);
    expect(m.get("getFlag")!.returns).toEqual({ type: "boolean" });
  });

  it("records nullability as a flag rather than a union", () => {
    const m = methodsOf(`
      export default class B {
        async getName(): Promise<string | null> { return null; }
      }
    `);
    expect(m.get("getName")!.returns).toEqual({
      type: "string",
      nullable: true,
    });
  });

  it("merges intersections instead of degrading them to unknown", () => {
    const m = methodsOf(`
      interface Base { ok: boolean }
      export default class B {
        async getResult(): Promise<Base & { extra?: string }> {
          return { ok: true };
        }
      }
    `);
    expect(m.get("getResult")!.returns).toEqual({
      type: "object",
      properties: { ok: { type: "boolean" }, extra: { type: "string" } },
      required: ["ok"],
    });
  });

  it("falls back to the printed TypeScript for types it cannot lower", () => {
    const m = methodsOf(`
      interface A { a: string }
      interface C { c: string }
      export default class B {
        async getEither(): Promise<A | C> { return { a: "" }; }
      }
    `);
    const returns = m.get("getEither")!.returns;
    expect(returns.type).toBe("unknown");
    // The real signature is far more useful to a reader than "unknown".
    expect(returns.tsType).toBe("A | C");
  });

  it("treats an index-signature-only type as a bare object", () => {
    const m = methodsOf(`
      export default class B {
        async getMap(): Promise<Record<string, unknown>> { return {}; }
      }
    `);
    expect(m.get("getMap")!.returns).toEqual({ type: "object" });
  });

  it("stops recursing on self-referential types instead of hanging", () => {
    const m = methodsOf(`
      interface Node { name: string; child: Node }
      export default class B {
        async getTree(): Promise<Node> { return null as never; }
      }
    `);
    // Terminates, and the outer levels are still described.
    expect(m.get("getTree")!.returns.type).toBe("object");
    expect(m.get("getTree")!.returns.properties?.name).toEqual({
      type: "string",
    });
  });
});

describe("arguments", () => {
  it("captures names, types and optionality", () => {
    const m = methodsOf(`
      export default class B {
        async setThing(name: string, count?: number, flag = false): Promise<void> {}
      }
    `);
    expect(m.get("setThing")!.args).toEqual([
      { name: "name", schema: { type: "string" }, optional: false },
      { name: "count", schema: { type: "number" }, optional: true },
      { name: "flag", schema: { type: "boolean" }, optional: true },
    ]);
  });

  it("picks up @param descriptions", () => {
    const m = methodsOf(`
      export default class B {
        /**
         * Set the power limit.
         * @param watts Target wattage
         */
        async setTdp(watts: number): Promise<void> {}
      }
    `);
    const method = m.get("setTdp")!;
    expect(method.description).toBe("Set the power limit.");
    expect(method.args[0]!.description).toBe("Target wattage");
  });
});

describe("descriptions", () => {
  it("takes the first paragraph of the JSDoc, collapsed", () => {
    const m = methodsOf(`
      export default class B {
        /**
         * First paragraph
         * wraps across lines.
         *
         * Second paragraph is design rationale nobody needs inline.
         */
        async getThing(): Promise<void> {}
      }
    `);
    expect(m.get("getThing")!.description).toBe("First paragraph wraps across lines.");
  });

  it("omits the field entirely when there is no JSDoc", () => {
    const m = methodsOf(`
      export default class B {
        async getThing(): Promise<void> {}
      }
    `);
    expect(m.get("getThing")!.description).toBeUndefined();
  });
});

describe("safety", () => {
  it("infers and flags every method as inferred (curation happens later)", () => {
    const m = methodsOf(`
      export default class B {
        async getThing(): Promise<void> {}
        async setThing(): Promise<void> {}
      }
    `);
    expect(m.get("getThing")!.safety).toBe("read");
    expect(m.get("setThing")!.safety).toBe("write");
    expect(m.get("getThing")!.safetyInferred).toBe(true);
  });
});

describe("events", () => {
  it("collects literal event names from emit calls, deduped and sorted", () => {
    const program = compile(`
      export default class B {
        emit?: (p: { event: string; data: unknown }) => void;
        async a(): Promise<void> {
          this.emit?.({ event: "zulu", data: {} });
          this.emit?.({ event: "alpha", data: {} });
        }
        async b(): Promise<void> {
          this.emit?.({ event: "alpha", data: {} });
        }
      }
    `);
    const doc = generateForBackend(program, "demo", FIXTURE)!.doc;
    expect(doc.events).toEqual([{ event: "alpha" }, { event: "zulu" }]);
  });

  it("skips computed event names rather than guessing", () => {
    const program = compile(`
      export default class B {
        emit?: (p: { event: string; data: unknown }) => void;
        async a(name: string): Promise<void> {
          this.emit?.({ event: name, data: {} });
        }
      }
    `);
    expect(generateForBackend(program, "demo", FIXTURE)!.doc.events).toBeUndefined();
  });
});

describe("serializeDoc", () => {
  it("is stable, indented and newline-terminated", () => {
    const out = serializeDoc({ id: "x", generatorVersion: 1, methods: [] });
    expect(out).toBe('{\n  "id": "x",\n  "generatorVersion": 1,\n  "methods": []\n}\n');
  });
});
