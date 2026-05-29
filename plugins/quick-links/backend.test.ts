import { describe, it, expect, mock, beforeEach } from "bun:test";

// ─── Mocks (must precede backend import) ─────────────────────────────

// Per-plugin storage map keyed by plugin id. quick-links and the
// legacy gaming-mode-browser id share this so the migration test can
// stage gaming-mode-browser data before the first onLoad.
let storageByPlugin: Record<string, Record<string, unknown>> = {};
const mockReadPluginStorage = mock(<T = unknown>(pluginId: string) =>
  Promise.resolve((storageByPlugin[pluginId] ?? {}) as T),
);
const mockWritePluginStorage = mock(
  (pluginId: string, data: unknown) => {
    storageByPlugin[pluginId] = data as Record<string, unknown>;
    return Promise.resolve();
  },
);
mock.module("@loadout/plugin-storage", () => ({
  readPluginStorage: mockReadPluginStorage,
  writePluginStorage: mockWritePluginStorage,
}));

const mockRun = mock<
  (
    cmd: string[],
    opts?: { timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
>(() => Promise.resolve({ stdout: "", stderr: "", exitCode: 1 }));
const mockRunFull = mock<
  (
    cmd: string[],
    opts?: { timeoutMs?: number },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
>(() => Promise.resolve({ stdout: "", stderr: "no display", exitCode: 1 }));
const mockSpawn = mock<(...args: unknown[]) => unknown>(() => ({}));
mock.module("@loadout/exec", () => ({
  run: mockRun,
  runFull: mockRunFull,
  spawn: mockSpawn,
}));

const mockAddShortcut = mock<
  (name: string, exe: string, args: string, cmd: string) => Promise<number | null>
>(() => Promise.resolve(null));
const mockRemoveShortcut = mock<(appId: number) => Promise<void>>(() =>
  Promise.resolve(),
);
const mockSetShortcutLaunchOptions = mock<
  (appId: number, options: string) => Promise<void>
>(() => Promise.resolve());
const mockSetShortcutName = mock<(appId: number, name: string) => Promise<void>>(
  () => Promise.resolve(),
);
const mockExecuteSteamURL = mock<(url: string) => Promise<void>>(() =>
  Promise.resolve(),
);
const mockIsReachable = mock<() => Promise<boolean>>(() =>
  Promise.resolve(true),
);

class SteamClientUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SteamClientUnreachableError";
  }
}

mock.module("@loadout/steam-cdp", () => ({
  SteamClientUnreachableError,
  withSteamClient: async <T>(
    fn: (sc: {
      apps: {
        addShortcut: typeof mockAddShortcut;
        removeShortcut: typeof mockRemoveShortcut;
        setShortcutLaunchOptions: typeof mockSetShortcutLaunchOptions;
        setShortcutName: typeof mockSetShortcutName;
      };
      url: { executeSteamURL: typeof mockExecuteSteamURL };
      isReachable: typeof mockIsReachable;
    }) => Promise<T>,
  ): Promise<T> =>
    fn({
      apps: {
        addShortcut: mockAddShortcut,
        removeShortcut: mockRemoveShortcut,
        setShortcutLaunchOptions: mockSetShortcutLaunchOptions,
        setShortcutName: mockSetShortcutName,
      },
      url: { executeSteamURL: mockExecuteSteamURL },
      isReachable: mockIsReachable,
    }),
}));

mock.module("@loadout/steam-paths", () => ({
  getUserdataDir: () => "/home/testuser/.local/share/Steam/userdata",
  getUserIds: () => Promise.resolve(["12345"]),
}));

const mockParseBinaryVdf = mock<(buf: Buffer) => Record<string, unknown>>(() => ({
  shortcuts: {},
}));
mock.module("@loadout/vdf", () => ({
  parseBinaryVdf: mockParseBinaryVdf,
  shortcutGameId64: (appIdUint32: number) =>
    (
      (BigInt(appIdUint32 >>> 0) << 32n) +
      BigInt(0x02000000)
    ).toString(),
}));

const mockReadFile = mock<(path: string, encoding?: string) => Promise<Buffer | string>>(
  () => Promise.resolve(Buffer.from("")),
);
const mockReaddir = mock<(path: string) => Promise<string[]>>(() =>
  Promise.resolve([]),
);
mock.module("fs/promises", () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
}));

