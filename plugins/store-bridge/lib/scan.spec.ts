import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanForInstalls } from "./scan";
import {
  registerDriver,
  clearDrivers,
} from "./stores/registry";
import type { StoreDriver } from "./stores/driver";

function fakeDriver(overrides: Partial<StoreDriver> = {}): StoreDriver {
  const todo = async () => {
    throw new Error("nope");
  };
  return {
    id: "epic",
    displayName: "Epic Games",
    preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
    selfInstall: async () => {},
    authStatus: async () => "unknown",
    startAuth: async () => ({ url: "" }),
    completeAuth: todo,
    signOut: todo,
    listLibrary: async () => [],
    install: todo,
    uninstall: todo,
    launchSpec: () => ({ exe: "", args: "" }),
    identifyInstall: async () => null,
    importExisting: todo,
    ...overrides,
  } as StoreDriver;
}

let tmp: string;

beforeEach(async () => {
  clearDrivers();
  tmp = await mkdtemp(join(tmpdir(), "store-bridge-scan-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("scanForInstalls", () => {
  it("returns an empty list when no driver is registered", async () => {
    await mkdir(join(tmp, "Fortnite", ".egstore"), { recursive: true });
    expect(await scanForInstalls([tmp])).toEqual([]);
  });

  it("calls the driver's identifyInstall for every dir under the scan root", async () => {
    await mkdir(join(tmp, "Fortnite", ".egstore"), { recursive: true });
    await mkdir(join(tmp, "NotAGame"), { recursive: true });
    const visited: string[] = [];
    registerDriver(
      fakeDriver({
        identifyInstall: async (dir) => {
          visited.push(dir);
          return dir.endsWith("Fortnite") ? { id: "fortnite", title: "Fortnite" } : null;
        },
      }),
    );
    const r = await scanForInstalls([tmp]);
    expect(visited.length).toBeGreaterThanOrEqual(2);
    expect(r).toHaveLength(1);
    expect(r[0]?.gameId).toBe("fortnite");
    expect(r[0]?.dir).toContain("Fortnite");
  });

  it("respects the exclude set so already-imported dirs aren't re-reported", async () => {
    await mkdir(join(tmp, "Fortnite", ".egstore"), { recursive: true });
    registerDriver(
      fakeDriver({
        identifyInstall: async (dir) =>
          dir.endsWith("Fortnite") ? { id: "fortnite", title: "Fortnite" } : null,
      }),
    );
    const excluded = new Set([join(tmp, "Fortnite")]);
    const r = await scanForInstalls([tmp], excluded);
    expect(r).toHaveLength(0);
  });

  it("dedupes when two drivers claim the same dir, by emitting one row per driver", async () => {
    await mkdir(join(tmp, "Game", ".egstore"), { recursive: true });
    registerDriver(
      fakeDriver({
        id: "epic",
        identifyInstall: async (dir) =>
          dir.endsWith("Game") ? { id: "g", title: "G" } : null,
      }),
    );
    registerDriver(
      fakeDriver({
        id: "gog",
        identifyInstall: async (dir) =>
          dir.endsWith("Game") ? { id: "g", title: "G" } : null,
      }),
    );
    const r = await scanForInstalls([tmp]);
    expect(r).toHaveLength(2);
    expect(r.map((d) => d.storeId).sort()).toEqual(["epic", "gog"]);
  });

  it("doesn't recurse into .egstore — that's the marker, not a parent", async () => {
    await mkdir(join(tmp, "Outer", ".egstore", "deep"), { recursive: true });
    const visited: string[] = [];
    registerDriver(
      fakeDriver({
        identifyInstall: async (dir) => {
          visited.push(dir);
          return null;
        },
      }),
    );
    await scanForInstalls([tmp]);
    expect(visited.some((v) => v.includes(".egstore"))).toBe(false);
  });
});
