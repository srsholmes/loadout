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
    expect(inj.getStatus()).toEqual({ connected: false, tabs: 0 });
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
    expect(inj.getStatus()).toEqual({ connected: false, tabs: 0 });
    // restore real fetch for any later suites
    globalThis.fetch = realFetch;
  });
});