// ─── Import after mocks ──────────────────────────────────────────────

const { default: QuickLinksBackend, DEFAULT_TEMPLATES } = await import("./backend");

beforeEach(() => {
  storageByPlugin = {};
  mockReadPluginStorage.mockClear();
  mockWritePluginStorage.mockClear();
  mockRun.mockReset();
  mockRun.mockImplementation(() =>
    Promise.resolve({ stdout: "", stderr: "", exitCode: 1 }),
  );
  mockRunFull.mockReset();
  mockRunFull.mockImplementation(() =>
    Promise.resolve({ stdout: "", stderr: "no display", exitCode: 1 }),
  );
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => ({}));
  mockAddShortcut.mockReset();
  mockAddShortcut.mockImplementation(() => Promise.resolve(null));
  mockRemoveShortcut.mockReset();
  mockRemoveShortcut.mockImplementation(() => Promise.resolve());
  mockSetShortcutLaunchOptions.mockReset();
  mockSetShortcutLaunchOptions.mockImplementation(() => Promise.resolve());
  mockSetShortcutName.mockReset();
  mockSetShortcutName.mockImplementation(() => Promise.resolve());
  mockExecuteSteamURL.mockReset();
  mockExecuteSteamURL.mockImplementation(() => Promise.resolve());
  mockIsReachable.mockReset();
  mockIsReachable.mockImplementation(() => Promise.resolve(true));
  mockReadFile.mockReset();
  mockReadFile.mockImplementation((path) => {
    const p = typeof path === "string" ? path : "";
    if (p.endsWith("/status")) return Promise.resolve("connected\n");
    if (p.endsWith("/modes")) return Promise.resolve("1920x1200\n1280x720\n");
    return Promise.resolve(Buffer.from(""));
  });
  mockReaddir.mockReset();
  mockReaddir.mockImplementation((path) => {
    if (typeof path === "string" && path === "/sys/class/drm") {
      return Promise.resolve(["card1", "card1-eDP-1"]);
    }
    return Promise.resolve([]);
  });
  mockParseBinaryVdf.mockReset();
  mockParseBinaryVdf.mockImplementation(() => ({ shortcuts: {} }));
  delete process.env.GAMESCOPE_DISPLAY;
  delete process.env.GAMESCOPE_WAYLAND_DISPLAY;
  // isGamingMode also reads these — clear them too so tests aren't
  // contaminated by the runner's environment (Bazzite / SteamOS
  // session-level env sets XDG_CURRENT_DESKTOP=gamescope).
  delete process.env.XDG_CURRENT_DESKTOP;
  delete process.env.DESKTOP_SESSION;
});

// ─── Tests ───────────────────────────────────────────────────────────

