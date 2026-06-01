import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreDriver } from "./lib/stores/driver";
import { registerDriver } from "./lib/stores/registry";

let sandbox = "";
mock.module("./lib/platform", () => ({
  configDir: () => sandbox,
  cacheDir: () => join(sandbox, "cache"),
  dataDir: () => join(sandbox, "data"),
  binDir: () => join(sandbox, "data", "bin"),
  gamesDir: () => join(sandbox, "games"),
  storeInstallDir: (id: string) => join(sandbox, "games", id),
}));

// In-process scratch store for @loadout/plugin-storage so each test's
// state writes are isolated from the dev's real
// `~/.config/loadout/plugins/store-bridge.json`. Cleared per test.
const pluginStorageStore = new Map<string, unknown>();
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: async <T>(id: string): Promise<Partial<T>> =>
    (pluginStorageStore.get(id) as Partial<T> | undefined) ?? {},
  writePluginStorage: async <T>(id: string, data: T): Promise<void> => {
    pluginStorageStore.set(id, data);
  },
  pluginStoragePath: (id: string) => `/tmp/spec/${id}.json`,
  loadoutConfigDir: () => "/tmp/spec",
}));

// Stub Epic driver so we never actually invoke legendary or wire
// it via `configureEpicDriver`. The backend imports the Epic side
// for its side-effect registration — we replace that with a stub
// that registers a fake driver.
mock.module("./lib/stores/epic", () => {
  const driver: StoreDriver = {
    id: "epic",
    displayName: "Epic Games",
    preflight: async () => ({ ok: true, missing: [], canSelfInstall: true }),
    selfInstall: async () => {},
    authStatus: async () => "unknown",
    startAuth: async () => ({ url: "https://example.test/login" }),
    completeAuth: async () => {},
    signOut: async () => {},
    listLibrary: async () => [
      { id: "fortnite", title: "Fortnite", coverUrl: "https://cdn.test/f.jpg" },
    ],
    install: async (id, dir) => ({
      id,
      title: id,
      installedAt: "2026-01-01T00:00:00Z",
      installDir: dir,
      executable: `${id}.exe`,
      platform: "windows",
      source: "installed",
      addedToSteam: false,
    }),
    uninstall: async () => {},
    launchSpec: () => ({ exe: "/x.exe", args: "" }),
    identifyInstall: async () => null,
    importExisting: async (id, dir) => ({
      id,
      title: id,
      installedAt: "2026-01-01T00:00:00Z",
      installDir: dir,
      executable: `${id}.exe`,
      platform: "windows",
      source: "imported",
      addedToSteam: false,
    }),
  };
  registerDriver(driver);
  return {
    configureEpicDriver: () => {},
    epicDriver: driver,
    storeInstallDir: (storeId: string) => join(sandbox, "games", storeId),
  };
});

