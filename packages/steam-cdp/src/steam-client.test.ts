import { describe, expect, it, beforeEach, mock } from "bun:test";

// Mock the low-level CDPClient so we can assert which JS expression
// SteamClient generates for each Steam API call. The connect / close
// lifecycle is exercised via the spy methods.
const mockEvaluate = mock<(expression: string, opts?: { awaitPromise?: boolean }) => Promise<unknown>>(
  () => Promise.resolve("ok"),
);
const mockConnect = mock<() => Promise<void>>(() => Promise.resolve());
const mockClose = mock<() => void>(() => {});

mock.module("./cdp-client", () => ({
  CDPClient: class {
    constructor(_url: string) {}
    connected = false;
    connect = mockConnect;
    evaluate = mockEvaluate;
    close = mockClose;
  },
}));

// Mock tab discovery so we don't actually hit localhost:8080
const mockFindSharedJsTab = mock<() => Promise<null | {
  webSocketDebuggerUrl: string;
  title: string;
  url: string;
  id: string;
  type: string;
}>>(
  () =>
    Promise.resolve({
      webSocketDebuggerUrl: "ws://localhost:8080/devtools/page/abc",
      title: "SharedJSContext",
      url: "https://steamloopback.host/index.html",
      id: "abc",
      type: "page",
    }),
);
mock.module("./tabs", () => ({
  findSharedJsTab: mockFindSharedJsTab,
  // Identity stubs for unused helpers — real impl isn't exercised here.
  SHARED_JS_CONTEXT_TITLES: new Set(),
  isSharedJSContextTab: () => false,
  listCefTabs: () => Promise.resolve([]),
}));

import {
  SteamClient,
  SteamClientUnreachableError,
  withSteamClient,
} from "./steam-client";