describe("onLoad seeds defaults", () => {
  it("populates built-in templates + default suffixes on a fresh install", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    const state = await b.getState();
    expect(state.version).toBe(1);
    expect(state.templates.map((t) => t.id)).toEqual(
      DEFAULT_TEMPLATES.map((t) => t.id),
    );
    expect(state.suffixes.youtube.length).toBeGreaterThan(0);
    expect(state.hidden).toEqual([]);
    expect(state.perGame).toEqual({});
    expect(state.installedBrowsers).toEqual([]);
  });

  it("ships ≥19 built-in templates, all with descriptions and at least one placeholder", () => {
    expect(DEFAULT_TEMPLATES.length).toBeGreaterThanOrEqual(19);
    const seenIds = new Set<string>();
    for (const t of DEFAULT_TEMPLATES) {
      expect(seenIds.has(t.id)).toBe(false);
      seenIds.add(t.id);
      expect(t.builtin).toBe(true);
      expect(t.description?.length ?? 0).toBeGreaterThan(0);
      const hasPlaceholder =
        t.urlTemplate.includes("{appId}") ||
        t.urlTemplate.includes("{name}") ||
        t.urlTemplate.includes("{name_raw}");
      expect(hasPlaceholder).toBe(true);
    }
  });

  it("steam-only templates use {appId}", () => {
    for (const t of DEFAULT_TEMPLATES) {
      if (t.steamOnly) {
        expect(t.urlTemplate).toContain("{appId}");
      }
    }
  });

  it("preserves user overrides on built-ins while adding new built-ins from defaults", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [
        {
          id: "youtube",
          name: "YT custom name",
          urlTemplate: "https://yt/?q={name}",
          builtin: true,
          enabled: false,
        },
      ],
      suffixes: { youtube: ["walkthrough"] },
      perGame: {},
      hidden: [],
      installedBrowsers: [],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    const state = await b.getState();
    const yt = state.templates.find((t) => t.id === "youtube")!;
    expect(yt.name).toBe("YT custom name");
    expect(yt.enabled).toBe(false);
    expect(state.suffixes.youtube).toEqual(["walkthrough"]);
    expect(state.templates.find((t) => t.id === "protondb")).toBeTruthy();
  });

  it("migrates legacy gaming-mode-browser shortcuts on first onLoad (v1 single-entry)", async () => {
    // Pre-#121 shape: separate plugin id with a single `installed`
    // record. Quick Links absorbs these so users don't have to
    // re-register Firefox/Chrome after the plugin merge.
    storageByPlugin["gaming-mode-browser"] = {
      installed: {
        browserId: "firefox-native",
        name: "Firefox",
        kind: "native",
        appId: 9999,
        gameId64: "abc",
        exe: "/usr/bin/firefox",
        launchOptionsBase: "--new-tab {url}",
      },
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    const state = await b.getState();
    expect(state.installedBrowsers).toHaveLength(1);
    expect(state.installedBrowsers[0]?.browserId).toBe("firefox-native");
  });

  it("migrates legacy gaming-mode-browser shortcuts on first onLoad (v2 installedList)", async () => {
    storageByPlugin["gaming-mode-browser"] = {
      installedList: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "--new-tab {url}",
        },
        {
          browserId: "chrome-native",
          name: "Google Chrome",
          kind: "native",
          appId: 2,
          gameId64: "2",
          exe: "/usr/bin/google-chrome",
          launchOptionsBase: "--window-size=1920,1080 {url}",
        },
      ],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    const state = await b.getState();
    expect(state.installedBrowsers.map((s) => s.browserId)).toEqual([
      "firefox-native",
      "chrome-native",
    ]);
  });

  it("does not re-import legacy data once quick-links has its own installedBrowsers", async () => {
    storageByPlugin["gaming-mode-browser"] = {
      installed: {
        browserId: "firefox-native",
        name: "Firefox",
        kind: "native",
        appId: 1,
        gameId64: "1",
        exe: "/usr/bin/firefox",
        launchOptionsBase: "--new-tab {url}",
      },
    };
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "brave-native",
          name: "Brave",
          kind: "native",
          appId: 42,
          gameId64: "42",
          exe: "/usr/bin/brave",
          launchOptionsBase: "{url}",
        },
      ],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    const state = await b.getState();
    // Existing installedBrowsers wins — legacy data is ignored.
    expect(state.installedBrowsers.map((s) => s.browserId)).toEqual([
      "brave-native",
    ]);
  });
});

describe("template mutations", () => {
  it("addCustomTemplate persists a non-builtin template and rejects id collisions", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    const tpl = {
      id: "my-wiki",
      name: "Wiki",
      urlTemplate: "https://wiki/?q={name}",
      enabled: true,
    };
    await b.addCustomTemplate(tpl);
    let state = await b.getState();
    const added = state.templates.find((t) => t.id === "my-wiki")!;
    expect(added.builtin).toBe(false);

    await expect(
      b.addCustomTemplate({
        id: "my-wiki",
        name: "dup",
        urlTemplate: "x",
        enabled: true,
      }),
    ).rejects.toThrow(/already exists/);

    state = await b.getState();
    expect(state.templates.filter((t) => t.id === "my-wiki")).toHaveLength(1);
  });

  it("deleteTemplate hides built-ins and hard-deletes custom templates", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();

    await b.deleteTemplate("youtube");
    let state = await b.getState();
    expect(state.hidden).toContain("youtube");
    expect(state.templates.find((t) => t.id === "youtube")).toBeTruthy();

    await b.addCustomTemplate({
      id: "mine",
      name: "Mine",
      urlTemplate: "x",
      enabled: true,
    });
    await b.deleteTemplate("mine");
    state = await b.getState();
    expect(state.templates.find((t) => t.id === "mine")).toBeUndefined();
  });

  it("updateTemplate cannot flip builtin or id", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.updateTemplate("youtube", {
      name: "YT2",
      ...({ id: "evil", builtin: false } as unknown as Record<string, never>),
    });
    const state = await b.getState();
    const yt = state.templates.find((t) => t.id === "youtube")!;
    expect(yt.name).toBe("YT2");
    expect(yt.builtin).toBe(true);
    expect(state.templates.find((t) => t.id === "evil")).toBeUndefined();
  });
});

