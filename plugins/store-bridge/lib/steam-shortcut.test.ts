import { describe, it, expect, mock } from "bun:test";
import { shortcutDisplayName } from "./steam-shortcut";
import type { StoreDriver } from "./stores/driver";
import type { InstalledGame } from "./types";

function driver(overrides: Partial<StoreDriver> = {}): StoreDriver {
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
    launchSpec: () => ({ exe: "/usr/bin/legendary", args: "launch X" }),
    identifyInstall: async () => null,
    importExisting: todo,
    ...overrides,
  } as StoreDriver;
}

const game: InstalledGame = {
  id: "Fortnite",
  title: "Fortnite",
  installedAt: "2026-01-01T00:00:00Z",
  installDir: "/games/fortnite",
  source: "installed",
  addedToSteam: false,
};

describe("shortcutDisplayName", () => {
  it("suffixes the title with the store's displayName", () => {
    expect(shortcutDisplayName(driver(), game)).toBe("Fortnite (Epic Games)");
  });
});

// Mock @loadout/steam-cdp before importing addToSteam so we can
// intercept the withSteamClient calls.
let lastClient: { calls: string[] };

mock.module("@loadout/steam-cdp", () => ({
  withSteamClient: async (cb: (sc: unknown) => Promise<unknown>) => {
    const calls: string[] = [];
    const sc = {
      apps: {
        addShortcut: async (name: string, exe: string, args: string, cwd: string) => {
          calls.push(`add:${name}|${exe}|${args}|${cwd}`);
          return 4242;
        },
        setShortcutName: async (id: number, name: string) => {
          calls.push(`name:${id}|${name}`);
        },
        setShortcutLaunchOptions: async (id: number, args: string) => {
          calls.push(`launch:${id}|${args}`);
        },
        addUserTag: async (id: number, tag: string) => {
          calls.push(`tag:${id}|${tag}`);
        },
        addAppToCollection: async (id: number, name: string) => {
          calls.push(`collection:${id}|${name}`);
        },
        removeShortcut: async (id: number) => {
          calls.push(`remove:${id}`);
        },
      },
    };
    lastClient = { calls };
    return cb(sc);
  },
  SteamClientUnreachableError: class SteamClientUnreachableError extends Error {},
}));

mock.module("@loadout/steam-paths", () => ({
  getUserdataDir: () => "/tmp/userdata-test",
  getUserIds: async () => [],
}));

mock.module("@loadout/vdf", () => ({
  parseBinaryVdf: () => ({}),
  shortcutGameId64: (n: number) => String(BigInt(n) << 32n | (1n << 25n)),
}));

describe("addToSteam", () => {
  it("does the three-call persistence dance and tags with the driver displayName", async () => {
    const { addToSteam } = await import("./steam-shortcut");
    const d = driver({ displayName: "Epic Games" });
    const r = await addToSteam(d, game);
    expect(r.appId).toBe(4242);

    const order = lastClient.calls;
    const idxAdd = order.findIndex((c: string) => c.startsWith("add:"));
    const idxName = order.findIndex((c: string) => c.startsWith("name:"));
    const idxLaunch = order.findIndex((c: string) => c.startsWith("launch:"));
    const idxTag = order.findIndex((c: string) => c.startsWith("tag:"));
    const idxCol = order.findIndex((c: string) => c.startsWith("collection:"));
    expect(idxAdd).toBeGreaterThanOrEqual(0);
    expect(idxName).toBeGreaterThan(idxAdd);
    expect(idxLaunch).toBeGreaterThan(idxName);
    expect(idxTag).toBeGreaterThan(idxLaunch);
    expect(order[idxTag]).toContain("Epic Games");
    // Collection write fires after the user-tag set, with the driver's
    // displayName as the collection key.
    expect(idxCol).toBeGreaterThan(idxTag);
    expect(order[idxCol]).toContain("Epic Games");
  });

  it("throws when the driver returns an empty exe", async () => {
    const { addToSteam } = await import("./steam-shortcut");
    const d = driver({ launchSpec: () => ({ exe: "", args: "" }) });
    await expect(addToSteam(d, game)).rejects.toThrow(/empty launch exe/i);
  });
});