// Steam APIs aren't reachable from tests; the steam-shortcut module
// is mocked above to return a fake `{appId, gameId64}` so the
// add-to-Steam tail every install runs through doesn't hit a real
// VDF write.
mock.module("./lib/steam-shortcut", () => ({
  addToSteam: async () => ({ appId: 1, gameId64: "1" }),
  removeFromSteam: async () => {},
  shortcutDisplayName: (
    driver: { displayName: string },
    installed: { title: string },
  ) => `${installed.title} (${driver.displayName})`,
}));
mock.module("./lib/artwork", () => ({
  applyArtwork: async () => ({ written: 0 }),
}));
mock.module("./lib/launcher", () => ({
  launchGame: async () => {},
}));

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "store-bridge-be-"));
  pluginStorageStore.clear();
});
afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("StoreBridgeBackend", () => {
  it("onLoad initialises state with the epic store present", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    const stores = await be.getStores();
    expect(stores.map((s) => s.id)).toContain("epic");
  });

  it("getLibrary returns the driver's listLibrary, mapped + sorted by title", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    const lib = await be.getLibrary("epic");
    expect(lib).toHaveLength(1);
    expect(lib[0]?.title).toBe("Fortnite");
    expect(lib[0]?.status).toBe("library");
  });

  it("installGame transitions a library entry to installed", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await be.getLibrary("epic"); // populate library
    await be.installGame("epic", "fortnite");
    const lib = await be.getLibrary("epic");
    expect(lib[0]?.status).toBe("installed");
    expect(lib[0]?.installed?.id).toBe("fortnite");
  });

  it("addScanPath rejects empty + non-absolute paths", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    expect((await be.addScanPath("")).ok).toBe(false);
    expect((await be.addScanPath("relative/path")).ok).toBe(false);
    // Paths outside the whitelist (declared in `package.json.plugin`)
    // are rejected to keep the walker from scanning /etc or the
    // home dir's hidden configs even if someone manually pastes a
    // path.
    expect((await be.addScanPath("/etc")).ok).toBe(false);
    expect((await be.addScanPath("/mnt/games")).ok).toBe(true);
    const s = await be.getSettings();
    expect(s.scanPaths).toEqual(["/mnt/games"]);
  });

  it("addScanPath rejects `..` traversal that would escape the whitelist", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    // Naive prefix-check would let these through; path.resolve()
    // normalises away the .. segments and the resolved path no
    // longer starts with `/mnt`.
    expect((await be.addScanPath("/mnt/../etc")).ok).toBe(false);
    expect((await be.addScanPath("/mnt/games/../../etc")).ok).toBe(false);
    expect((await be.addScanPath("/run/media/../../root")).ok).toBe(false);
    // Sanity-check the legitimate path still passes.
    expect((await be.addScanPath("/mnt/games")).ok).toBe(true);
  });

  it("signOut throws when the driver doesn't expose signOut", async () => {
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "authed",
      listLibrary: async () => [],
      install: async () => ({
        id: "x",
        title: "x",
        installedAt: "",
        installDir: "",
        source: "installed",
        addedToSteam: false,
      }),
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
      // intentionally omit signOut
    };
    registerDriver(driver);
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await expect(be.signOut("epic")).rejects.toThrow(
      /doesn't support sign-out/i,
    );
  });

  it("scanForInstalls returns an empty list when no scan paths are configured", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    const { detected } = await be.scanForInstalls();
    expect(detected).toEqual([]);
  });
});