describe("per-game mutations", () => {
  it("addCustomLink + setPinnedTemplateIds isolate per-game state by appId", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.addCustomLink("620", { name: "Wiki", url: "https://w/" });
    await b.setPinnedTemplateIds("620", ["protondb", "youtube"]);
    await b.addCustomLink("12345678", { name: "Other", url: "https://o/" });

    const state = await b.getState();
    expect(state.perGame["620"].customLinks).toHaveLength(1);
    expect(state.perGame["620"].pinnedTemplateIds).toEqual([
      "protondb",
      "youtube",
    ]);
    expect(state.perGame["12345678"].customLinks).toHaveLength(1);
    expect(state.perGame["12345678"].pinnedTemplateIds).toEqual([]);
  });

  it("removeCustomLink is a no-op for an out-of-range index", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.addCustomLink("1", { name: "A", url: "u" });
    await b.removeCustomLink("1", 99);
    const state = await b.getState();
    expect(state.perGame["1"].customLinks).toHaveLength(1);
  });
});

describe("suffix mutations", () => {
  it("setSuffixes replaces the group's list", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.setSuffixes("youtube", ["only-one"]);
    const state = await b.getState();
    expect(state.suffixes.youtube).toEqual(["only-one"]);
  });
});

describe("resetToDefaults", () => {
  it("clears templates and per-game state but preserves browser shortcuts", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "--new-tab {url}",
        },
      ],
      selectedBrowserId: "firefox-native",
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.addCustomTemplate({
      id: "x",
      name: "x",
      urlTemplate: "x",
      enabled: true,
    });
    await b.setPinnedTemplateIds("99", ["youtube"]);
    await b.resetToDefaults();
    const state = await b.getState();
    expect(state.templates.find((t) => t.id === "x")).toBeUndefined();
    expect(state.perGame).toEqual({});
    // Browser shortcuts represent on-disk Steam library entries —
    // wiping them here would orphan shortcuts.vdf entries. Reset
    // preserves them.
    expect(state.installedBrowsers).toHaveLength(1);
    expect(state.selectedBrowserId).toBe("firefox-native");
  });
});

// ─── Browser shortcut tests (folded in from gaming-mode-browser) ─────

describe("detectDisplayResolution", () => {
  it("returns the first connected output's preferred mode", async () => {
    const { detectDisplayResolution } = await import("./backend");
    const res = await detectDisplayResolution();
    expect(res).toEqual({ width: 1920, height: 1200 });
  });

  it("falls back to 1920×1080 when no output is connected", async () => {
    const { detectDisplayResolution } = await import("./backend");
    mockReadFile.mockImplementation((path) => {
      const p = typeof path === "string" ? path : "";
      if (p.endsWith("/status")) return Promise.resolve("disconnected\n");
      return Promise.resolve(Buffer.from(""));
    });
    const res = await detectDisplayResolution();
    expect(res).toEqual({ width: 1920, height: 1080 });
  });
});