describe("SteamClient.apps.setAppLaunchOptions", () => {
  beforeEach(() => {
    mockEvaluate.mockClear();
    mockConnect.mockClear();
    mockClose.mockClear();
    mockFindSharedJsTab.mockClear();
    mockFindSharedJsTab.mockImplementation(() =>
      Promise.resolve({
        webSocketDebuggerUrl: "ws://localhost:8080/devtools/page/abc",
        title: "SharedJSContext",
        url: "https://steamloopback.host/index.html",
        id: "abc",
        type: "page",
      }),
    );
    mockEvaluate.mockImplementation(() => Promise.resolve("ok"));
  });

  it("connects on first call and runs an awaitable JS expression", async () => {
    const sc = new SteamClient();
    await sc.apps.setAppLaunchOptions("504230", "mangohud %command%");

    expect(mockFindSharedJsTab).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    const [expr, opts] = mockEvaluate.mock.calls[0];
    expect(opts).toEqual({ awaitPromise: true });
    // The call uses JSON.stringify on both args inside the page —
    // numeric appId, quoted options string, no manual escaping.
    expect(expr).toContain("SetAppLaunchOptions");
    expect(expr).toContain("504230"); // numeric
    expect(expr).toContain('"mangohud %command%"'); // JSON.stringify'd
  });

  it("coerces string appId to number", async () => {
    const sc = new SteamClient();
    await sc.apps.setAppLaunchOptions("12345", "");

    const expr = String(mockEvaluate.mock.calls[0][0]);
    // JSON.stringify(Number("12345")) === "12345" with no quotes
    expect(expr).toContain("12345,");
    expect(expr).not.toContain('"12345"');
  });

  it("throws on non-numeric appId before touching CDP", async () => {
    const sc = new SteamClient();
    await expect(
      sc.apps.setAppLaunchOptions("not-a-number", ""),
    ).rejects.toThrow(/Invalid appId/);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it("throws SteamClientUnreachableError when API returns 'no-api'", async () => {
    mockEvaluate.mockImplementation(() => Promise.resolve("no-api"));

    const sc = new SteamClient();
    await expect(
      sc.apps.setAppLaunchOptions("504230", "x"),
    ).rejects.toBeInstanceOf(SteamClientUnreachableError);
  });

  it("throws SteamClientUnreachableError when no SharedJSContext tab is found", async () => {
    mockFindSharedJsTab.mockImplementation(() => Promise.resolve(null));

    const sc = new SteamClient();
    await expect(
      sc.apps.setAppLaunchOptions("504230", "x"),
    ).rejects.toBeInstanceOf(SteamClientUnreachableError);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });

  it("propagates a generic Error on unexpected return value", async () => {
    mockEvaluate.mockImplementation(() => Promise.resolve("garbage"));

    const sc = new SteamClient();
    await expect(
      sc.apps.setAppLaunchOptions("504230", "x"),
    ).rejects.toThrow(/unexpected value/);
  });
});

describe("withSteamClient", () => {
  beforeEach(() => {
    mockClose.mockClear();
    mockEvaluate.mockClear();
    mockEvaluate.mockImplementation(() => Promise.resolve("ok"));
  });

  it("closes the client even when the callback throws after connecting", async () => {
    await expect(
      withSteamClient(async (sc) => {
        // Force a connect so there's something to close.
        await sc.apps.setAppLaunchOptions("504230", "x");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("returns the callback's value on success", async () => {
    const result = await withSteamClient(async (sc) => {
      await sc.apps.setAppLaunchOptions("504230", "x");
      return "done";
    });
    expect(result).toBe("done");
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("serialises concurrent sessions so connections never overlap", async () => {
    // Two simultaneous CDP connections to Steam's SharedJSContext crash
    // the webhelper ("Collided with existing master response stream"), so
    // overlapping sessions are the bug we're guarding against.
    let active = 0;
    let maxActive = 0;
    const body = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all([
      withSteamClient(body),
      withSteamClient(body),
      withSteamClient(body),
    ]);
    expect(maxActive).toBe(1);
  });

  it("keeps serialising after a session rejects", async () => {
    // A failing session must not wedge the chain for the next caller.
    await expect(
      withSteamClient(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await withSteamClient(async () => "after");
    expect(result).toBe("after");
  });
});

describe("SteamClient.apps.addShortcut", () => {
  beforeEach(() => {
    mockEvaluate.mockClear();
    mockEvaluate.mockImplementation(() =>
      Promise.resolve({ tag: "ok", appId: 9876543210 }),
    );
  });

  it("returns the appid Steam allocates for the new shortcut", async () => {
    const sc = new SteamClient();
    const appId = await sc.apps.addShortcut("Firefox", "/usr/bin/firefox");
    expect(appId).toBe(9876543210);
    const expr = String(mockEvaluate.mock.calls[0][0]);
    expect(expr).toContain("AddShortcut");
    expect(expr).toContain('"Firefox"');
    expect(expr).toContain('"/usr/bin/firefox"');
  });

  it("returns null when Steam resolves AddShortcut with a non-numeric value", async () => {
    mockEvaluate.mockImplementation(() =>
      Promise.resolve({ tag: "ok", appId: null }),
    );
    const sc = new SteamClient();
    const appId = await sc.apps.addShortcut("Firefox", "/usr/bin/firefox");
    expect(appId).toBeNull();
  });

  it("throws SteamClientUnreachableError when API is missing", async () => {
    mockEvaluate.mockImplementation(() => Promise.resolve({ tag: "no-api" }));
    const sc = new SteamClient();
    await expect(
      sc.apps.addShortcut("Firefox", "/usr/bin/firefox"),
    ).rejects.toBeInstanceOf(SteamClientUnreachableError);
  });
});

describe("SteamClient.apps.setShortcutLaunchOptions", () => {
  beforeEach(() => {
    mockEvaluate.mockClear();
    mockEvaluate.mockImplementation(() => Promise.resolve("ok"));
  });

  it("dispatches SetShortcutLaunchOptions with numeric appid + JSON-quoted options", async () => {
    const sc = new SteamClient();
    await sc.apps.setShortcutLaunchOptions("3000000000", "https://example.com/?q=hi");
    const expr = String(mockEvaluate.mock.calls[0][0]);
    expect(expr).toContain("SetShortcutLaunchOptions");
    expect(expr).toContain("3000000000,");
    expect(expr).toContain('"https://example.com/?q=hi"');
  });

  it("throws on a non-numeric appid before touching CDP", async () => {
    const sc = new SteamClient();
    await expect(
      sc.apps.setShortcutLaunchOptions("nope", ""),
    ).rejects.toThrow(/Invalid appId/);
    expect(mockEvaluate).not.toHaveBeenCalled();
  });
});

describe("SteamClient.apps.removeShortcut", () => {
  beforeEach(() => {
    mockEvaluate.mockClear();
    mockEvaluate.mockImplementation(() => Promise.resolve("ok"));
  });

  it("dispatches RemoveShortcut with the numeric appid", async () => {
    const sc = new SteamClient();
    await sc.apps.removeShortcut(42);
    const expr = String(mockEvaluate.mock.calls[0][0]);
    expect(expr).toContain("RemoveShortcut");
    expect(expr).toContain("42");
  });
});

describe("SteamClient.apps.getShortcutData", () => {
  beforeEach(() => {
    mockEvaluate.mockClear();
  });

  it("returns the projected shortcut data when present", async () => {
    mockEvaluate.mockImplementation(() =>
      Promise.resolve({
        tag: "ok",
        data: { LaunchOptions: "https://wiki/", AppName: "Firefox" },
      }),
    );
    const sc = new SteamClient();
    const data = await sc.apps.getShortcutData(42);
    expect(data).toEqual({ LaunchOptions: "https://wiki/", AppName: "Firefox" });
  });

  it("returns null when Steam reports no shortcut for the appid", async () => {
    mockEvaluate.mockImplementation(() =>
      Promise.resolve({ tag: "ok", data: null }),
    );
    const sc = new SteamClient();
    expect(await sc.apps.getShortcutData(42)).toBeNull();
  });
});

describe("SteamClient.url.executeSteamURL", () => {
  beforeEach(() => {
    mockEvaluate.mockClear();
    mockEvaluate.mockImplementation(() => Promise.resolve("ok"));
  });

  it("dispatches ExecuteSteamURL with the JSON-quoted URL", async () => {
    const sc = new SteamClient();
    await sc.url.executeSteamURL("steam://rungameid/14572845827080912896");
    const expr = String(mockEvaluate.mock.calls[0][0]);
    expect(expr).toContain("ExecuteSteamURL");
    expect(expr).toContain('"steam://rungameid/14572845827080912896"');
  });

  it("throws SteamClientUnreachableError when ExecuteSteamURL is missing", async () => {
    mockEvaluate.mockImplementation(() => Promise.resolve("no-api"));
    const sc = new SteamClient();
    await expect(
      sc.url.executeSteamURL("steam://open/games"),
    ).rejects.toBeInstanceOf(SteamClientUnreachableError);
  });
});

describe("SteamClient.isReachable", () => {
  beforeEach(() => {
    mockEvaluate.mockClear();
    mockConnect.mockClear();
  });

  it("returns true when SetAppLaunchOptions is bound", async () => {
    mockEvaluate.mockImplementation(() => Promise.resolve(true));
    const sc = new SteamClient();
    expect(await sc.isReachable()).toBe(true);
  });

  it("returns false when SetAppLaunchOptions is not a function", async () => {
    mockEvaluate.mockImplementation(() => Promise.resolve(false));
    const sc = new SteamClient();
    expect(await sc.isReachable()).toBe(false);
  });

  it("returns false (no throw) when connect fails", async () => {
    mockConnect.mockImplementation(() =>
      Promise.reject(new Error("conn refused")),
    );
    const sc = new SteamClient();
    expect(await sc.isReachable()).toBe(false);
  });
});
