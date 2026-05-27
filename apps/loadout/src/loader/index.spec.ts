/**
 * Tests for the top-level uncaughtException re-throw policy (Audit
 * 2026-05 A-009). The handler itself runs at import-time on the live
 * process, so we test the pure decision functions instead.
 */

import { describe, expect, it } from "bun:test";
import {
  isDebugMode,
  jsonErrorResponse,
  jsonResponse,
  shouldIgnoreReloadFilename,
  shouldRethrowUncaught,
} from "./index";

describe("isDebugMode", () => {
  it("returns true when LOADOUT_DEBUG=1", () => {
    expect(isDebugMode({ LOADOUT_DEBUG: "1" }, [])).toBe(true);
  });

  it("returns true when --debug is in argv", () => {
    expect(isDebugMode({}, ["bun", "loader", "--debug"])).toBe(true);
  });

  it("returns false in plain production env", () => {
    expect(isDebugMode({}, ["bun", "loader"])).toBe(false);
  });

  it("ignores LOADOUT_DEBUG values other than '1'", () => {
    // Strict "1" check so the obvious "0" / "false" / "" don't slip
    // through if an operator tries to disable it. Be explicit.
    expect(isDebugMode({ LOADOUT_DEBUG: "0" }, [])).toBe(false);
    expect(isDebugMode({ LOADOUT_DEBUG: "true" }, [])).toBe(false);
    expect(isDebugMode({ LOADOUT_DEBUG: "" }, [])).toBe(false);
  });
});

describe("shouldRethrowUncaught", () => {
  it("re-throws all uncaught exceptions in debug mode", () => {
    const err = new Error("plugin blew up");
    expect(shouldRethrowUncaught(err, true)).toBe(true);
  });

  it("swallows non-fatal uncaught exceptions in production mode", () => {
    const err = new Error("plugin blew up");
    expect(shouldRethrowUncaught(err, false)).toBe(false);
  });

  it("always re-throws OOM errors, even in production", () => {
    // Out of memory is unrecoverable — continuing just crashes worse later.
    const oom = new Error("FATAL ERROR: out of memory");
    expect(shouldRethrowUncaught(oom, false)).toBe(true);
    expect(shouldRethrowUncaught(oom, true)).toBe(true);
  });

  it("handles errors with no message safely", () => {
    const err = new Error();
    expect(shouldRethrowUncaught(err, false)).toBe(false);
    expect(shouldRethrowUncaught(err, true)).toBe(true);
  });
});

/**
 * Audit A-023: building a plugin writes into its `.cache/` dir (Bun's
 * module cache). The hot-reload watcher used to filter only `.build`,
 * so building → reload event → rebuild → reload event → infinite loop.
 * The predicate now also ignores `.cache` and `node_modules`.
 */
describe("shouldIgnoreReloadFilename (A-023)", () => {
  it("ignores null filenames (watcher emits null on rename batches)", () => {
    expect(shouldIgnoreReloadFilename(null)).toBe(true);
  });
  it("ignores `.cache` (and nested paths under it)", () => {
    expect(shouldIgnoreReloadFilename(".cache")).toBe(true);
    expect(shouldIgnoreReloadFilename(".cache/foo.js")).toBe(true);
    expect(shouldIgnoreReloadFilename("subdir/.cache/foo.js")).toBe(true);
  });
  it("ignores `.build` (preserved from the original rule)", () => {
    expect(shouldIgnoreReloadFilename(".build")).toBe(true);
    expect(shouldIgnoreReloadFilename(".build/index.js")).toBe(true);
  });
  it("ignores `node_modules`", () => {
    expect(shouldIgnoreReloadFilename("node_modules/foo/index.js")).toBe(true);
    expect(shouldIgnoreReloadFilename("inner/node_modules/foo.js")).toBe(true);
  });
  it("does NOT ignore actual source files", () => {
    expect(shouldIgnoreReloadFilename("backend.ts")).toBe(false);
    expect(shouldIgnoreReloadFilename("app.tsx")).toBe(false);
    expect(shouldIgnoreReloadFilename("plugin.json")).toBe(false);
    expect(shouldIgnoreReloadFilename("src/file.ts")).toBe(false);
  });
});

/**
 * Audit A-028: `jsonResponse({error:...})` previously returned HTTP 200,
 * so HTTP clients had to parse the body to distinguish success from
 * failure. `jsonErrorResponse` now wraps the same shape with a 4xx/5xx
 * status; the original helper still defaults to 200 for success.
 */
describe("jsonResponse / jsonErrorResponse (A-028)", () => {
  it("jsonResponse defaults to 200 for success envelopes", async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("jsonErrorResponse defaults to 500 for error envelopes", async () => {
    const res = jsonErrorResponse({ error: "boom" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });

  it("jsonErrorResponse accepts an explicit status (400 for bad input)", async () => {
    const res = jsonErrorResponse({ error: "Missing appId" }, 400);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing appId" });
  });

  it("jsonResponse accepts an explicit status (e.g. 202 accepted)", () => {
    const res = jsonResponse({ queued: true }, 202);
    expect(res.status).toBe(202);
  });
});

// `steamGridCandidates` tests moved to routes/steam-grid.spec.ts
// during the A-001 extraction.