describe("detectBrowsers", () => {
  it("returns native + flatpak entries when both are available", async () => {
    mockRun.mockImplementation((cmd: string[]) => {
      if (cmd[0] === "which" && cmd[1] === "firefox") {
        return Promise.resolve({
          stdout: "/usr/bin/firefox\n",
          stderr: "",
          exitCode: 0,
        });
      }
      if (cmd[0] === "which" && cmd[1] === "flatpak") {
        return Promise.resolve({
          stdout: "/usr/bin/flatpak\n",
          stderr: "",
          exitCode: 0,
        });
      }
      if (cmd[0] === "flatpak" && cmd[1] === "list") {
        return Promise.resolve({
          stdout: "org.mozilla.firefox\ncom.brave.Browser\n",
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    });

    const b = new QuickLinksBackend();
    await b.onLoad();
    const list = await b.detectBrowsers();
    const ids = list.map((c) => c.id);
    expect(ids).toContain("firefox-native");
    expect(ids).toContain("firefox-flatpak");
    expect(ids).toContain("brave-flatpak");

    const flat = list.find((c) => c.id === "firefox-flatpak")!;
    expect(flat.kind).toBe("flatpak");
    expect(flat.exe).toBe("/usr/bin/flatpak");
    expect(flat.launchOptionsBase).toBe(
      "run org.mozilla.firefox --new-tab {url}",
    );
    expect(flat.flatpakAppId).toBe("org.mozilla.firefox");

    const brave = list.find((c) => c.id === "brave-flatpak")!;
    expect(brave.launchOptionsBase).toBe(
      "run com.brave.Browser --window-size=1920,1200 --window-position=0,0 --force-device-scale-factor=1.5 {url}",
    );
  });

  it("omits flatpak entries when flatpak isn't installed", async () => {
    mockRun.mockImplementation((cmd: string[]) => {
      if (cmd[0] === "which" && cmd[1] === "firefox") {
        return Promise.resolve({
          stdout: "/usr/bin/firefox\n",
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    });
    const b = new QuickLinksBackend();
    await b.onLoad();
    const list = await b.detectBrowsers();
    expect(list.some((c) => c.kind === "flatpak")).toBe(false);
    expect(list.some((c) => c.id === "firefox-native")).toBe(true);
  });
});

describe("installBrowserShortcut", () => {
  it("persists the appid Steam returns and writes plugin storage", async () => {
    mockRun.mockImplementation((cmd: string[]) => {
      if (cmd[0] === "which" && cmd[1] === "firefox") {
        return Promise.resolve({
          stdout: "/usr/bin/firefox\n",
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    });
    mockAddShortcut.mockResolvedValueOnce(3000000001);

    const b = new QuickLinksBackend();
    await b.onLoad();
    const installed = await b.installBrowserShortcut("firefox-native");

    expect(installed.appId).toBe(3000000001);
    expect(installed.exe).toBe("/usr/bin/firefox");
    expect(installed.launchOptionsBase).toBe("--new-tab {url}");
    expect(installed.gameId64).toMatch(/^\d+$/);

    expect(mockAddShortcut).toHaveBeenCalledWith(
      "Firefox",
      "/usr/bin/firefox",
      "--new-tab about:blank",
      "",
    );
    expect(mockWritePluginStorage).toHaveBeenCalled();

    const state = await b.getState();
    expect(state.installedBrowsers).toHaveLength(1);
    expect(state.installedBrowsers[0]?.browserId).toBe("firefox-native");
  });

  it("falls back to shortcuts.vdf when AddShortcut returns null", async () => {
    mockRun.mockImplementation((cmd: string[]) => {
      if (cmd[0] === "which" && cmd[1] === "firefox") {
        return Promise.resolve({
          stdout: "/usr/bin/firefox\n",
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    });
    mockAddShortcut.mockResolvedValueOnce(null);
    mockReadFile.mockImplementation(() =>
      Promise.resolve(Buffer.from("stub")),
    );
    mockParseBinaryVdf.mockImplementation(() => ({
      shortcuts: {
        "0": { appid: 0xabcdef01, appname: "Firefox" },
      },
    }));

    const b = new QuickLinksBackend();
    await b.onLoad();
    const installed = await b.installBrowserShortcut("firefox-native");
    expect(installed.appId).toBe(0xabcdef01);
  });

  it("coerces a signed (negative) appid from shortcuts.vdf to the equivalent uint32", async () => {
    // parseBinaryVdf reads `appid` as little-endian int32, so a real
    // non-Steam shortcut whose top bit is set (e.g. 0xFEDCBA98) comes
    // back as a NEGATIVE JS number. `findShortcutAppIdByName` must
    // `>>> 0` it before handing off to `shortcutGameId64`; otherwise
    // the steam://rungameid/<gameId64> URL we ultimately execute
    // points at a completely different shortcut.
    //
    // This test pins the coercion behavior. If
    // `shortcutGameId64`'s input contract ever changes (e.g. it
    // starts taking signed appids), the `>>> 0` site in backend.ts
    // MUST be re-evaluated and this test updated to match.
    mockRun.mockImplementation((cmd: string[]) => {
      if (cmd[0] === "which" && cmd[1] === "firefox") {
        return Promise.resolve({
          stdout: "/usr/bin/firefox\n",
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    });
    mockAddShortcut.mockResolvedValueOnce(null);
    mockReadFile.mockImplementation(() =>
      Promise.resolve(Buffer.from("stub")),
    );
    // `(0xFEDCBA98 | 0)` ⇒ -19088744 — what int32 readback produces.
    mockParseBinaryVdf.mockImplementation(() => ({
      shortcuts: {
        "0": { appid: 0xfedcba98 | 0, appname: "Firefox" },
      },
    }));

    const b = new QuickLinksBackend();
    await b.onLoad();
    const installed = await b.installBrowserShortcut("firefox-native");
    expect(installed.appId).toBe(0xfedcba98);
    expect(installed.appId).toBeGreaterThan(0);
    // gameId64 stub is `((appId >>> 0) << 32n) + 0x02000000n` — so
    // a successful coercion means the BigInt did NOT wrap negative.
    expect(BigInt(installed.gameId64)).toBeGreaterThan(0n);
  });

  it("appends to installedBrowsers — multiple shortcuts can coexist", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "chrome-native",
          name: "Google Chrome",
          kind: "native",
          appId: 111,
          gameId64: "111",
          exe: "/usr/bin/google-chrome",
          launchOptionsBase: "{url}",
        },
      ],
    };
    mockRun.mockImplementation((cmd: string[]) => {
      if (cmd[0] === "which" && cmd[1] === "firefox") {
        return Promise.resolve({
          stdout: "/usr/bin/firefox\n",
          stderr: "",
          exitCode: 0,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    });
    mockAddShortcut.mockResolvedValueOnce(222);

    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.installBrowserShortcut("firefox-native");

    expect(mockRemoveShortcut).not.toHaveBeenCalled();
    const state = await b.getState();
    expect(state.installedBrowsers.map((s) => s.browserId)).toEqual([
      "chrome-native",
      "firefox-native",
    ]);
  });
});

describe("uninstallBrowserShortcut", () => {
  it("clears storage even when RemoveShortcut throws", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 99,
          gameId64: "99",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "",
        },
      ],
    };
    mockRemoveShortcut.mockImplementation(() =>
      Promise.reject(new Error("steam dead")),
    );
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.uninstallBrowserShortcut();
    const state = await b.getState();
    expect(state.installedBrowsers).toEqual([]);
  });

  it("removes only the specified browserId when provided", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "",
        },
        {
          browserId: "chrome-native",
          name: "Chrome",
          kind: "native",
          appId: 2,
          gameId64: "2",
          exe: "/usr/bin/chrome",
          launchOptionsBase: "",
        },
      ],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.uninstallBrowserShortcut("firefox-native");
    const state = await b.getState();
    expect(state.installedBrowsers.map((s) => s.browserId)).toEqual([
      "chrome-native",
    ]);
  });
});

describe("launchUrl", () => {
  it("returns not-installed when no shortcut is registered", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    const result = await b.launchUrl("https://example.com");
    expect(result).toEqual({
      launched: false,
      reason: "not-installed",
      message: expect.stringContaining("install one"),
    });
    expect(mockSetShortcutLaunchOptions).not.toHaveBeenCalled();
  });

  it("native firefox: substitutes URL into the templated launchOptions", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 3000000001,
          gameId64: "12884901890051539456",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "--new-tab {url}",
        },
      ],
    };

    const b = new QuickLinksBackend();
    await b.onLoad();
    const result = await b.launchUrl("https://www.protondb.com/app/620");

    expect(result).toEqual({ launched: true });
    expect(mockSetShortcutLaunchOptions).toHaveBeenCalledWith(
      3000000001,
      "--new-tab https://www.protondb.com/app/620",
    );
    expect(mockExecuteSteamURL).toHaveBeenCalledWith(
      "steam://rungameid/12884901890051539456",
    );
  });

  it("respects selectedBrowserId default when no browserId arg is passed", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      selectedBrowserId: "firefox-native",
      installedBrowsers: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "--new-tab {url}",
        },
        {
          browserId: "chrome-native",
          name: "Chrome",
          kind: "native",
          appId: 2,
          gameId64: "2",
          exe: "/usr/bin/chrome",
          launchOptionsBase: "{url}",
        },
      ],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.launchUrl("https://x");
    // Picks firefox-native (selectedBrowserId) over chrome-native
    // (most-recent install), so the SetShortcutLaunchOptions call
    // targets appId=1 with firefox's --new-tab template.
    expect(mockSetShortcutLaunchOptions).toHaveBeenCalledWith(
      1,
      "--new-tab https://x",
    );
  });

  it("explicit browserId arg overrides the saved selectedBrowserId", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      selectedBrowserId: "firefox-native",
      installedBrowsers: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "--new-tab {url}",
        },
        {
          browserId: "chrome-native",
          name: "Chrome",
          kind: "native",
          appId: 2,
          gameId64: "2",
          exe: "/usr/bin/chrome",
          launchOptionsBase: "{url}",
        },
      ],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    await b.launchUrl("https://x", "chrome-native");
    expect(mockSetShortcutLaunchOptions).toHaveBeenCalledWith(2, "https://x");
  });

  it("returns steam-unreachable when SteamClientUnreachableError is thrown twice", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "firefox-native",
          name: "Firefox",
          kind: "native",
          appId: 1,
          gameId64: "0",
          exe: "/usr/bin/firefox",
          launchOptionsBase: "",
        },
      ],
    };
    mockSetShortcutLaunchOptions.mockImplementation(() =>
      Promise.reject(new SteamClientUnreachableError("nope")),
    );
    const b = new QuickLinksBackend();
    await b.onLoad();
    const result = await b.launchUrl("https://x");
    expect(result.launched).toBe(false);
    expect((result as { reason: string }).reason).toBe("steam-unreachable");
  });
});

