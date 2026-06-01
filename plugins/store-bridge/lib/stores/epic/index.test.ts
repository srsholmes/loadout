import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { PipelineEmit } from "../../types";

// We exercise the real EpicDriverImpl class — but stub its leaf
// collaborators (the legendary subprocess wrapper, the binary
// resolver, the .egstore identifier). The post-install verifier
// at `index.ts:233-238` lives inside `EpicDriverImpl.install` and
// is what we're here to cover: it calls `lg.listInstalled()` after
// `lg.install()` returns, and throws if the install isn't listed.
// backend.spec.ts mocks the whole epic module and so never hits
// this path; this file runs in its own bun-test process (see
// scripts/test-backend.sh) so its mocks don't collide.

let installInvokedWith: Array<{ appName: string; basePath: string }> = [];
let listInstalledReturn: Array<{ app_name: string }> = [];
let infoReturn: unknown = null;

const FakeLegendaryFactory = (binary: string) => ({
  binary,
  install: async (
    appName: string,
    basePath: string,
    emit: PipelineEmit,
    _opts?: unknown,
  ) => {
    installInvokedWith.push({ appName, basePath });
    emit({ kind: "complete", id: `epic:install:${appName}` });
  },
  listInstalled: async () => listInstalledReturn,
  info: async () => infoReturn,
  uninstall: async () => {},
  importInstall: async () => {},
});

mock.module("./legendary", () => ({
  Legendary: class {
    constructor(public readonly binary: string) {
      Object.assign(this, FakeLegendaryFactory(binary));
    }
  },
  EPIC_LOGIN_URL: "https://legendary.gl/epiclogin",
}));

mock.module("./install-legendary", () => ({
  resolveLegendaryBinary: async () => "/tmp/legendary",
  probeLegendary: async () => ({ ok: true, version: "0.20.34" }),
  installLegendary: async () => "/tmp/legendary",
  bundledLegendaryPath: () => "/tmp/legendary",
}));

mock.module("./identify", () => ({
  identifyEpicInstall: async () => null,
  // Pass-through sanitiser — the real `identify.ts:sanitiseTitle` is
  // covered by its own spec. The stub keeps `epic/index.ts`'s named
  // import resolvable inside this in-process test module.
  sanitiseTitle: (raw: string) => raw,
  TITLE_MAX_LEN: 256,
}));

mock.module("@loadout/external-cache", () => ({
  createExternalCache: () => ({
    getOrFetch: async <T>(_k: string, c: () => Promise<T>) => c(),
  }),
}));

mock.module("../../platform", () => ({
  storeInstallDir: (storeId: string) => `/tmp/games/${storeId}`,
  binDir: () => "/tmp/bin",
  configDir: () => "/tmp/config",
  cacheDir: () => "/tmp/cache",
  dataDir: () => "/tmp/data",
  gamesDir: () => "/tmp/games",
}));

beforeEach(() => {
  installInvokedWith = [];
  listInstalledReturn = [];
  infoReturn = null;
});

describe("EpicDriverImpl.install — post-install verifier", () => {
  it("throws when legendary exits 0 but the title isn't in list-installed", async () => {
    // Driver-level emulation of the race: install resolves with no
    // error (legendary's lock-contention path can exit 0 without
    // actually installing), but listInstalled doesn't show the app.
    listInstalledReturn = []; // empty — the bug shape
    const { epicDriver } = await import("./index");

    const emit: PipelineEmit = () => {};
    await expect(
      epicDriver.install("Alba", "/tmp/games/epic/Alba", emit),
    ).rejects.toThrow(/exited 0 but Alba isn't in list-installed/i);
  });

  it("resolves to an InstalledGame when the verifier sees the title", async () => {
    listInstalledReturn = [{ app_name: "Alba" }];
    infoReturn = {
      game: {
        app_name: "Alba",
        version: "1.2.3",
        metadata: {
          title: "Alba: A Wildlife Adventure",
          keyImages: [],
        },
      },
      manifest: {
        install_size: 123456,
        launch_exe: "Alba.exe",
        launch_parameters: "-fullscreen",
      },
    };

    const { epicDriver } = await import("./index");
    const emit: PipelineEmit = () => {};
    const installed = await epicDriver.install(
      "Alba",
      "/tmp/games/epic/Alba",
      emit,
    );
    expect(installed.id).toBe("Alba");
    expect(installed.source).toBe("installed");
    expect(installed.installDir).toBe("/tmp/games/epic/Alba");
  });

  it("passes the parent of installDir to legendary as --base-path", async () => {
    listInstalledReturn = [{ app_name: "Alba" }];
    infoReturn = { manifest: { launch_exe: "Alba.exe" } };
    const { epicDriver } = await import("./index");
    await epicDriver.install("Alba", "/tmp/games/epic/Alba", () => {});
    expect(installInvokedWith[0]?.basePath).toBe("/tmp/games/epic");
  });
});

describe("EpicDriverImpl.identifyInstall", () => {
  it("delegates to identifyEpicInstall", async () => {
    mock.module("./identify", () => ({
      identifyEpicInstall: async (dir: string) =>
        dir.endsWith("/known") ? { id: "Known", title: "Known Game" } : null,
      sanitiseTitle: (raw: string) => raw,
      TITLE_MAX_LEN: 256,
    }));
    // Re-import so the new identify mock takes effect for this test.
    const { epicDriver } = await import("./index");
    expect(await epicDriver.identifyInstall!("/games/foo/known")).toEqual({
      id: "Known",
      title: "Known Game",
    });
  });
});

describe("EpicDriverImpl.launchSpec", () => {
  it("uses the stored executable when present (Windows on Linux)", async () => {
    const { epicDriver } = await import("./index");
    const spec = epicDriver.launchSpec({
      id: "Alba",
      title: "Alba",
      installedAt: "2026-01-01T00:00:00Z",
      installDir: "/games/alba",
      executable: "Alba.exe",
      launchParameters: "--fullscreen",
      platform: "windows",
      source: "installed",
      addedToSteam: false,
    });
    expect(spec.exe).toBe("/games/alba/Alba.exe");
    expect(spec.args).toBe("--fullscreen");
    expect(spec.cwd).toBe("/games/alba");
  });

  it("falls back to `legendary launch` when no executable is recorded", async () => {
    const { epicDriver } = await import("./index");
    const spec = epicDriver.launchSpec({
      id: "Legacy",
      title: "Legacy",
      installedAt: "2026-01-01T00:00:00Z",
      installDir: "/games/legacy",
      source: "installed",
      addedToSteam: false,
    });
    expect(spec.args).toContain("legendary launch Legacy");
  });
});
