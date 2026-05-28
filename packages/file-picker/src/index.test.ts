import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Unit-tests for the pure helpers inside `@loadout/file-picker`.
 * The `pickFile` happy-path spawns external processes (zenity /
 * kdialog / yad) and is hard to unit-test without a DBUS / X11
 * harness — covered by manual verification.
 *
 * This spec pins:
 *   - `resolveStartDirectory` fallback chain (explicit → ~/Downloads
 *     → ~ → ".")
 *   - `resolveX11Env` runtime-dir probe + `~/.Xauthority` fallback
 *   - `pickFile`'s "no picker installed" return-null path
 */

const origHome = process.env.HOME;
const origXdgRuntime = process.env.XDG_RUNTIME_DIR;
const origDisplay = process.env.DISPLAY;
const origXauth = process.env.XAUTHORITY;
let sandboxRoot = "";

// Force the picker registry to look-empty so pickFile exits before
// running any external process. No test exercises the happy path, so
// a no-op stub is enough.
mock.module("@loadout/exec", () => ({
  commandExists: async (_name: string) => false,
  runFull: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
}));

function restoreEnv(name: string, original: string | undefined): void {
  if (original !== undefined) process.env[name] = original;
  else delete process.env[name];
}

beforeEach(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "file-picker-spec-"));
});

afterEach(async () => {
  restoreEnv("HOME", origHome);
  restoreEnv("XDG_RUNTIME_DIR", origXdgRuntime);
  restoreEnv("DISPLAY", origDisplay);
  restoreEnv("XAUTHORITY", origXauth);
  await rm(sandboxRoot, { recursive: true, force: true });
});

describe("resolveStartDirectory", () => {
  it("uses an explicit startDirectory when it exists on disk", async () => {
    process.env.HOME = "/nonexistent-home-1";
    const { resolveStartDirectory } = await import("./index");
    expect(resolveStartDirectory(sandboxRoot)).toBe(sandboxRoot);
  });

  it("falls through past a missing explicit path to find $HOME/Downloads", async () => {
    // Regression guard: an explicit path that doesn't exist must
    // ALSO trigger the Downloads probe — not skip straight to $HOME.
    const downloads = join(sandboxRoot, "Downloads");
    await mkdir(downloads);
    process.env.HOME = sandboxRoot;
    const { resolveStartDirectory } = await import("./index");
    expect(resolveStartDirectory("/no/such/path")).toBe(downloads);
  });

  it("falls back to $HOME when neither the explicit path nor Downloads exists", async () => {
    process.env.HOME = sandboxRoot; // exists, no Downloads subdir
    const { resolveStartDirectory } = await import("./index");
    expect(resolveStartDirectory()).toBe(sandboxRoot);
  });

  it("falls back to '.' when HOME is unset and no Downloads is reachable", async () => {
    delete process.env.HOME;
    const { resolveStartDirectory } = await import("./index");
    expect(resolveStartDirectory()).toBe(".");
  });
});

describe("resolveX11Env", () => {
  it("probes $XDG_RUNTIME_DIR/xauth_* when XAUTHORITY is unset (SteamOS Gaming Mode)", async () => {
    // gamescope-session-plus pattern: cookie at
    // $XDG_RUNTIME_DIR/xauth_<random>, NOT ~/.Xauthority.
    delete process.env.XAUTHORITY;
    process.env.XDG_RUNTIME_DIR = sandboxRoot;
    process.env.DISPLAY = ":1";
    await writeFile(join(sandboxRoot, "xauth_abc123"), "");

    const { resolveX11Env } = await import("./index");
    const env = await resolveX11Env();
    expect(env.XAUTHORITY).toBe(`${sandboxRoot}/xauth_abc123`);
    expect(env.DISPLAY).toBe(":1");
  });

  it("prefers explicit $XAUTHORITY over the runtime-dir probe", async () => {
    process.env.XAUTHORITY = "/explicit/path/.Xauthority";
    process.env.XDG_RUNTIME_DIR = sandboxRoot;
    await writeFile(join(sandboxRoot, "xauth_zzz"), "");

    const { resolveX11Env } = await import("./index");
    const env = await resolveX11Env();
    expect(env.XAUTHORITY).toBe("/explicit/path/.Xauthority");
  });

  it("falls back to ~/.Xauthority when it exists and no runtime-dir cookie is found", async () => {
    delete process.env.XAUTHORITY;
    delete process.env.XDG_RUNTIME_DIR;
    process.env.HOME = sandboxRoot;
    await writeFile(join(sandboxRoot, ".Xauthority"), "");

    const { resolveX11Env } = await import("./index");
    const env = await resolveX11Env();
    expect(env.XAUTHORITY).toBe(`${sandboxRoot}/.Xauthority`);
  });

  it("leaves XAUTHORITY unset when no cookie is reachable", async () => {
    delete process.env.XAUTHORITY;
    delete process.env.XDG_RUNTIME_DIR;
    process.env.HOME = sandboxRoot; // no .Xauthority inside

    const { resolveX11Env } = await import("./index");
    const env = await resolveX11Env();
    expect(env.XAUTHORITY).toBeUndefined();
  });

  it("does NOT fall back to DISPLAY=:0 when DISPLAY is unset", async () => {
    delete process.env.DISPLAY;
    delete process.env.XAUTHORITY;
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.HOME;

    const { resolveX11Env } = await import("./index");
    const env = await resolveX11Env();
    expect(env.DISPLAY).toBeUndefined();
  });
});

describe("pickFile — picker-missing return value", () => {
  it("returns null when none of zenity / kdialog / yad is on PATH", async () => {
    const { pickFile } = await import("./index");
    const r = await pickFile({});
    expect(r).toBeNull();
  });
});
