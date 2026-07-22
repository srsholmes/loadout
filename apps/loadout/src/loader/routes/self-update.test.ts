import { describe, expect, test } from "bun:test";
// Force the loader-index → routes barrel to evaluate top-down first.
// The route modules import `jsonResponse` from `../index`, which imports
// `./routes`, which imports the route modules back — importing a single
// route module first would hit that cycle mid-init (TDZ on the routes
// array). Pulling `../index` in first resolves the graph in the same
// order the running server does.
import "../index";
import { selfUpdateRoute, restartRoute } from "./self-update";
import type { RouteContext } from "./types";

// The routes only touch `ctx.pluginsDir`; a bare cast covers the rest.
const ctx = { pluginsDir: "/tmp/does-not-matter/plugins" } as unknown as RouteContext;

function post(path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:33820${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("selfUpdateRoute", () => {
  test("GET returns the current status shape", async () => {
    const res = await selfUpdateRoute.handle(
      new Request("http://127.0.0.1:33820/api/self-update"),
      new URL("http://127.0.0.1:33820/api/self-update"),
      ctx,
    );
    expect(res!.status).toBe(200);
    const json = (await res!.json()) as { phase?: string };
    expect(typeof json.phase).toBe("string");
  });

  test("POST with a malformed tag is rejected 400 (never starts an update)", async () => {
    const req = post("/api/self-update", { tag: "rolling" });
    const res = await selfUpdateRoute.handle(
      req,
      new URL("http://127.0.0.1:33820/api/self-update"),
      ctx,
    );
    expect(res!.status).toBe(400);
  });

  test("POST with a downgrade tag is rejected 400", async () => {
    // currentVersion is "dev" under bun test, so any real tag is refused
    // as a dev-build guard — still a 400, still never starts.
    const req = post("/api/self-update", { tag: "v0.0.1" });
    const res = await selfUpdateRoute.handle(
      req,
      new URL("http://127.0.0.1:33820/api/self-update"),
      ctx,
    );
    expect(res!.status).toBe(400);
  });

  test("POST with a missing tag is 400", async () => {
    const req = post("/api/self-update", { notag: true });
    const res = await selfUpdateRoute.handle(
      req,
      new URL("http://127.0.0.1:33820/api/self-update"),
      ctx,
    );
    expect(res!.status).toBe(400);
  });

  test("invalid JSON body is 400", async () => {
    const req = new Request("http://127.0.0.1:33820/api/self-update", {
      method: "POST",
      body: "{not json",
    });
    const res = await selfUpdateRoute.handle(
      req,
      new URL("http://127.0.0.1:33820/api/self-update"),
      ctx,
    );
    expect(res!.status).toBe(400);
  });

  test("non-POST/GET method is 405", async () => {
    const req = new Request("http://127.0.0.1:33820/api/self-update", { method: "DELETE" });
    const res = await selfUpdateRoute.handle(
      req,
      new URL("http://127.0.0.1:33820/api/self-update"),
      ctx,
    );
    expect(res!.status).toBe(405);
  });
});

describe("restartRoute", () => {
  // NOTE: we deliberately don't call `restartRoute.handle` on the happy
  // path — it schedules a real `systemd-run … systemctl restart loadout`
  // via DEFAULT_DEPS, which is a live side effect the route doesn't let
  // us inject around. Match-level coverage is the safe surface here.
  test("matches only POST /api/restart", () => {
    expect(
      restartRoute.match(post("/api/restart"), new URL("http://127.0.0.1:33820/api/restart")),
    ).toBe(true);
    expect(
      restartRoute.match(
        new Request("http://127.0.0.1:33820/api/restart"),
        new URL("http://127.0.0.1:33820/api/restart"),
      ),
    ).toBe(false); // GET
  });
});