describe("isGamingMode + hasChromeOrFirefoxShortcut (banner gating)", () => {
  it("isGamingMode true when GAMESCOPE_DISPLAY is set", async () => {
    process.env.GAMESCOPE_DISPLAY = ":1";
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.isGamingMode()).toBe(true);
  });

  it("isGamingMode true when only GAMESCOPE_WAYLAND_DISPLAY is set", async () => {
    process.env.GAMESCOPE_WAYLAND_DISPLAY = "gamescope-0";
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.isGamingMode()).toBe(true);
  });

  it("isGamingMode false when neither env var is set", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.isGamingMode()).toBe(false);
  });

  it("isGamingMode true when XDG_CURRENT_DESKTOP includes 'gamescope'", async () => {
    // Bazzite + SteamOS gaming-mode boot sets this session-wide;
    // the loadout service inherits it but doesn't get
    // GAMESCOPE_DISPLAY (which lives inside Steam BPM's nested
    // context, not the session).
    process.env.XDG_CURRENT_DESKTOP = "gamescope";
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.isGamingMode()).toBe(true);
  });

  it("isGamingMode true when DESKTOP_SESSION is 'gamescope-session'", async () => {
    process.env.DESKTOP_SESSION = "gamescope-session";
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.isGamingMode()).toBe(true);
  });

  it("isGamingMode false for a plain KDE / GNOME desktop env", async () => {
    process.env.XDG_CURRENT_DESKTOP = "KDE";
    process.env.DESKTOP_SESSION = "plasma";
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.isGamingMode()).toBe(false);
  });

  it("hasChromeOrFirefoxShortcut: true for firefox-flatpak", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "firefox-flatpak",
          name: "Firefox (Flatpak)",
          kind: "flatpak",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/flatpak",
          launchOptionsBase: "run org.mozilla.firefox --new-tab {url}",
        },
      ],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.hasChromeOrFirefoxShortcut()).toBe(true);
  });

  it("hasChromeOrFirefoxShortcut: false when only Brave is installed", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "brave-native",
          name: "Brave",
          kind: "native",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/brave",
          launchOptionsBase: "{url}",
        },
      ],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.hasChromeOrFirefoxShortcut()).toBe(false);
  });

  it("hasChromeOrFirefoxShortcut: true for librewolf (firefox fork)", async () => {
    storageByPlugin["quick-links"] = {
      version: 1,
      templates: [],
      suffixes: {},
      perGame: {},
      hidden: [],
      installedBrowsers: [
        {
          browserId: "librewolf-flatpak",
          name: "LibreWolf (Flatpak)",
          kind: "flatpak",
          appId: 1,
          gameId64: "1",
          exe: "/usr/bin/flatpak",
          launchOptionsBase: "run io.gitlab.librewolf-community --new-tab {url}",
        },
      ],
    };
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.hasChromeOrFirefoxShortcut()).toBe(true);
  });

  it("hasChromeOrFirefoxShortcut: false when nothing is installed", async () => {
    const b = new QuickLinksBackend();
    await b.onLoad();
    expect(await b.hasChromeOrFirefoxShortcut()).toBe(false);
  });
});
