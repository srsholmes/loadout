import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Force the loader-index → routes barrel to evaluate top-down first; the
// route modules import `jsonResponse` from `../index`, which imports
// `./routes`, which imports them back. Same convention as
// `self-update.test.ts` / `rpc.test.ts`.
import "../index";
import { agentCallRoute, agentIndexRoute, agentPluginRoute, AGENT_WRITE_HEADER } from "./agent";
import type { RouteContext } from "./types";

/**
 * These exercise the routes against a synthetic RouteContext plus a real
 * temp `plugins/` dir — the `agent.json` lookup is a filesystem read, so
 * faking it away would skip the part most likely to break (a plugin id
 * that doesn't match its directory, a missing file, a corrupt file).
 */

let pluginsDir: string;
let configHome: string;
let previousConfigHome: string | undefined;

beforeEach(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), "agent-routes-"));
  // The write gate consults `~/.config/loadout/config.json`. Point
  // XDG_CONFIG_HOME at an empty tmpdir so these tests assert the shipped
  // default (writes off) rather than whatever the developer running them
  // happens to have enabled. `configDir()` reads the env var per call, so
  // this takes effect without reloading the module.
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  configHome = mkdtempSync(join(tmpdir(), "agent-config-"));
  process.env.XDG_CONFIG_HOME = configHome;
});

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

/** Turn the config-file half of the write gate on for one test. */
function enableWritesInConfig(): void {
  mkdirSync(join(configHome, "loadout"), { recursive: true });
  writeFileSync(join(configHome, "loadout", "config.json"), JSON.stringify({ agentWrites: true }));
}

