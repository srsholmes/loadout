import { describe, it, expect, beforeEach, mock } from "bun:test";

// ── Fake CDPClient ─────────────────────────────────────────────────────────
// Mock @loadout/steam-cdp so no real WebSocket is opened. Every evaluate() is
// recorded so tests can assert exactly which scripts were pushed to which tab.
type EvalCall = { wsUrl: string; expr: string };
let evalCalls: EvalCall[] = [];
let clientsConstructed: string[] = [];
// expr-substring → canned return value (first match wins).
let evalResponder: (expr: string) => unknown = () => "";

class FakeCDPClient {
  connected = true;
  constructor(public wsUrl: string) {
    clientsConstructed.push(wsUrl);
  }
  async connect(): Promise<void> {}
  async evaluate(expr: string): Promise<unknown> {
    evalCalls.push({ wsUrl: this.wsUrl, expr });
    return evalResponder(expr);
  }
  close(): void {
    this.connected = false;
  }
}

mock.module("@loadout/steam-cdp", () => ({ CDPClient: FakeCDPClient }));

// ── Fake /json fetch ───────────────────────────────────────────────────────
let fetchCalls: string[] = [];
let tabsResponse: unknown[] = [];
const realFetch = globalThis.fetch;

const { SteamCefBadgeInjector } = await import("./injector");
import type { SteamCefBadgeInjectorConfig } from "./injector";

function tab(title: string, url = "", id = title): {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: string;
} {
  return { id, title, url, webSocketDebuggerUrl: `ws://${id}`, type: "page" };
}

type TestData = { appId: string; n: number };

function makeInjector(
  isGameMode: () => boolean,
  over: Partial<SteamCefBadgeInjectorConfig<TestData>> = {},
) {
  return new SteamCefBadgeInjector<TestData>({
    pluginId: "test-badges",
    styleId: "test-styles",
    bpmGlobalName: "__test_badges",
    storeGlobalName: "__test_store_badges",
    css: "/*css*/",
    bpmScript: "/*bpm-script*/",
    buildStoreScript: (d) => `/*store-script:${d ? d.appId : "none"}*/`,
    fetchBadgeData: async (appId) => ({ appId, n: 1 }),
    buildBpmUpdateExpr: (d) =>
      d ? `__test_badges.update(${JSON.stringify(d)})` : `__test_badges.update(null)`,
    isGameMode,
    log: () => {},
    warn: () => {},
    ...over,
  });
}

beforeEach(() => {
  evalCalls = [];
  clientsConstructed = [];
  fetchCalls = [];
  tabsResponse = [];
  evalResponder = () => "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify(tabsResponse), { status: 200 });
  }) as typeof fetch;
});

