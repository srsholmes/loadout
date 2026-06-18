import { describe, it, expect, mock, beforeEach } from "bun:test";

// Test fixtures: capture the in-process call order so we can assert
// the three-call persistence dance ordering. Each mock returns
// resolved promises so the under-test code never blocks.
let calls: string[] = [];
let addShortcutReturn: number | undefined = 4242;
let addUserTagThrows = false;

mock.module("@loadout/steam-cdp", () => ({
  withSteamClient: async <T>(
    cb: (sc: Record<string, unknown>) => Promise<T>,
  ): Promise<T> => {
    const sc = {
      apps: {
        addShortcut: async (name: string, exe: string, args: string, cwd: string) => {
          calls.push(`add:${name}|${exe}|${args}|${cwd}`);
          return addShortcutReturn;
        },
        setShortcutName: async (id: number, name: string) => {
          calls.push(`name:${id}|${name}`);
        },
        setShortcutLaunchOptions: async (id: number, args: string) => {
          calls.push(`launch:${id}|${args}`);
        },
        specifyCompatTool: async (id: number, tool: string, label: string) => {
          calls.push(`compat:${id}|${tool}|${label}`);
        },
        addUserTag: async (id: number, tag: string) => {
          if (addUserTagThrows) throw new Error("addUserTag fail");
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
    return cb(sc);
  },
  SteamClientUnreachableError: class extends Error {},
}));

mock.module("@loadout/vdf", () => ({
  shortcutGameId64: (n: number) => String((BigInt(n) << 32n) | (1n << 25n)),
}));

beforeEach(() => {
  calls = [];
  addShortcutReturn = 4242;
  addUserTagThrows = false;
});

describe("addNonSteamShortcut", () => {
  it("rejects empty exe", async () => {
    const { addNonSteamShortcut } = await import("./index");
    await expect(
      addNonSteamShortcut({ displayName: "x", exe: "", args: "" }),
    ).rejects.toThrow(/exe must be non-empty/);
  });

  it("rejects empty displayName", async () => {
    const { addNonSteamShortcut } = await import("./index");
    await expect(
      addNonSteamShortcut({ displayName: "", exe: "/foo", args: "" }),
    ).rejects.toThrow(/displayName must be non-empty/);
  });

  it("runs add → name → launch in order with the appId Steam returned", async () => {
    const { addNonSteamShortcut } = await import("./index");
    const r = await addNonSteamShortcut({
      displayName: "Alba (Epic Games)",
      exe: "/games/alba.exe",
      args: "--fullscreen",
    });
    expect(r.appId).toBe(4242);
    const idxAdd = calls.findIndex((c) => c.startsWith("add:"));
    const idxName = calls.findIndex((c) => c.startsWith("name:"));
    const idxLaunch = calls.findIndex((c) => c.startsWith("launch:"));
    expect(idxAdd).toBe(0);
    expect(idxName).toBeGreaterThan(idxAdd);
    expect(idxLaunch).toBeGreaterThan(idxName);
  });

  it("writes a Proton compat tool when platform=windows (host is always Linux)", async () => {
    const { addNonSteamShortcut } = await import("./index");
    await addNonSteamShortcut({
      displayName: "Alba",
      exe: "/games/alba.exe",
      args: "",
      platform: "windows",
    });
    const idxCompat = calls.findIndex((c) => c.startsWith("compat:"));
    expect(idxCompat).toBeGreaterThanOrEqual(0);
    expect(calls[idxCompat]).toContain("proton_experimental");
  });

  it("does not write a compat tool for native linux installs", async () => {
    const { addNonSteamShortcut } = await import("./index");
    await addNonSteamShortcut({
      displayName: "NativeGame",
      exe: "/games/native",
      args: "",
      platform: "linux",
    });
    const idxCompat = calls.findIndex((c) => c.startsWith("compat:"));
    expect(idxCompat).toBe(-1);
  });

  it("swallows addUserTag failures so the shortcut add still succeeds", async () => {
    addUserTagThrows = true;
    const { addNonSteamShortcut } = await import("./index");
    const r = await addNonSteamShortcut({
      displayName: "Alba",
      exe: "/games/alba.exe",
      args: "",
      userTag: "Epic Games",
    });
    expect(r.appId).toBe(4242);
    const idxTag = calls.findIndex((c) => c.startsWith("tag:"));
    expect(idxTag).toBe(-1); // throw means no recorded call
  });

  it("calls addAppToCollection when collectionName is provided", async () => {
    const { addNonSteamShortcut } = await import("./index");
    await addNonSteamShortcut({
      displayName: "Alba",
      exe: "/games/alba.exe",
      args: "",
      collectionName: "Epic Games",
    });
    const idxCol = calls.findIndex((c) => c.startsWith("collection:"));
    expect(idxCol).toBeGreaterThanOrEqual(0);
    expect(calls[idxCol]).toContain("Epic Games");
  });

  it("derives a gameId64 from the appId", async () => {
    const { addNonSteamShortcut } = await import("./index");
    const r = await addNonSteamShortcut({
      displayName: "Alba",
      exe: "/games/alba",
      args: "",
    });
    // Mock shortcutGameId64 returns ((appId << 32) | (1 << 25)).
    const expected = String((4242n << 32n) | (1n << 25n));
    expect(r.gameId64).toBe(expected);
  });

  it("throws an actionable 'restart Steam' error when AddShortcut returns undefined", async () => {
    // If Steam's `AddShortcut` returns `undefined`, propagate a
    // single readable error rather than letting `undefined` flow
    // through every subsequent SetX call. Restarting Steam is the
    // right next step.
    addShortcutReturn = undefined;
    const { addNonSteamShortcut } = await import("./index");
    await expect(
      addNonSteamShortcut({
        displayName: "Ghosted",
        exe: "/games/ghosted",
        args: "",
      }),
    ).rejects.toThrow(/restart Steam and retry/i);
  });
});

describe("removeNonSteamShortcut", () => {
  it("calls Steam removeShortcut for the given appId", async () => {
    const { removeNonSteamShortcut } = await import("./index");
    await removeNonSteamShortcut(4242);
    expect(calls).toContain("remove:4242");
  });

  it("does not throw when Steam isn't reachable", async () => {
    // Re-mock with a withSteamClient that rejects.
    mock.module("@loadout/steam-cdp", () => ({
      withSteamClient: async () => {
        throw new Error("Steam not reachable");
      },
      SteamClientUnreachableError: class extends Error {},
    }));
    // Re-import after re-mock so the helper picks up the new module.
    const { removeNonSteamShortcut } = await import("./index");
    await expect(removeNonSteamShortcut(1234)).resolves.toBeUndefined();
  });
});