function writeAgentJson(pluginId: string, doc: unknown): void {
  const dir = join(pluginsDir, pluginId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.json"), JSON.stringify(doc));
}

const DEMO_DOC = {
  id: "demo",
  generatorVersion: 1,
  methods: [
    {
      name: "getThing",
      args: [],
      returns: { type: "string" },
      safety: "read",
      safetyInferred: true,
    },
    {
      name: "setThing",
      args: [{ name: "v", schema: { type: "number" }, optional: false }],
      returns: { type: "null" },
      safety: "write",
      safetyInferred: true,
    },
  ],
};

interface CtxOpts {
  status?: "loaded" | "disabled" | "error";
  agent?: unknown;
  rpcHandler?: (message: string) => Promise<string | null>;
}

function makeCtx(opts: CtxOpts = {}): RouteContext {
  const status = opts.status ?? "loaded";
  const meta = {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    description: "A demo plugin",
    category: "Tools",
    ...(opts.agent ? { agent: opts.agent } : {}),
  };
  const instance = {
    async getThing() {
      return "x";
    },
    async setThing(_v: number) {},
  };

  return {
    pluginsDir,
    registry: new Map([["demo", { meta, hasApp: false, hasBackend: true, status }]]),
    plugins:
      status === "loaded" ? new Map([["demo", { meta, instance, hasApp: false }]]) : new Map(),
    rpcHandler:
      opts.rpcHandler ??
      (async (message: string) => {
        const req = JSON.parse(message) as { id: string };
        return JSON.stringify({ id: req.id, result: "ok" });
      }),
  } as unknown as RouteContext;
}

const INDEX_URL = new URL("http://127.0.0.1:33820/api/agent");

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:33820${path}`, { headers });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:33820${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("route matching", () => {
  it("matches the index with and without a trailing slash", () => {
    expect(agentIndexRoute.match(get("/api/agent"), INDEX_URL)).toBe(true);
    expect(
      agentIndexRoute.match(get("/api/agent/"), new URL("http://127.0.0.1:33820/api/agent/")),
    ).toBe(true);
  });

  it("routes /api/agent/call to the call route, not the plugin route", () => {
    const url = new URL("http://127.0.0.1:33820/api/agent/call");
    const req = post("/api/agent/call", {});
    expect(agentCallRoute.match(req, url)).toBe(true);
    // The plugin route's `/api/agent/(.+)` would otherwise swallow it;
    // it only matches GET, and the call route is registered first.
    expect(agentPluginRoute.match(req, url)).toBe(false);
  });

  it("matches a plugin doc path", () => {
    const url = new URL("http://127.0.0.1:33820/api/agent/demo");
    expect(agentPluginRoute.match(get("/api/agent/demo"), url)).toBe(true);
  });
});

describe("GET /api/agent", () => {
  it("renders Markdown by default", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentIndexRoute.handle(get("/api/agent"), INDEX_URL, makeCtx());

    expect(res!.headers.get("Content-Type")).toContain("text/markdown");
    const body = await res!.text();
    expect(body).toContain("# Loadout — agent API");
    expect(body).toContain("`demo`");
    expect(body).toContain("1r / 1w / 0d");
  });

  it("renders JSON when asked", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentIndexRoute.handle(
      get("/api/agent", { accept: "application/json" }),
      INDEX_URL,
      makeCtx(),
    );

    const body = (await res!.json()) as {
      plugins: Array<{ id: string; methodCounts: Record<string, number> }>;
      rpc: { endpoint: string };
    };
    expect(body.plugins[0]!.id).toBe("demo");
    expect(body.plugins[0]!.methodCounts).toEqual({
      read: 1,
      write: 1,
      destructive: 0,
    });
    expect(body.rpc.endpoint).toBe("/api/rpc");
  });

  it("keeps Markdown for curl's default Accept: */*", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentIndexRoute.handle(
      get("/api/agent", { accept: "*/*" }),
      INDEX_URL,
      makeCtx(),
    );
    expect(res!.headers.get("Content-Type")).toContain("text/markdown");
  });

  it("honours ?format=json", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentIndexRoute.handle(
      get("/api/agent?format=json"),
      new URL("http://127.0.0.1:33820/api/agent?format=json"),
      makeCtx(),
    );
    expect(res!.headers.get("Content-Type")).toContain("application/json");
  });

  it("lists a disabled plugin separately rather than hiding it", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentIndexRoute.handle(
      get("/api/agent"),
      INDEX_URL,
      makeCtx({ status: "disabled" }),
    );
    const body = await res!.text();
    expect(body).toContain("Installed but not callable");
    expect(body).toContain("`demo` — disabled");
  });

  it("omits a plugin that opts out via agent.hidden", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentIndexRoute.handle(
      get("/api/agent"),
      INDEX_URL,
      makeCtx({ agent: { hidden: true } }),
    );
    expect(await res!.text()).not.toContain("`demo`");
  });
});

describe("GET /api/agent/<id>", () => {
  const pluginUrl = new URL("http://127.0.0.1:33820/api/agent/demo");

  it("renders the plugin's methods with signatures", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentPluginRoute.handle(get("/api/agent/demo"), pluginUrl, makeCtx());
    const body = await res!.text();
    expect(body).toContain("# Demo (`demo`)");
    expect(body).toContain("setThing(v: number) => null");
  });

  it("merges curation over the generated baseline", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentPluginRoute.handle(
      get("/api/agent/demo"),
      pluginUrl,
      makeCtx({
        agent: {
          methods: {
            setThing: { safety: "destructive", description: "Wipes it." },
          },
        },
      }),
    );
    const body = await res!.text();
    expect(body).toContain("Wipes it.");
    // Curated, so it must not be labelled a guess.
    expect(body).toMatch(/### `setThing`[\s\S]*?\*\*Safety:\*\* destructive\n/);
  });

  it("falls back to reflected method names when no agent.json shipped", async () => {
    // Deliberately not writing agent.json.
    const res = await agentPluginRoute.handle(get("/api/agent/demo"), pluginUrl, makeCtx());
    const body = await res!.text();
    expect(body).toContain("Signatures unavailable");
    expect(body).toContain("`getThing`");
  });

  it("ignores an agent.json whose id doesn't match its directory", async () => {
    writeAgentJson("demo", { ...DEMO_DOC, id: "somethingelse" });
    const res = await agentPluginRoute.handle(get("/api/agent/demo"), pluginUrl, makeCtx());
    // Falls back rather than attributing another plugin's methods here.
    expect(await res!.text()).toContain("Signatures unavailable");
  });

  it("404s an unknown plugin with a pointer to the index", async () => {
    const res = await agentPluginRoute.handle(
      get("/api/agent/nope"),
      new URL("http://127.0.0.1:33820/api/agent/nope"),
      makeCtx(),
    );
    expect(res!.status).toBe(404);
    expect((await res!.json()).hint).toContain("/api/agent");
  });
});

describe("POST /api/agent/call", () => {
  const callUrl = new URL("http://127.0.0.1:33820/api/agent/call");

  it("dispatches a read without any opt-in", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo", method: "getThing" }),
      callUrl,
      makeCtx(),
    );
    expect(res!.status).toBe(200);
    expect((await res!.json()).result).toBe("ok");
  });

  it("403s a write without the opt-in, and says how to opt in", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo", method: "setThing", args: [1] }),
      callUrl,
      makeCtx(),
    );

    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { safety: string; hint: string };
    expect(body.safety).toBe("write");
    expect(body.hint).toContain(AGENT_WRITE_HEADER);
  });

  it("dispatches a write when the opt-in header is present", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentCallRoute.handle(
      post(
        "/api/agent/call",
        { plugin: "demo", method: "setThing", args: [1] },
        { [AGENT_WRITE_HEADER]: "1" },
      ),
      callUrl,
      makeCtx(),
    );
    expect(res!.status).toBe(200);
  });

  it("dispatches a write when agentWrites is set in the config file", async () => {
    writeAgentJson("demo", DEMO_DOC);
    enableWritesInConfig();
    const res = await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo", method: "setThing", args: [1] }),
      callUrl,
      makeCtx(),
    );
    expect(res!.status).toBe(200);
  });

  it("respects a curated read classification", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo", method: "setThing", args: [1] }),
      callUrl,
      makeCtx({ agent: { methods: { setThing: { safety: "read" } } } }),
    );
    expect(res!.status).toBe(200);
  });

  it("409s a disabled plugin rather than pretending the method is missing", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo", method: "getThing" }),
      callUrl,
      makeCtx({ status: "disabled" }),
    );
    expect(res!.status).toBe(409);
    expect((await res!.json()).error).toContain("disabled");
  });

  it("404s an unknown method with a pointer to the plugin's docs", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo", method: "nope" }),
      callUrl,
      makeCtx(),
    );
    expect(res!.status).toBe(404);
    expect((await res!.json()).hint).toContain("/api/agent/demo");
  });

  it("400s a malformed body", async () => {
    const res = await agentCallRoute.handle(
      post("/api/agent/call", "not json"),
      callUrl,
      makeCtx(),
    );
    expect(res!.status).toBe(400);
  });

  it("400s a body missing plugin or method", async () => {
    const res = await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo" }),
      callUrl,
      makeCtx(),
    );
    expect(res!.status).toBe(400);
  });

  it("surfaces a plugin error as HTTP 500 (audit A-028 convention)", async () => {
    writeAgentJson("demo", DEMO_DOC);
    const res = await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo", method: "getThing" }),
      callUrl,
      makeCtx({
        rpcHandler: async (message: string) => {
          const req = JSON.parse(message) as { id: string };
          return JSON.stringify({ id: req.id, error: "boom" });
        },
      }),
    );
    expect(res!.status).toBe(500);
    expect((await res!.json()).error).toBe("boom");
  });

  it("always sends an id to the dispatcher", async () => {
    writeAgentJson("demo", DEMO_DOC);
    let seen: Record<string, unknown> = {};
    await agentCallRoute.handle(
      post("/api/agent/call", { plugin: "demo", method: "getThing" }),
      callUrl,
      makeCtx({
        rpcHandler: async (message: string) => {
          seen = JSON.parse(message);
          return JSON.stringify({ id: seen.id, result: null });
        },
      }),
    );
    expect(typeof seen.id).toBe("string");
    expect(seen.args).toEqual([]);
  });
});
