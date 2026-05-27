import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
 *   - `pickFile`'s "no picker installed" return-null path
 */

const origHome = process.env.HOME;
let sandboxRoot = "";

// Force the picker registry to look-empty so pickFile exits before
// running any external process.
mock.module("@loadout/exec", () => ({
  commandExists: async (_name: string) => false,
  runFull: async () => {
    throw new Error(
      "runFull should NOT be called when commandExists returns false for all pickers",
    );
  },
}));

beforeEach(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "file-picker-spec-"));
});

afterEach(async () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  await rm(sandboxRoot, { recursive: true, force: true });
});

describe("resolveStartDirectory", () => {
  it("uses an explicit startDirectory when it exists on disk", async () => {
    process.env.HOME = "/nonexistent-home-1";
    const { resolveStartDirectory } = await import("./index");
    expect(resolveStartDirectory(sandboxRoot)).toBe(sandboxRoot);
  });

  it("falls back to $HOME/Downloads when the explicit path is missing", async () => {
    const sandboxHome = sandboxRoot;
    const downloads = join(sandboxHome, "Downloads");
    await mkdir(downloads);
    process.env.HOME = sandboxHome;
    const { resolveStartDirectory } = await import("./index");
    expect(resolveStartDirectory("/this/path/does/not/exist")).toBe(downloads);
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

  it("falls through past a missing explicit path to find Downloads, NOT $HOME", async () => {
    // Regression guard: an explicit path that doesn't exist must
    // ALSO trigger the Downloads probe — not skip straight to $HOME.
    const sandboxHome = sandboxRoot;
    const downloads = join(sandboxHome, "Downloads");
    await mkdir(downloads);
    process.env.HOME = sandboxHome;
    const { resolveStartDirectory } = await import("./index");
    expect(resolveStartDirectory("/no/such/path")).toBe(downloads);
  });
});

describe("pickFile — picker-missing return value", () => {
  it("returns null when none of zenity / kdialog / yad is on PATH", async () => {
    const { pickFile } = await import("./index");
    const r = await pickFile({});
    expect(r).toBeNull();
  });
});
