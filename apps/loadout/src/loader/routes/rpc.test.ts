import { describe, it, expect } from "bun:test";
// Force the loader-index → routes barrel to evaluate top-down first.
// The route modules import `jsonResponse` from `../index`, which imports
// `./routes`, which imports the route modules back — importing a single
// route module first would hit that cycle mid-init (TDZ on the routes
// array). Same convention as `self-update.test.ts`.
import "../index";
import { rpcRoute } from "./rpc";
import type { RouteContext } from "./types";

/**
 * The HTTP RPC route. Its interesting behaviour is entirely in request
 * shaping: `createRpcHandler` drops any request missing `id`, `plugin`
 * or `method` by returning `null`, and the route used to surface all
 * three as an unexplained `{"error": "No response"}`. Over HTTP the
 * response *is* the correlation, so callers routinely omit `id` — the
 * route synthesises one.
 *
 * The ctx here fakes `rpcHandler` with the same null-on-missing-field
 * contract the real handler has (`rpc-handler.ts:59`), so a regression
 * that stops synthesising the id shows up as a failing assertion rather
 * than a silently-passing test.
 */
function makeCtx(overrides: Partial<RouteContext> = {}): {
  ctx: RouteContext;
  seen: Array<Record<string, unknown>>;
} {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = {
    rpcHandler: async (message: string) => {
      const req = JSON.parse(message) as Record<string, unknown>;
      seen.push(req);
      // Mirror the real handler's guard.
      if (!req.id || !req.plugin || !req.method) return null;
      return JSON.stringify({ id: req.id, result: { ok: true } });
    },
    broadcastToPlugins: async () => 0,
    ...overrides,
  } as unknown as RouteContext;
  return { ctx, seen };
}

function post(body: string): Request {
  return new Request("http://localhost:33820/api/rpc", {
    method: "POST",
    body,
  });
}

const url = new URL("http://localhost:33820/api/rpc");

describe("rpcRoute.match", () => {
  it("matches POST /api/rpc only", () => {
    expect(rpcRoute.match(post("{}"), url)).toBe(true);
    expect(rpcRoute.match(new Request("http://localhost:33820/api/rpc"), url)).toBe(false);
    expect(rpcRoute.match(post("{}"), new URL("http://localhost:33820/api/plugins"))).toBe(false);
  });
});

describe("rpcRoute — request id", () => {
  it("synthesises an id when the caller omits one", async () => {
    const { ctx, seen } = makeCtx();
    const res = await rpcRoute.handle(
      post(JSON.stringify({ plugin: "bluetooth", method: "getDevices" })),
      url,
      ctx,
    );

    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({
      id: seen[0]!.id as string,
      result: { ok: true },
    });
    expect(typeof seen[0]!.id).toBe("string");
    expect(seen[0]!.id as string).not.toBe("");
  });

  it("passes a caller-supplied id through untouched", async () => {
    const { ctx, seen } = makeCtx();
    const res = await rpcRoute.handle(
      post(
        JSON.stringify({
          id: "caller-chosen",
          plugin: "bluetooth",
          method: "getDevices",
        }),
      ),
      url,
      ctx,
    );

    expect(seen[0]!.id).toBe("caller-chosen");
    expect(await res!.json()).toMatchObject({ id: "caller-chosen" });
  });

  it("treats an empty-string id as absent", async () => {
    const { ctx, seen } = makeCtx();
    await rpcRoute.handle(
      post(JSON.stringify({ id: "", plugin: "bluetooth", method: "getDevices" })),
      url,
      ctx,
    );

    expect(seen[0]!.id).not.toBe("");
  });

  it("preserves args while adding the id", async () => {
    const { ctx, seen } = makeCtx();
    await rpcRoute.handle(
      post(
        JSON.stringify({
          plugin: "bluetooth",
          method: "connectDevice",
          args: ["AA:BB:CC"],
        }),
      ),
      url,
      ctx,
    );

    expect(seen[0]!.args).toEqual(["AA:BB:CC"]);
    expect(seen[0]!.method).toBe("connectDevice");
  });
});

describe("rpcRoute — malformed requests", () => {
  it("400s a body that isn't JSON, without calling the handler", async () => {
    const { ctx, seen } = makeCtx();
    const res = await rpcRoute.handle(post("not json"), url, ctx);

    expect(res!.status).toBe(400);
    expect((await res!.json()).error).toContain("Invalid JSON body");
    expect(seen).toHaveLength(0);
  });

  it("400s and names every missing required field", async () => {
    const { ctx, seen } = makeCtx();
    const res = await rpcRoute.handle(post("{}"), url, ctx);

    expect(res!.status).toBe(400);
    const { error } = (await res!.json()) as { error: string };
    expect(error).toContain("plugin");
    expect(error).toContain("method");
    expect(seen).toHaveLength(0);
  });

  it("400s when only method is missing", async () => {
    const { ctx } = makeCtx();
    const res = await rpcRoute.handle(post(JSON.stringify({ plugin: "bluetooth" })), url, ctx);

    const { error } = (await res!.json()) as { error: string };
    expect(res!.status).toBe(400);
    // Only `method` is listed — the trailing body-shape hint mentions
    // `plugin` too, so assert on the field list specifically.
    expect(error).toContain("Missing required field(s): method.");
  });
});

describe("rpcRoute — __broadcast", () => {
  it("fans out without needing an id", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const { ctx } = makeCtx({
      broadcastToPlugins: async (method: string, args: unknown[]) => {
        calls.push([method, args]);
        return 3;
      },
    } as Partial<RouteContext>);

    const res = await rpcRoute.handle(
      post(
        JSON.stringify({
          plugin: "__broadcast",
          method: "handleGameExit",
          args: [620],
        }),
      ),
      url,
      ctx,
    );

    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({
      ok: true,
      broadcast: "handleGameExit",
      called: 3,
    });
    expect(calls).toEqual([["handleGameExit", [620]]]);
  });
});

describe("rpcRoute — error envelopes", () => {
  it("returns HTTP 500 for a plugin error envelope (audit A-028)", async () => {
    const { ctx } = makeCtx({
      rpcHandler: async (message: string) => {
        const req = JSON.parse(message) as { id: string };
        return JSON.stringify({ id: req.id, error: "boom" });
      },
    } as Partial<RouteContext>);

    const res = await rpcRoute.handle(post(JSON.stringify({ plugin: "p", method: "m" })), url, ctx);

    expect(res!.status).toBe(500);
    expect((await res!.json()).error).toBe("boom");
  });
});
