import { describe, it, expect, beforeEach, afterEach } from "bun:test";

/**
 * Spec for the mod SDK proxy. The proxy reads its live runtime from
 * `globalThis.__recomp_mod_runtime`, which the install pipeline
 * (`lib/mods.ts`) sets up for the duration of one mod-setup
 * invocation. Direct user calls to the proxy (e.g. from a mod's
 * `setup.ts` that was imported outside the pipeline) MUST throw an
 * actionable error.
 *
 * End-to-end "proxy passes through to a real runtime" coverage lives
 * in `mods.spec.ts` (the scripted-path test exercises every getter).
 */

const slot = globalThis as unknown as {
  __recomp_mod_runtime?: unknown;
};
const original = slot.__recomp_mod_runtime;

beforeEach(() => {
  delete slot.__recomp_mod_runtime;
});

afterEach(() => {
  if (original !== undefined) slot.__recomp_mod_runtime = original;
  else delete slot.__recomp_mod_runtime;
});

describe("modSdk proxy — unbound runtime", () => {
  it("throws an actionable error when a getter is read with no bound runtime", async () => {
    const { modSdk } = await import("./mod");
    expect(() => modSdk.installDir).toThrow(/no recomp mod runtime bound/);
  });

  it("throws an actionable error when a method is called with no bound runtime", async () => {
    const { modSdk } = await import("./mod");
    expect(() => modSdk.emit({ message: "hi" })).toThrow(
      /no recomp mod runtime bound/,
    );
  });

  it("error message names the host module so the user knows where to look", async () => {
    const { modSdk } = await import("./mod");
    expect(() => modSdk.installDir).toThrow(
      /plugins\/recomp\/lib\/mods\.ts/,
    );
  });
});

describe("modSdk proxy — bound runtime", () => {
  it("getters return whatever the bound runtime exposes", async () => {
    const stub = {
      sdk: {
        mod: { id: "x" },
        game: { id: "g" },
        installed: { installDir: "/i" },
        installDir: "/i",
        stagedDir: "/s",
        cacheDir: "/c",
        ready: Promise.resolve(),
        run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
        download: () => Promise.resolve(),
        extractArchive: () => Promise.resolve(),
        copy: () => Promise.resolve(),
        mkdir: () => Promise.resolve(),
        emit: () => {},
      },
    };
    slot.__recomp_mod_runtime = stub;
    const { modSdk } = await import("./mod");
    expect(modSdk.installDir).toBe("/i");
    expect(modSdk.stagedDir).toBe("/s");
    expect(modSdk.cacheDir).toBe("/c");
  });

  it("method calls dispatch through to the bound runtime with the right args", async () => {
    // Capture every method's args so a regression that broke the
    // proxy's method-dispatch (vs. its getters) is caught — the
    // earlier test would pass even if the methods short-circuited
    // because it only exercises the getters.
    const calls: Record<string, unknown[]> = {};
    const stub = {
      sdk: {
        mod: { id: "x" },
        game: { id: "g" },
        installed: { installDir: "/i" },
        installDir: "/i",
        stagedDir: "/s",
        cacheDir: "/c",
        ready: Promise.resolve(),
        run: async (...args: unknown[]) => {
          calls.run = args;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        download: async (...args: unknown[]) => {
          calls.download = args;
        },
        extractArchive: async (...args: unknown[]) => {
          calls.extractArchive = args;
        },
        copy: async (...args: unknown[]) => {
          calls.copy = args;
        },
        mkdir: async (...args: unknown[]) => {
          calls.mkdir = args;
        },
        emit: (...args: unknown[]) => {
          calls.emit = args;
        },
      },
    };
    slot.__recomp_mod_runtime = stub;
    const { modSdk } = await import("./mod");
    await modSdk.run(["echo", "hi"]);
    await modSdk.download("https://x", "/dest");
    await modSdk.extractArchive("/src.zip", "/dest");
    await modSdk.copy("/a", "/b");
    await modSdk.mkdir("/d");
    modSdk.emit({ message: "hi" });
    expect(calls.run).toEqual([["echo", "hi"], undefined]);
    expect(calls.download).toEqual(["https://x", "/dest"]);
    expect(calls.extractArchive).toEqual(["/src.zip", "/dest"]);
    expect(calls.copy).toEqual(["/a", "/b"]);
    expect(calls.mkdir).toEqual(["/d"]);
    expect(calls.emit).toEqual([{ message: "hi" }]);
  });
});