// ── Regression coverage for the install queue + cancel flow.
//
// These exercise the contracts the architecture review flagged:
//
//   B6.a  Two concurrent installGame calls run serially — the
//         legendary install-db lock would deadlock otherwise.
//   B6.b  cancelInstall on a queued (not-yet-running) install
//         emits an error event without ever invoking the driver.
//   B6.c  cancelInstall after the install already finished emits
//         the benign "Install already finished" toast (the toast
//         the user sees when they hit Cancel a fraction of a
//         second after the install completed).
//   B6.d  refreshLaunchMetadata gets invoked when an existing
//         install has no `executable` (the "added before we
//         captured launch metadata" repair path).
//
// They re-use the same Epic-driver stub by replacing the registry
// entry with a more instrumented driver via `registerDriver`.
describe("StoreBridgeBackend — install queue + cancel regression", () => {
  it("serialises concurrent installs against the same driver", async () => {
    const order: string[] = [];
    let inflight = 0;
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [
        { id: "A", title: "A" },
        { id: "B", title: "B" },
      ],
      install: async (id, dir) => {
        inflight++;
        order.push(`enter:${id}`);
        // If anything else is also inside install() at this point,
        // the queue isn't doing its job. The driver-level legendary
        // lock would error out IRL — assert it directly here.
        if (inflight > 1) throw new Error("concurrent install detected");
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        order.push(`exit:${id}`);
        return {
          id,
          title: id,
          installedAt: "2026-01-01T00:00:00Z",
          installDir: dir,
          executable: `${id}.exe`,
          platform: "windows",
          source: "installed",
          addedToSteam: false,
        };
      },
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
    };
    registerDriver(driver);

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await be.getLibrary("epic");

    await Promise.all([
      be.installGame("epic", "A"),
      be.installGame("epic", "B"),
    ]);

    // The two installs must not overlap.
    expect(order).toEqual(["enter:A", "exit:A", "enter:B", "exit:B"]);
  });

  it("cancel on a queued install bails before the driver runs", async () => {
    let installCalls = 0;
    let firstResolver: (() => void) | null = null;
    // Dispatch barrier — A's install() resolves `aEntered` as soon
    // as it's been entered. Lets the test wait on the actual queue
    // dispatch event instead of an arbitrary setTimeout, which
    // would let a broken queue (running B in parallel with A) sneak
    // past as long as the timer fired before B's install ticked.
    let aEnteredInstall: () => void = () => {};
    const aEntered = new Promise<void>((resolve) => {
      aEnteredInstall = resolve;
    });
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [
        { id: "A", title: "A" },
        { id: "B", title: "B" },
      ],
      install: async (id, dir) => {
        installCalls++;
        if (id === "A") {
          aEnteredInstall();
          await new Promise<void>((resolve) => {
            firstResolver = resolve;
          });
        }
        return {
          id,
          title: id,
          installedAt: "2026-01-01T00:00:00Z",
          installDir: dir,
          executable: `${id}.exe`,
          platform: "windows",
          source: "installed",
          addedToSteam: false,
        };
      },
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
    };
    registerDriver(driver);

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await be.getLibrary("epic");

    const aPromise = be.installGame("epic", "A");
    const bPromise = be.installGame("epic", "B");

    // Wait for the queue to actually dispatch A. The barrier means
    // we resume the moment A's install() body runs, not after some
    // best-guess delay.
    await aEntered;
    expect(installCalls).toBe(1); // A in progress, B still queued

    // Cancel B while it's still queued.
    await be.cancelInstall("epic", "B");

    // Now finish A and let the queue drain.
    firstResolver!();
    await aPromise;
    // B's queued-cancel short-circuits the install unit and emits
    // an "Install cancelled" pipelineEvent.error. The installGame
    // call resolves normally (the queue returned from its `return`
    // branch). If the queue or cancel logic were broken, B's
    // promise would either hang forever or reject with a non-cancel
    // error — both visible to the test below.
    await bPromise;

    // B's install() was never invoked.
    expect(installCalls).toBe(1);
  });

  it("emits a benign event when cancel arrives after install finished", async () => {
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [{ id: "A", title: "A" }],
      install: async (id, dir, emit) => {
        // Emit a complete so the backend's makeEmitter clears the
        // in-flight registry. The real legendary wrapper always
        // emits before resolving; the test stub mirrors that.
        emit({ kind: "complete", id: `epic:install:${id}` });
        return {
          id,
          title: id,
          installedAt: "2026-01-01T00:00:00Z",
          installDir: dir,
          executable: `${id}.exe`,
          platform: "windows",
          source: "installed",
          addedToSteam: false,
        };
      },
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
    };
    registerDriver(driver);

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await be.getLibrary("epic");
    await be.installGame("epic", "A");

    const events: Array<{ message?: string }> = [];
    be.emit = (e: { event: string; data?: { message?: string } }) => {
      if (e.event === "pipelineEvent" && e.data) events.push(e.data);
    };

    await be.cancelInstall("epic", "A");

    const benign = events.find((e) =>
      /already finished|nothing to cancel/i.test(e.message ?? ""),
    );
    expect(benign).toBeDefined();
  });

  it("install gameStatusChanged carries addedToSteam:false + pipelineEvent.error on addToSteam failure", async () => {
    // Replace the steam-shortcut mock so addToSteam throws. The
    // install itself succeeds; the backend should emit:
    //   1. pipelineEvent.error with id "...:add-to-steam:..."
    //   2. gameStatusChanged with addedToSteam:false
    mock.module("./lib/steam-shortcut", () => ({
      addToSteam: async () => {
        throw new Error("Steam not reachable");
      },
      removeFromSteam: async () => {},
      shortcutDisplayName: (d: { displayName: string }, g: { title: string }) =>
        `${g.title} (${d.displayName})`,
    }));

    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [{ id: "A", title: "Alba" }],
      install: async (id, dir, emit) => {
        emit({ kind: "complete", id: `epic:install:${id}` });
        return {
          id,
          title: "Alba",
          installedAt: "2026-01-01T00:00:00Z",
          installDir: dir,
          executable: `${id}.exe`,
          platform: "windows",
          source: "installed",
          addedToSteam: false,
        };
      },
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
    };
    registerDriver(driver);

    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    be.emit = (e) => events.push(e);
    await be.onLoad();
    await be.getLibrary("epic");
    await be.installGame("epic", "A");

    const status = events.find(
      (e) => e.event === "gameStatusChanged" && e.data?.status === "installed",
    );
    expect(status?.data?.addedToSteam).toBe(false);

    const addToSteamError = events.find(
      (e) =>
        e.event === "pipelineEvent" &&
        typeof e.data?.id === "string" &&
        (e.data.id as string).includes(":add-to-steam:"),
    );
    expect(addToSteamError).toBeDefined();
  });

  it("import emits gameStatusChanged with title + addedToSteam, mirroring install", async () => {
    // Restore a working steam-shortcut mock so the addToSteam tail
    // succeeds for this test (the previous test mocked it to throw).
    mock.module("./lib/steam-shortcut", () => ({
      addToSteam: async () => ({ appId: 1, gameId64: "1" }),
      removeFromSteam: async () => {},
      shortcutDisplayName: (d: { displayName: string }, g: { title: string }) =>
        `${g.title} (${d.displayName})`,
    }));

    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [],
      install: async () => {
        throw new Error("not used");
      },
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
      identifyInstall: async () => ({ id: "A", title: "Alba" }),
      importExisting: async (id, dir) => ({
        id,
        title: "Alba: A Wildlife Adventure",
        installedAt: "2026-01-01T00:00:00Z",
        installDir: dir,
        executable: `${id}.exe`,
        platform: "windows",
        source: "imported",
        addedToSteam: false,
      }),
    };
    registerDriver(driver);

    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    be.emit = (e) => events.push(e);
    await be.onLoad();
    await be.importDetected("epic", "A", "/mnt/games/Alba");

    const status = events.find(
      (e) => e.event === "gameStatusChanged" && e.data?.status === "imported",
    );
    expect(status).toBeDefined();
    expect(status?.data?.title).toBe("Alba: A Wildlife Adventure");
    expect(status?.data?.addedToSteam).toBe(true);
  });

  it("gameStatusChanged carries title + addedToSteam on install success", async () => {
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [{ id: "A", title: "Alba" }],
      install: async (id, dir, emit) => {
        emit({ kind: "complete", id: `epic:install:${id}` });
        return {
          id,
          title: "Alba: A Wildlife Adventure",
          installedAt: "2026-01-01T00:00:00Z",
          installDir: dir,
          executable: `${id}.exe`,
          platform: "windows",
          source: "installed",
          addedToSteam: false,
        };
      },
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
    };
    registerDriver(driver);

    const events: Array<{
      event: string;
      data?: {
        status?: string;
        title?: string;
        addedToSteam?: boolean;
      };
    }> = [];

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    be.emit = (e) => events.push(e);
    await be.onLoad();
    await be.getLibrary("epic");
    await be.installGame("epic", "A");

    const status = events.find(
      (e) => e.event === "gameStatusChanged" && e.data?.status === "installed",
    );
    expect(status).toBeDefined();
    expect(status?.data?.title).toBe("Alba: A Wildlife Adventure");
    expect(status?.data?.addedToSteam).toBe(true);
  });
});

