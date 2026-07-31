import { describe, it, expect } from "bun:test";
import { mergePluginDoc, type ResolvedPluginDoc } from "./merge";
import {
  formatSchema,
  renderCallingConvention,
  renderIndexMarkdown,
  renderPluginMarkdown,
  type RenderContext,
} from "./render";

const ctx: RenderContext = {
  origin: "http://127.0.0.1:33820",
  version: "0.7.2",
  writesEnabled: false,
};

describe("formatSchema", () => {
  it("renders primitives", () => {
    expect(formatSchema({ type: "string" })).toBe("string");
    expect(formatSchema({ type: "number" })).toBe("number");
    expect(formatSchema({ type: "boolean" })).toBe("boolean");
  });

  it("renders arrays and nested arrays", () => {
    expect(formatSchema({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(
      formatSchema({
        type: "array",
        items: { type: "array", items: { type: "number" } },
      }),
    ).toBe("number[][]");
  });

  it("renders literal unions as an enum", () => {
    expect(formatSchema({ type: "string", enum: ["low", "high"] })).toBe('"low" | "high"');
  });

  it("renders objects with optionality", () => {
    expect(
      formatSchema({
        type: "object",
        properties: { a: { type: "number" }, b: { type: "string" } },
        required: ["a"],
      }),
    ).toBe("{ a: number; b?: string }");
  });

  it("shows the real TypeScript when the generator could not lower the type", () => {
    expect(formatSchema({ type: "unknown", tsType: "Map<string, Timer>" })).toBe(
      "Map<string, Timer>",
    );
  });

  it("appends null for nullable types", () => {
    expect(formatSchema({ type: "string", nullable: true })).toBe("string | null");
  });
});

function demo(overrides: Partial<ResolvedPluginDoc> = {}): ResolvedPluginDoc {
  return {
    ...mergePluginDoc({
      meta: {
        id: "tdp-control",
        name: "TDP Control",
        description: "Adjust the APU power limit",
        category: "Performance",
        agent: {
          methods: {
            setTdp: {
              safety: "write",
              description: "Set the sustained power limit.",
              example: { args: [12] },
            },
          },
        },
      },
      status: "loaded",
      baseline: {
        id: "tdp-control",
        generatorVersion: 1,
        methods: [
          {
            name: "getTdpInfo",
            args: [],
            returns: {
              type: "object",
              properties: { watts: { type: "number" } },
              required: ["watts"],
            },
            safety: "read",
          },
          {
            name: "setTdp",
            args: [
              {
                name: "watts",
                schema: { type: "number" },
                optional: false,
                description: "Target wattage",
              },
            ],
            returns: { type: "null" },
            safety: "write",
          },
        ],
        events: [{ event: "tdpChanged", description: "Fired after a limit change" }],
      },
    }),
    ...overrides,
  };
}

describe("renderCallingConvention", () => {
  it("explains the token bootstrap and the rpc call", () => {
    const md = renderCallingConvention(ctx);
    expect(md).toContain("/api/token");
    expect(md).toContain("/api/rpc");
    expect(md).toContain("Authorization: Bearer");
  });

  it("says writes are disabled and how to opt in", () => {
    const md = renderCallingConvention(ctx);
    expect(md).toContain("disabled");
    expect(md).toContain("X-Loadout-Agent-Write: 1");
  });

  it("says writes are enabled when they are", () => {
    const md = renderCallingConvention({ ...ctx, writesEnabled: true });
    expect(md).toContain("**enabled**");
    expect(md).not.toContain("X-Loadout-Agent-Write");
  });
});

describe("renderIndexMarkdown", () => {
  it("groups plugins by category with method counts", () => {
    const md = renderIndexMarkdown([demo()], ctx);
    expect(md).toContain("### Performance");
    expect(md).toContain("`tdp-control`");
    expect(md).toContain("1r / 1w / 0d");
  });

  it("names the version and where to fetch per-plugin docs", () => {
    const md = renderIndexMarkdown([demo()], ctx);
    expect(md).toContain("v0.7.2");
    expect(md).toContain("/api/agent/<plugin-id>");
  });

  it("separates plugins that are installed but not callable", () => {
    const md = renderIndexMarkdown([demo(), demo({ id: "wifi", status: "disabled" })], ctx);
    expect(md).toContain("Installed but not callable");
    expect(md).toContain("`wifi` — disabled");
  });

  it("omits the unavailable section entirely when everything is loaded", () => {
    expect(renderIndexMarkdown([demo()], ctx)).not.toContain("Installed but not callable");
  });

  it("falls back to an Other category for uncategorised plugins", () => {
    const md = renderIndexMarkdown([demo({ category: undefined })], ctx);
    expect(md).toContain("### Other");
  });

  it("is deterministic", () => {
    expect(renderIndexMarkdown([demo()], ctx)).toBe(renderIndexMarkdown([demo()], ctx));
  });
});

describe("renderPluginMarkdown", () => {
  it("renders a signature, safety class and argument table", () => {
    const md = renderPluginMarkdown(demo(), ctx);
    expect(md).toContain("setTdp(watts: number) => null");
    expect(md).toContain("getTdpInfo() => { watts: number }");
    expect(md).toContain("| `watts` | `number` | yes | Target wattage |");
  });

  it("marks an inferred safety class as inferred and a declared one as not", () => {
    const md = renderPluginMarkdown(demo(), ctx);
    // getTdpInfo has no curation -> inferred.
    expect(md).toMatch(/### `getTdpInfo`[\s\S]*?\*\*Safety:\*\* read \*\(inferred\)\*/);
    // setTdp is curated -> declared.
    expect(md).toMatch(/### `setTdp`[\s\S]*?\*\*Safety:\*\* write\n/);
  });

  it("emits a runnable curl example for curated examples", () => {
    const md = renderPluginMarkdown(demo(), ctx);
    expect(md).toContain(`-d '{"plugin":"tdp-control","method":"setTdp","args":[12]}'`);
  });

  it("documents events with the websocket subscribe URL", () => {
    const md = renderPluginMarkdown(demo(), ctx);
    expect(md).toContain("ws://127.0.0.1:33820/ws?token=<token>");
    expect(md).toContain("`tdpChanged`");
  });

  it("warns loudly when the plugin is not callable", () => {
    const md = renderPluginMarkdown(demo({ status: "disabled" }), ctx);
    expect(md).toContain("**This plugin is disabled");
  });

  it("warns when signatures were reflected rather than generated", () => {
    const md = renderPluginMarkdown(demo({ degraded: true }), ctx);
    expect(md).toContain("Signatures unavailable");
  });

  it("handles a plugin with no methods", () => {
    const md = renderPluginMarkdown(demo({ methods: [] }), ctx);
    expect(md).toContain("exposes no callable methods");
  });
});