describe("SteamCefBadgeInjector — desktop mode gate (#111)", () => {
  it("opens no connection and fetches no /json when not in Gaming Mode", async () => {
    tabsResponse = [tab("SharedJSContext", "https://steamloopback.host/")];
    const inj = makeInjector(() => false);
    await inj.start();

    expect(fetchCalls).toEqual([]);
    expect(clientsConstructed).toEqual([]);
    expect(inj.connected).toBe(false);
    expect(inj.getStatus()).toEqual({
      connected: false,
      tabs: 0,
      detail: "Steam CEF badges are only available in Gaming Mode.",
    });
    expect(inj.getCurrentAppId()).toBeNull();
    await inj.stop();
  });

  it("reconnect() returns a Gaming-Mode error in desktop mode", async () => {
    const inj = makeInjector(() => false);
    const r = await inj.reconnect();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Gaming Mode/);
    expect(fetchCalls).toEqual([]);
  });

  it("health tick stays network-silent in desktop mode but re-checks the gate", async () => {
    let mode = false;
    const inj = makeInjector(() => mode);
    await inj.start();
    expect(fetchCalls).toEqual([]);

    // Drive a health tick directly (deterministic, no real timer).
    await (inj as unknown as { _checkHealth(): Promise<void> })._checkHealth();
    expect(fetchCalls).toEqual([]); // still silent

    // Flip to Gaming Mode; next tick should connect.
    mode = true;
    tabsResponse = [tab("SharedJSContext", "https://steamloopback.host/")];
    await (inj as unknown as { _checkHealth(): Promise<void> })._checkHealth();
    expect(fetchCalls.some((u) => u.includes("/json"))).toBe(true);
    expect(inj.connected).toBe(true);
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — Gaming Mode connect + inject", () => {
  beforeEach(() => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("MainMenu_uid2", "https://steamloopback.host/"),
      tab("Store", "https://store.steampowered.com/app/440", "store-tab"),
    ];
    evalResponder = (expr) =>
      expr.includes("window.location.href")
        ? "https://store.steampowered.com/app/440"
        : "";
  });

  it("connects to SharedJSContext + MainMenu + store and injects css/scripts", async () => {
    const inj = makeInjector(() => true);
    await inj.start();

    expect(inj.connected).toBe(true);
    // SharedJSContext, MainMenu_uid2, store-tab → 3 sockets.
    expect(clientsConstructed.sort()).toEqual(
      ["ws://MainMenu_uid2", "ws://SharedJSContext", "ws://store-tab"].sort(),
    );
    expect(inj.getStatus()).toEqual({ connected: true, tabs: 3 });

    // BPM script + css went into the MainMenu render tab.
    const bpmEvals = evalCalls.filter((c) => c.wsUrl === "ws://MainMenu_uid2");
    expect(bpmEvals.some((c) => c.expr.includes("/*bpm-script*/"))).toBe(true);
    expect(bpmEvals.some((c) => c.expr.includes("/*css*/"))).toBe(true);

    // Store script (with appId 440 embedded) went into the store tab.
    const storeEvals = evalCalls.filter((c) => c.wsUrl === "ws://store-tab");
    expect(storeEvals.some((c) => c.expr.includes("/*store-script:440*/"))).toBe(true);
    await inj.stop();
  });

  it("warns (no throw) and stays connected via SharedJSContext when no BPM tab exists", async () => {
    tabsResponse = [tab("SharedJSContext", "https://steamloopback.host/")];
    const inj = makeInjector(() => true);
    await inj.start();
    expect(inj.connected).toBe(true); // SharedJSContext alone keeps it connected
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — render-target selection", () => {
  // Real SteamOS shape: the Steam menu / QAM / toasts are browser-view
  // popups; the BPM window is not.
  const POPUP = "about:blank?browserviewpopup=1&requestid=1&parentpopup=2";
  const BPM_WINDOW = "about:blank?createflags=6292738&browserType=4";

  it("renders into the BPM window only, never the Steam menu popup", async () => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("MainMenu_uid2", POPUP),
      tab("Steam Big Picture Mode", BPM_WINDOW),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const menuEvals = evalCalls.filter((c) => c.wsUrl === "ws://MainMenu_uid2");
    const bpmEvals = evalCalls.filter(
      (c) => c.wsUrl === "ws://Steam Big Picture Mode",
    );
    expect(bpmEvals.some((c) => c.expr.includes("/*bpm-script*/"))).toBe(true);
    expect(menuEvals.some((c) => c.expr.includes("/*bpm-script*/"))).toBe(false);
    expect(menuEvals.some((c) => c.expr.includes("/*css*/"))).toBe(false);
    await inj.stop();
  });

  it("renders into a BPM window whose title is localized (#259)", async () => {
    // Steam translates the window title (`SP_WindowTitle_BigPicture`), so
    // matching it in English left non-English clients with no window in the
    // render tier — the badges fell through to the MainMenu popup, which is
    // *not* localized, and appeared only inside the Steam menu.
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("MainMenu_uid2", POPUP),
      tab("Режим Big Picture", BPM_WINDOW, "ru-bpm"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const script = (ws: string) =>
      evalCalls.some((c) => c.wsUrl === ws && c.expr.includes("/*bpm-script*/"));
    expect(script("ws://ru-bpm")).toBe(true);
    expect(script("ws://MainMenu_uid2")).toBe(false);
    await inj.stop();
  });

  it("renders into the real captured Gaming Mode target list, localized", async () => {
    // Verbatim from a live Gaming Mode session (loadout.service journal,
    // 2026-08-20), with only the window title swapped for its Russian
    // translation — i.e. exactly what issue #259's reporter had on screen.
    const GAMING_BPM =
      "about:blank?createflags=6292738&minwidth=853&minheight=534&pid=0&browser=-1&browserType=4&useragent=Valve%20Steam%20Gamepad";
    tabsResponse = [
      tab("QuickAccess_uid2", "about:blank?browserviewpopup=1&requestid=2&parentpopup=2", "qam"),
      tab("MainMenu_uid2", "about:blank?browserviewpopup=1&requestid=1&parentpopup=2", "menu"),
      tab("Режим Big Picture", GAMING_BPM, "bpm"),
      tab("SharedJSContext", "https://steamloopback.host/routes/login", "shared"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const script = (ws: string) =>
      evalCalls.some((c) => c.wsUrl === ws && c.expr.includes("/*bpm-script*/"));
    expect(script("ws://bpm")).toBe(true);
    expect(script("ws://menu")).toBe(false);
    expect(script("ws://qam")).toBe(false);
    await inj.stop();
  });

  it("elects the localized Gaming-Mode window over the desktop window", async () => {
    // The desktop client's window is titled "Steam" in every locale, so a
    // BPM-shaped window under any other title is the Gaming-Mode one.
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/routes/", "shared"),
      tab("Steam", "about:blank?browserType=4&useragent=Valve%20Steam%20Client", "desktop-bpm"),
      tab("Steam 大屏幕模式", `${BPM_WINDOW}&useragent=Valve%20Steam%20Gamepad`, "zh-bpm"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const script = (ws: string) =>
      evalCalls.some((c) => c.wsUrl === ws && c.expr.includes("/*bpm-script*/"));
    expect(script("ws://zh-bpm")).toBe(true);
    expect(script("ws://desktop-bpm")).toBe(false);
    await inj.stop();
  });

  it("never treats a desktop chrome popup as the BPM window", async () => {
    // Desktop Steam runs ~10 `about:blank` menu targets ("Store Root Menu",
    // "Profile Supernav", …). None carries a browserType, so relaxing the
    // title match must not promote them to a render target.
    const SUPERNAV = "about:blank?createflags=4538378&pid=0&browser=-1&openerid=3";
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/routes/", "shared"),
      tab("Store Root Menu", SUPERNAV, "supernav"),
      tab("Notifications Menu", SUPERNAV, "notifications"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    expect(clientsConstructed).not.toContain("ws://supernav");
    expect(clientsConstructed).not.toContain("ws://notifications");
    expect(inj.getStatus().detail).toMatch(/no Big Picture window/i);
    await inj.stop();
  });

  it("scrubs a badge an earlier build left in the Steam menu popup", async () => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("MainMenu_uid2", POPUP),
      tab("Steam Big Picture Mode", BPM_WINDOW),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const menuEvals = evalCalls.filter((c) => c.wsUrl === "ws://MainMenu_uid2");
    expect(
      menuEvals.some(
        (c) =>
          c.expr.includes("__test_badges.cleanup()") &&
          c.expr.includes('getElementById("test-styles")'),
      ),
    ).toBe(true);
    await inj.stop();
  });

  it("falls back to MainMenu popups when there is no BPM window", async () => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("MainMenu_uid2", POPUP),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const menuEvals = evalCalls.filter((c) => c.wsUrl === "ws://MainMenu_uid2");
    expect(menuEvals.some((c) => c.expr.includes("/*bpm-script*/"))).toBe(true);
    await inj.stop();
  });

  it("never renders into SharedJSContext, and says so", async () => {
    // SharedJSContext is the invisible page (docs/steam-ui-injection.md).
    // Electing it would draw nothing while reporting everything is fine.
    tabsResponse = [tab("SharedJSContext", "https://steamloopback.host/")];
    const inj = makeInjector(() => true);
    await inj.start();

    const sharedEvals = evalCalls.filter((c) => c.wsUrl === "ws://SharedJSContext");
    expect(sharedEvals.some((c) => c.expr.includes("/*bpm-script*/"))).toBe(false);
    expect(inj.getStatus().detail).toMatch(/no Big Picture window/i);
    await inj.stop();
  });

  it("classifies a BPM window titled \"Steam\" as the window, not the context", async () => {
    // "Steam" is in SHARED_JS_NAMES, so a desktop-BPM window carrying
    // browserType=4 would otherwise collapse onto the SharedJSContext key,
    // evict the real shared context and be excluded from the render tier.
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/", "shared"),
      tab("Steam", "about:blank?browserType=4", "bpm"),
      tab("MainMenu_uid2", POPUP),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const bpmEvals = evalCalls.filter((c) => c.wsUrl === "ws://bpm");
    const menuEvals = evalCalls.filter((c) => c.wsUrl === "ws://MainMenu_uid2");
    expect(bpmEvals.some((c) => c.expr.includes("/*bpm-script*/"))).toBe(true);
    expect(menuEvals.some((c) => c.expr.includes("/*bpm-script*/"))).toBe(false);
    // The real shared context survived under its own key.
    expect(clientsConstructed).toContain("ws://shared");
    await inj.stop();
  });

  it("route polling is a no-op without SharedJSContext, not a badge eviction", async () => {
    // tempNavStore only exists on SharedJSContext, and BPM's location is
    // pinned to the entry URL — so reading the route from the render tab
    // would yield a non-matching pathname, push a null update, and wipe a
    // badge that was on screen.
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/routes/"),
      tab("Steam Big Picture Mode", BPM_WINDOW),
    ];
    evalResponder = (expr) =>
      expr.includes("tempNavStore")
        ? "/library/app/620"
        : "https://steamloopback.host/index.html";
    const inj = makeInjector(() => true);
    await inj.start();

    // Establish a badge on screen — without this the test is vacuous, since
    // a null-yielding fallback is indistinguishable from no poll at all.
    await (inj as unknown as { _pollCurrentAppId(): Promise<void> })._pollCurrentAppId();
    await new Promise((r) => setTimeout(r, 0));
    expect(inj.getCurrentAppId()).toBe("620");

    // Now lose the shared context, leaving the render tab alive.
    const conns = (
      inj as unknown as { connections: Map<string, { client: FakeCDPClient }> }
    ).connections;
    conns.delete("SharedJSContext");
    evalResponder = () => "https://steamloopback.host/index.html";
    evalCalls = [];

    await (inj as unknown as { _pollCurrentAppId(): Promise<void> })._pollCurrentAppId();
    await new Promise((r) => setTimeout(r, 0));

    expect(inj.getCurrentAppId()).toBe("620");
    expect(evalCalls.some((c) => c.expr.includes("update(null)"))).toBe(false);
    await inj.stop();
  });

  it("ignores a same-titled tab that isn't served from steamloopback", async () => {
    // SHARED_JS_NAMES contains generic titles, so an ordinary community tab
    // titled "Steam" can claim the key on title alone.
    tabsResponse = [
      tab("Steam", "https://steamcommunity.com/app/440", "decoy"),
      tab("SharedJSContext", "https://steamloopback.host/routes/", "shared"),
      tab("Steam Big Picture Mode", BPM_WINDOW, "bpm"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    expect(clientsConstructed).not.toContain("ws://decoy");
    await inj.stop();
  });

  it("resolves a duplicate SharedJSContext claim on merit, not list order", async () => {
    // Both are candidates here (both titled SharedJSContext), so only the
    // ranking decides — and Steam lists the weaker one first.
    tabsResponse = [
      tab("SharedJSContext", "https://steamcommunity.com/", "weak"),
      tab("SharedJSContext", "https://steamloopback.host/routes/", "canonical"),
      tab("Steam Big Picture Mode", BPM_WINDOW, "bpm"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const conns = (
      inj as unknown as { connections: Map<string, { client: { wsUrl: string } }> }
    ).connections;
    expect(conns.get("SharedJSContext")?.client.wsUrl).toBe("ws://canonical");
    await inj.stop();
  });

  it("elects a single BPM window when two are present", async () => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/routes/", "shared"),
      tab("Steam", "about:blank?browserType=4", "desktop-bpm"),
      tab("Steam Big Picture Mode", BPM_WINDOW, "gaming-bpm"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    const script = (ws: string) =>
      evalCalls.some((c) => c.wsUrl === ws && c.expr.includes("/*bpm-script*/"));
    expect(script("ws://gaming-bpm")).toBe(true);
    expect(script("ws://desktop-bpm")).toBe(false);
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — route poll + push coalescing", () => {
  beforeEach(() => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("MainMenu_uid2", "https://steamloopback.host/"),
    ];
  });

  it("pushes buildBpmUpdateExpr output to BPM tabs on a route change", async () => {
    let pathname = "/library/home";
    evalResponder = (expr) => (expr.includes("tempNavStore") ? pathname : "");
    const inj = makeInjector(() => true);
    await inj.start();
    evalCalls = [];

    pathname = "/library/app/620";
    await (inj as unknown as { _pollCurrentAppId(): Promise<void> })._pollCurrentAppId();
    // allow the fire-and-forget push to drain
    await new Promise((r) => setTimeout(r, 0));

    expect(inj.getCurrentAppId()).toBe("620");
    const pushed = evalCalls.filter((c) => c.wsUrl === "ws://MainMenu_uid2");
    expect(pushed.some((c) => c.expr.includes('"appId":"620"'))).toBe(true);
    await inj.stop();
  });

  it("pushes the null expr when navigating off a game page", async () => {
    let pathname = "/library/app/620";
    evalResponder = (expr) => (expr.includes("tempNavStore") ? pathname : "");
    const inj = makeInjector(() => true);
    await inj.start();
    await (inj as unknown as { _pollCurrentAppId(): Promise<void> })._pollCurrentAppId();
    await new Promise((r) => setTimeout(r, 0));
    evalCalls = [];

    pathname = "/library/home";
    await (inj as unknown as { _pollCurrentAppId(): Promise<void> })._pollCurrentAppId();
    await new Promise((r) => setTimeout(r, 0));

    expect(inj.getCurrentAppId()).toBeNull();
    const pushed = evalCalls.filter((c) => c.wsUrl === "ws://MainMenu_uid2");
    expect(pushed.some((c) => c.expr.includes("update(null)"))).toBe(true);
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — obscured gate", () => {
  const BPM_WINDOW = "about:blank?createflags=6292738";

  beforeEach(() => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("Steam Big Picture Mode", BPM_WINDOW),
    ];
  });

  it("injects the gate and the hide rule when a selector is configured", async () => {
    const inj = makeInjector(() => true, {
      obscuredHideSelector: "#test-badge",
    });
    await inj.start();

    const bpm = evalCalls.filter((c) => c.wsUrl === "ws://Steam Big Picture Mode");
    // Hide rule rides along with the plugin CSS.
    expect(
      bpm.some((c) =>
        c.expr.includes(
          "html.loadout-badges-obscured-test_badges #test-badge { display: none !important; }",
        ),
      ),
    ).toBe(true);
    // Gate listens on standard DOM events only — no Steam globals.
    const gate = bpm.find((c) => c.expr.includes("__loadout_badge_gate_"));
    expect(gate).toBeDefined();
    expect(gate?.expr).toContain('addEventListener("blur"');
    expect(gate?.expr).toContain('addEventListener("visibilitychange"');
    expect(gate?.expr).toContain("document.hasFocus()");
    await inj.stop();
  });

  it("stays out entirely when no selector is configured", async () => {
    const inj = makeInjector(() => true);
    await inj.start();

    const bpm = evalCalls.filter((c) => c.wsUrl === "ws://Steam Big Picture Mode");
    expect(bpm.some((c) => c.expr.includes("__loadout_badge_gate_"))).toBe(false);
    expect(bpm.some((c) => c.expr.includes("loadout-badges-obscured"))).toBe(false);
    await inj.stop();
  });

  it("cleans the gate up on stop()", async () => {
    const inj = makeInjector(() => true, {
      obscuredHideSelector: "#test-badge",
    });
    await inj.start();
    evalCalls = [];
    await inj.stop();

    expect(
      evalCalls.some((c) =>
        c.expr.includes("window.__loadout_badge_gate_test_badges.cleanup()"),
      ),
    ).toBe(true);
  });
});

describe("SteamCefBadgeInjector — status detail", () => {
  it("names the debug port when /json is unreachable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const inj = makeInjector(() => true);
    await inj.start();

    const { connected, detail } = inj.getStatus();
    expect(connected).toBe(false);
    expect(detail).toContain("8080");
    expect(detail).toContain(".cef-enable-remote-debugging");
    await inj.stop();
  });

  it("clears the detail once badges can render", async () => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("Steam Big Picture Mode", "about:blank?createflags=6292738"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();
    expect(inj.getStatus().detail).toBeUndefined();
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — rediscovery back-off", () => {
  const BPM_WINDOW = "about:blank?createflags=6292738&browserType=4";
  const tick = (inj: unknown) =>
    (inj as { _checkHealth(): Promise<void> })._checkHealth();

  it("stops re-running discovery when Steam simply has no shared context", async () => {
    // Without a back-off this re-connects every socket and re-runs the BPM
    // script every 5s forever — and the badge script's own cleanup() drops
    // the badge before the async re-push restores it, so it blinks each tick.
    tabsResponse = [
      tab("Steam Big Picture Mode", BPM_WINDOW, "bpm"),
      tab("MainMenu_uid2", "about:blank?browserviewpopup=1", "menu"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();

    fetchCalls = [];
    evalCalls = [];
    for (let i = 0; i < 8; i++) await tick(inj);

    // 8 ticks, but the back-off ratchets 1→3→7, so only a couple land.
    expect(fetchCalls.length).toBeLessThanOrEqual(3);
    const reinjects = evalCalls.filter((c) => c.expr.includes("/*bpm-script*/"));
    expect(reinjects.length).toBeLessThanOrEqual(3);
    await inj.stop();
  });

  it("backs off the same way when only SharedJSContext exists", async () => {
    tabsResponse = [tab("SharedJSContext", "https://steamloopback.host/routes/")];
    const inj = makeInjector(() => true);
    await inj.start();

    fetchCalls = [];
    for (let i = 0; i < 8; i++) await tick(inj);
    expect(fetchCalls.length).toBeLessThanOrEqual(3);
    await inj.stop();
  });

  it("keeps retrying every tick while Steam is unreachable", async () => {
    // A failed connect is Steam-not-up-yet, not a missing target — that must
    // not inherit the back-off or startup reconnection gets slow.
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const inj = makeInjector(() => true);
    await inj.start();
    for (let i = 0; i < 4; i++) await tick(inj);
    expect(inj.connected).toBe(false);
    await inj.stop();
  });

  it("resets the back-off as soon as a connection drops", async () => {
    tabsResponse = [tab("Steam Big Picture Mode", BPM_WINDOW, "bpm")];
    const inj = makeInjector(() => true);
    await inj.start();
    // 5 ticks leaves the countdown mid-flight (ratchet 1 → 3, one skip left),
    // which is the only state where the reset is observable.
    for (let i = 0; i < 5; i++) await tick(inj);

    const conns = (
      inj as unknown as { connections: Map<string, { client: FakeCDPClient }> }
    ).connections;
    for (const c of conns.values()) c.client.connected = false;

    fetchCalls = [];
    await tick(inj);
    expect(fetchCalls.some((u) => u.includes("/json"))).toBe(true);
    await inj.stop();
  });

  it("reports the missing shared context instead of looking healthy", async () => {
    tabsResponse = [tab("Steam Big Picture Mode", BPM_WINDOW, "bpm")];
    const inj = makeInjector(() => true);
    await inj.start();

    const { connected, detail } = inj.getStatus();
    expect(connected).toBe(true);
    expect(detail).toMatch(/shared context/i);
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — state emission", () => {
  it("emits the connect failure reason to an already-open panel", async () => {
    const emitted: { connected: boolean; detail?: string }[] = [];
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const inj = makeInjector(() => true, {
      onStateChange: (s) => void emitted.push(s),
    });
    await inj.start();

    expect(emitted.some((e) => e.detail?.includes(".cef-enable-remote-debugging"))).toBe(
      true,
    );
    await inj.stop();
  });

  it("emits the Gaming-Mode reason on a mode flip", async () => {
    const emitted: { connected: boolean; detail?: string }[] = [];
    let mode = true;
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/routes/"),
      tab("Steam Big Picture Mode", "about:blank?browserType=4", "bpm"),
    ];
    const inj = makeInjector(() => mode, {
      onStateChange: (s) => void emitted.push(s),
    });
    await inj.start();
    emitted.length = 0;

    mode = false;
    const r = await inj.reconnect();
    expect(r.success).toBe(false);
    expect(inj.connected).toBe(false);
    expect(emitted.some((e) => e.detail?.includes("Gaming Mode"))).toBe(true);
    await inj.stop();
  });

  it("emits the Gaming-Mode reason when rediscovery lands in desktop mode", async () => {
    // Steam restarted into Desktop Mode: the old sockets die, health prunes
    // them, rediscovery runs and hits _tryConnect's Gaming-Mode gate.
    const emitted: { connected: boolean; detail?: string }[] = [];
    let mode = true;
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/routes/"),
      tab("Steam Big Picture Mode", "about:blank?browserType=4", "bpm"),
    ];
    const inj = makeInjector(() => mode, {
      onStateChange: (s2) => void emitted.push(s2),
    });
    await inj.start();
    emitted.length = 0;

    const conns = (
      inj as unknown as { connections: Map<string, { client: FakeCDPClient }> }
    ).connections;
    for (const c of conns.values()) c.client.connected = false;
    mode = false;

    await (inj as unknown as { _checkHealth(): Promise<void> })._checkHealth();
    expect(emitted.some((e) => e.detail?.includes("Gaming Mode"))).toBe(true);
    await inj.stop();
  });

  it("emits the Gaming-Mode reason at startup in desktop mode", async () => {
    const emitted: { connected: boolean; detail?: string }[] = [];
    const inj = makeInjector(() => false, {
      onStateChange: (s2) => void emitted.push(s2),
    });
    await inj.start();
    expect(emitted.some((e) => e.detail?.includes("Gaming Mode"))).toBe(true);
    await inj.stop();
  });

  it("does not re-emit an unchanged reason", async () => {
    const emitted: unknown[] = [];
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const inj = makeInjector(() => true, {
      onStateChange: (s) => void emitted.push(s),
    });
    await inj.start();
    const after = emitted.length;
    await (inj as unknown as { _checkHealth(): Promise<void> })._checkHealth();
    expect(emitted.length).toBe(after);
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — inject re-entrancy", () => {
  it("does not run two injects concurrently", async () => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/routes/"),
      tab("Steam Big Picture Mode", "about:blank?browserType=4", "bpm"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();
    evalCalls = [];

    const inject = () =>
      (inj as unknown as { _injectBadgeSystem(): Promise<void> })._injectBadgeSystem();
    await Promise.all([inject(), inject()]);

    const scripts = evalCalls.filter((c) => c.expr.includes("/*bpm-script*/"));
    expect(scripts.length).toBe(1);
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — health prune", () => {
  it("prunes a dead connection and rediscovers", async () => {
    tabsResponse = [
      tab("SharedJSContext", "https://steamloopback.host/"),
      tab("MainMenu_uid2", "https://steamloopback.host/"),
    ];
    const inj = makeInjector(() => true);
    await inj.start();
    expect(inj.getStatus().tabs).toBe(2);

    // Kill all live sockets, then health tick should prune + rediscover.
    const conns = (
      inj as unknown as { connections: Map<string, { client: FakeCDPClient }> }
    ).connections;
    for (const c of conns.values()) c.client.connected = false;

    fetchCalls = [];
    await (inj as unknown as { _checkHealth(): Promise<void> })._checkHealth();
    // Rediscovery re-ran (gated) and reconnected fresh sockets.
    expect(fetchCalls.some((u) => u.includes("/json"))).toBe(true);
    expect(inj.connected).toBe(true);
    await inj.stop();
  });
});

describe("SteamCefBadgeInjector — cleanup", () => {
  it("stop() restores the real fetch indirectly (sanity) and clears state", async () => {
    tabsResponse = [tab("SharedJSContext", "https://steamloopback.host/")];
    const inj = makeInjector(() => true);
    await inj.start();
    await inj.stop();
    expect(inj.getStatus()).toMatchObject({ connected: false, tabs: 0 });
    // restore real fetch for any later suites
    globalThis.fetch = realFetch;
  });
});