// ── Regression coverage for the review feedback.

describe("StoreBridgeBackend — PR review regressions", () => {
  it("cancel-while-queued doesn't un-cancel itself when a new attempt is enqueued (cancel-token race)", async () => {
    // Reproduces the HIGH cancel-token race the review flagged.
    // Setup: queue blocker → queue install A (attempt 1) → cancel A
    // (still queued) → queue install A (attempt 2). When the queue
    // drains, attempt 1's queued-cancel must STILL bite (driver
    // never invoked for it), and attempt 2 must run normally.
    //
    // OLD broken code: `installGame` (attempt 2) ran
    // `cancelledInstalls.delete(key)` SYNCHRONOUSLY before the
    // queue dispatched. That cleared the cancel intent for
    // attempt 1, so when the queue dispatched attempt 1 it saw
    // `!cancelledInstalls.has(key)` and proceeded with the install.
    // Result: both attempts ran (cancel was lost).
    //
    // NEW code: cancel is keyed on the attempt id captured at
    // enqueue time. `claimAttempt(key)` for attempt 2 mints a
    // FRESH id that ISN'T in the cancelled set, so attempt 2 isn't
    // covered — and attempt 1's id remains in the cancelled set
    // so its queued unit short-circuits.
    let blockerResolver: (() => void) | null = null;
    let blockerEntered: () => void = () => {};
    const blockerEnteredP = new Promise<void>((resolve) => {
      blockerEntered = resolve;
    });
    const installCalls: string[] = [];
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [
        { id: "Blocker", title: "Blocker" },
        { id: "A", title: "A" },
      ],
      install: async (id, dir) => {
        installCalls.push(id);
        if (id === "Blocker") {
          blockerEntered();
          await new Promise<void>((resolve) => {
            blockerResolver = resolve;
          });
        }
        return {
          id,
          title: id,
          installedAt: "2026-01-01T00:00:00Z",
          installDir: dir,
          executable: `${id}.exe`,
          platform: "windows",
          source: "installed",
          addedToSteam: false,
        };
      },
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
    };
    registerDriver(driver);

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await be.getLibrary("epic");

    // Blocker fills the queue slot.
    const blocker = be.installGame("epic", "Blocker");
    await blockerEnteredP;
    // Attempt 1 queues behind Blocker (no driver call yet).
    const a1 = be.installGame("epic", "A");
    // Cancel attempt 1 — still queued, driver hasn't run yet.
    await be.cancelInstall("epic", "A");
    // Attempt 2 queues behind attempt 1. OLD code would
    // synchronously `cancelledInstalls.delete("epic/A")` here,
    // clearing the cancel intent of attempt 1.
    const a2 = be.installGame("epic", "A");
    // Drain.
    blockerResolver!();
    await blocker;
    await a1;
    await a2;
    // Attempt 1 was cancelled-while-queued — driver.install for
    // it must NEVER have been called.
    // Attempt 2 must have run — driver.install for A invoked once.
    const aCalls = installCalls.filter((c) => c === "A");
    expect(aCalls).toHaveLength(1);
  });

  it("validateGameId rejects malicious inputs at the RPC boundary", async () => {
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [],
      install: async () => {
        throw new Error("driver.install should never be called");
      },
      uninstall: async () => {
        throw new Error("driver.uninstall should never be called");
      },
      launchSpec: () => ({ exe: "/x", args: "" }),
    };
    registerDriver(driver);

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();

    // Every RPC entry point that constructs an on-disk path from
    // gameId must reject malformed input BEFORE invoking the
    // driver. If validateGameId was bypassed, driver.install /
    // driver.uninstall would throw the sentinel above and the
    // assertion would fail with a different message.
    const evil = ["../etc/passwd", "a/b", "", "foo bar", "../../root", " "];
    for (const bad of evil) {
      await expect(be.installGame("epic", bad)).rejects.toThrow(/Invalid gameId/);
      await expect(be.cancelInstall("epic", bad)).rejects.toThrow(/Invalid gameId/);
      await expect(be.uninstallGame("epic", bad)).rejects.toThrow(/Invalid gameId/);
      await expect(be.importDetected("epic", bad, "/some/dir")).rejects.toThrow(
        /Invalid gameId/,
      );
      await expect(be.launchGame("epic", bad)).rejects.toThrow(/Invalid gameId/);
      await expect(be.addInstalledToSteam("epic", bad)).rejects.toThrow(
        /Invalid gameId/,
      );
      await expect(be.removeFromSteam("epic", bad)).rejects.toThrow(/Invalid gameId/);
    }
  });

  it("uninstallGame keeps the Steam shortcut + state record when the driver throws", async () => {
    let removeFromSteamCalls = 0;
    // Driver throws — the read-modify-write block should bail
    // before the shortcut is removed or the state entry is dropped.
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [{ id: "A", title: "A" }],
      install: async (id, dir) => ({
        id,
        title: id,
        installedAt: "2026-01-01T00:00:00Z",
        installDir: dir,
        executable: `${id}.exe`,
        platform: "windows",
        source: "installed",
        addedToSteam: false,
      }),
      uninstall: async () => {
        throw new Error("legendary uninstall failed");
      },
      launchSpec: () => ({ exe: "/x", args: "" }),
    };
    registerDriver(driver);

    // Custom steam-shortcut mock that counts removeFromSteam calls.
    mock.module("./lib/steam-shortcut", () => ({
      addToSteam: async () => ({ appId: 42, gameId64: "42" }),
      removeFromSteam: async () => {
        removeFromSteamCalls++;
      },
      shortcutDisplayName: (d: { displayName: string }, g: { title: string }) =>
        `${g.title} (${d.displayName})`,
    }));

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await be.getLibrary("epic");
    await be.installGame("epic", "A");
    // Sanity: the install path adds to Steam.
    const before = await be.getLibrary("epic");
    expect(before[0]?.installed?.addedToSteam).toBe(true);
    expect(before[0]?.installed?.steamAppId).toBe(42);

    // The driver throws — uninstallGame must NOT remove the
    // shortcut and must NOT drop the state record. Without the
    // fix the shortcut would be orphaned.
    await expect(be.uninstallGame("epic", "A")).rejects.toThrow(
      /legendary uninstall failed/,
    );
    expect(removeFromSteamCalls).toBe(0);
    const after = await be.getLibrary("epic");
    expect(after[0]?.installed).toBeDefined();
    expect(after[0]?.installed?.steamAppId).toBe(42);
  });

  it("importDetected cancel-while-queued emits a cancelled pipelineEvent", async () => {
    let firstResolver: (() => void) | null = null;
    let aEntered: () => void = () => {};
    const aEnteredP = new Promise<void>((resolve) => {
      aEntered = resolve;
    });
    const importCalls: string[] = [];
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: false }),
      authStatus: async () => "unknown",
      listLibrary: async () => [],
      install: async (id, dir, emit) => {
        aEntered();
        await new Promise<void>((resolve) => {
          firstResolver = resolve;
        });
        emit({ kind: "complete", id: `epic:install:${id}` });
        return {
          id,
          title: id,
          installedAt: "2026-01-01T00:00:00Z",
          installDir: dir,
          executable: `${id}.exe`,
          platform: "windows",
          source: "installed",
          addedToSteam: false,
        };
      },
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x", args: "" }),
      identifyInstall: async () => null,
      importExisting: async (id, dir) => {
        importCalls.push(id);
        return {
          id,
          title: id,
          installedAt: "2026-01-01T00:00:00Z",
          installDir: dir,
          executable: `${id}.exe`,
          platform: "windows",
          source: "imported",
          addedToSteam: false,
        };
      },
    };
    registerDriver(driver);
    mock.module("./lib/steam-shortcut", () => ({
      addToSteam: async () => ({ appId: 1, gameId64: "1" }),
      removeFromSteam: async () => {},
      shortcutDisplayName: (d: { displayName: string }, g: { title: string }) =>
        `${g.title} (${d.displayName})`,
    }));

    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    be.emit = (e) => events.push(e);
    await be.onLoad();
    await be.getLibrary("epic");

    // Block the queue with an install for game A so the import for
    // game B queues behind it. While queued, cancel game B's
    // import — the unit should bail before `importExisting` runs
    // and emit a `cancelled`-flavoured event the UI consumes for
    // a toast.
    const installPromise = be.installGame("epic", "A");
    await aEnteredP;
    const importPromise = be.importDetected("epic", "B", "/mnt/games/B");
    // Cancel the queued import.
    await be.cancelInstall("epic", "B");
    // Drain the queue.
    firstResolver!();
    await installPromise;
    await importPromise;

    // `importExisting` was never invoked — the queued cancel
    // short-circuited the unit.
    expect(importCalls).not.toContain("B");
    // EXACTLY ONE cancelled pipelineEvent fires for game B — the
    // synchronous emit inside `cancelInstall`. The import unit's
    // queued-cancel branch no longer re-emits, so the user sees a
    // single "Install cancelled" toast rather than two back-to-back.
    const cancelledForB = events.filter(
      (e) =>
        e.event === "pipelineEvent" &&
        e.data?.gameId === "B" &&
        /cancelled/i.test(String(e.data?.message ?? "")),
    );
    expect(cancelledForB.length).toBe(1);
  });
});

