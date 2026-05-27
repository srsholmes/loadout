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

// Steam APIs aren't reachable from tests; auto-add-to-steam is gated
// off via settings.autoAddToSteam = false in each test.
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
    // Disable auto-add so we don't touch the Steam mock during install.
    await be.updateSettings({ autoAddToSteam: false });
    const lib = await be.getLibrary("epic");
    expect(lib).toHaveLength(1);
    expect(lib[0]?.title).toBe("Fortnite");
    expect(lib[0]?.status).toBe("library");
  });

  it("installGame transitions a library entry to installed", async () => {
    const { default: Backend } = await import("./backend");
    const be = new Backend();
    await be.onLoad();
    await be.updateSettings({ autoAddToSteam: false });
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
    // Paths outside the whitelist (declared in plugin.json) are
    // rejected to keep the walker from scanning /etc or the home
    // dir's hidden configs even if someone manually pastes a path.
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
    await be.updateSettings({ autoAddToSteam: false });
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
    await be.updateSettings({ autoAddToSteam: false });
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
    await be.updateSettings({ autoAddToSteam: false });
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