describe("StoreBridgeBackend — post-multi-agent-review fixes", () => {
  // Earlier tests in this file `registerDriver(...)` with variants
  // that omit fields (e.g. no `completeAuth`, no `selfInstall`) —
  // the registry is a module-scope Map shared across `it()` blocks,
  // so we re-seed a full driver before each test in this group.
  beforeEach(() => {
    const driver: StoreDriver = {
      id: "epic",
      displayName: "Epic Games",
      preflight: async () => ({ ok: true, missing: [], canSelfInstall: true }),
      selfInstall: async () => {},
      authStatus: async () => "unknown",
      startAuth: async () => ({ url: "https://example.test/login" }),
      completeAuth: async () => {},
      signOut: async () => {},
      listLibrary: async () => [
        { id: "fortnite", title: "Fortnite", coverUrl: "https://cdn.test/f.jpg" },
      ],
      install: async (id, dir) => ({
        id,
        title: id,
        installedAt: "2026-01-01T00:00:00Z",
        installDir: dir,
        executable: `${id}.exe`,
        platform: "windows",
        source: "installed",
        addedToSteam: false,
      }),
      uninstall: async () => {},
      launchSpec: () => ({ exe: "/x.exe", args: "" }),
      identifyInstall: async () => null,
      importExisting: async (id, dir) => ({
        id,
        title: id,
        installedAt: "2026-01-01T00:00:00Z",
        installDir: dir,
        executable: `${id}.exe`,
        platform: "windows",
        source: "imported",
        addedToSteam: false,
      }),
    };
    registerDriver(driver);
    mock.module("./lib/steam-shortcut", () => ({
      addToSteam: async () => ({ appId: 1, gameId64: "1" }),
      removeFromSteam: async () => {},
      shortcutDisplayName: (d: { displayName: string }, g: { title: string }) =>
        `${g.title} (${d.displayName})`,
    }));
  });

  it("removeFromSteam skips the gameStatusChanged emit on no-op (no steamAppId to clear)", async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    be.emit = (e) => events.push(e);
    await be.onLoad();
    // The mocked Epic driver's `install` returns an entry with
    // `addedToSteam: false` and no `steamAppId`. Add to Steam is
    // mocked to a no-op (`addToSteam` returns {appId:1, gameId64:"1"})
    // but the install flow doesn't always run through it — to
    // construct the "no steamAppId" state, install then immediately
    // call removeFromSteam without first calling addInstalledToSteam.
    //
    // Actually, the install flow calls addInstalledToSteam implicitly
    // (so the record DOES have steamAppId=1). Force the no-op path
    // by calling removeFromSteam on a gameId that doesn't exist in
    // state. The mutateState callback returns `s` unchanged and we
    // expect ZERO gameStatusChanged events.
    events.length = 0;
    await be.removeFromSteam("epic", "nonexistent");
    const removeEvents = events.filter(
      (e) => e.event === "gameStatusChanged" && e.data?.status === "removed-from-steam",
    );
    expect(removeEvents.length).toBe(0);
  });

  it("addInstalledToSteam writes through the mutex; concurrent uninstall wins cleanly without a phantom write", async () => {
    // Reproduces the TOCTOU the review flagged: a concurrent
    // uninstall landing between the pre-flight read and the post-
    // addToSteam write must NOT resurrect the deleted entry.
    // installGame internally calls addInstalledToSteam, so gate
    // ONLY the second call with a counter — otherwise the install
    // tail blocks the test setup.
    let releaseSecond: () => void = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let callCount = 0;
    mock.module("./lib/steam-shortcut", () => ({
      addToSteam: async () => {
        callCount++;
        if (callCount >= 2) await secondGate;
        return { appId: 42, gameId64: "42" };
      },
      removeFromSteam: async () => {},
      shortcutDisplayName: (d: { displayName: string }, g: { title: string }) =>
        `${g.title} (${d.displayName})`,
    }));

    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await be.getLibrary("epic");
    await be.installGame("epic", "fortnite");
    // First addToSteam call already resolved (during installGame's
    // implicit add). Now call addInstalledToSteam again — this hits
    // the gated second call. While it's gated, drop the install
    // record via uninstall.
    const addPromise = be.addInstalledToSteam("epic", "fortnite");
    // Microtask flush so addInstalledToSteam's pre-flight read +
    // entry into the awaited addToSteam settles before uninstall
    // grabs the mutex.
    await new Promise((r) => setTimeout(r, 10));
    await be.uninstallGame("epic", "fortnite");
    // Release the gated addToSteam. Its post-await mutateState
    // callback must observe the now-empty installed map and refuse
    // to write a phantom record.
    releaseSecond();
    await addPromise;
    const lib = await be.getLibrary("epic");
    expect(lib[0]?.status).toBe("library");
    expect(lib[0]?.installed).toBeUndefined();
  });

  it("addScanPath persists the canonicalised (expanded) form, not the literal '~/...'", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    // Force HOME to a path inside the whitelist root so `~/Games`
    // canonicalises into the allowed range.
    const origHome = process.env.HOME;
    try {
      process.env.HOME = "/mnt";
      const r = await be.addScanPath("~/Games");
      expect(r.ok).toBe(true);
      const settings = await be.getSettings();
      expect(settings.scanPaths).not.toContain("~/Games");
      expect(settings.scanPaths).toContain("/mnt/Games");
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  });

  it("importDetected rejects flag-shaped dirs that would smuggle into legendary's argv", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await expect(
      be.importDetected("epic", "fortnite", "--config-file=/etc/passwd"),
    ).rejects.toThrow(/absolute path/i);
    await expect(
      be.importDetected("epic", "fortnite", "/mnt/games/x\nrm -rf /"),
    ).rejects.toThrow(/control characters/i);
  });

  it("completeAuth rejects flag-shaped + control-char codes", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await expect(be.completeAuth("epic", "--code")).rejects.toThrow(/leading "-"/);
    await expect(be.completeAuth("epic", "")).rejects.toThrow(/length 0/);
    await expect(be.completeAuth("epic", "code\rinjected")).rejects.toThrow(
      /control characters/,
    );
  });
});
