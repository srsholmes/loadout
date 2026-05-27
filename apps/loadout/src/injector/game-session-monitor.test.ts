import { describe, expect, it } from "bun:test";
import { createGameSessionMonitor, type GameSessionEvent } from "./game-session-monitor";
import type { CDPClient, CDPResponse } from "../steam-cdp";

// ---------------------------------------------------------------------------
// Mock CDP Client
// ---------------------------------------------------------------------------

/**
 * A minimal mock of CDPClient that records sent commands and allows
 * simulating Runtime.bindingCalled events.
 */
function createMockCDP() {
  const eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  const sentCommands: Array<{ method: string; params: Record<string, unknown> }> = [];
  let _connected = true;
  let evaluateResult: unknown = "registered";

  const cdp = {
    get connected() {
      return _connected;
    },

    async send(method: string, params: Record<string, unknown> = {}): Promise<CDPResponse> {
      sentCommands.push({ method, params });
      return { id: sentCommands.length, result: {} };
    },

    on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
      let set = eventHandlers.get(method);
      if (!set) {
        set = new Set();
        eventHandlers.set(method, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
        if (set!.size === 0) eventHandlers.delete(method);
      };
    },

    async evaluate(expression: string, _awaitPromise = false): Promise<unknown> {
      sentCommands.push({ method: "Runtime.evaluate", params: { expression } });
      return evaluateResult;
    },

    async hasGlobalVar(_name: string): Promise<boolean> {
      return false;
    },

    close() {
      _connected = false;
    },
  } as unknown as CDPClient;

  return {
    cdp,
    sentCommands,
    eventHandlers,
    /** Simulate a CDP event being fired (e.g., Runtime.bindingCalled) */
    emitEvent(method: string, params: Record<string, unknown>) {
      eventHandlers.get(method)?.forEach((fn) => fn(params));
    },
    /** Control the result of cdp.evaluate() */
    setEvaluateResult(result: unknown) {
      evaluateResult = result;
    },
    /** Disconnect the mock CDP */
    disconnect() {
      _connected = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGameSessionMonitor", () => {
  it("subscribes to game sessions on creation", async () => {
    const mockCdp = createMockCDP();

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: () => {},
      onGameExit: () => {},
      loaderPort: 33820,
      sessionToken: "test-token-123",
    });

    // Should have sent Runtime.enable and Runtime.addBinding
    const methods = mockCdp.sentCommands.map((c) => c.method);
    expect(methods).toContain("Runtime.enable");
    expect(methods).toContain("Runtime.addBinding");

    // Should have evaluated the subscription script
    const evalCmds = mockCdp.sentCommands.filter((c) => c.method === "Runtime.evaluate");
    expect(evalCmds.length).toBeGreaterThanOrEqual(1);

    // The evaluated script should poll SteamUIStore.MainRunningApp
    // (the same observable Steam uses to render its focused-app UI).
    const scriptExpr = evalCmds[0].params.expression as string;
    expect(scriptExpr).toContain("SteamUIStore.MainRunningApp");
    expect(scriptExpr).toContain("__loadoutGameSessionMonitor");

    await monitor.cleanup();
  });

  it("calls onGameLaunch when bRunning=true via binding callback", async () => {
    const mockCdp = createMockCDP();
    const launches: Array<{ appId: number; gameName: string }> = [];
    const exits: Array<{ appId: number; gameName: string }> = [];

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: (appId, gameName) => launches.push({ appId, gameName }),
      onGameExit: (appId, gameName) => exits.push({ appId, gameName }),
      loaderPort: 33820,
      sessionToken: "test-token",
    });

    // Simulate a binding callback for game launch
    const bindingCmd = mockCdp.sentCommands.find(
      (c) => c.method === "Runtime.addBinding",
    );
    const bindingName = bindingCmd?.params.name as string;

    const launchEvent: GameSessionEvent = {
      type: "launch",
      appId: 730,
      gameName: "Counter-Strike 2",
      timestamp: Date.now(),
    };

    mockCdp.emitEvent("Runtime.bindingCalled", {
      name: bindingName,
      payload: JSON.stringify(launchEvent),
    });

    expect(launches).toHaveLength(1);
    expect(launches[0].appId).toBe(730);
    expect(launches[0].gameName).toBe("Counter-Strike 2");
    expect(exits).toHaveLength(0);

    await monitor.cleanup();
  });

  it("calls onGameExit when bRunning=false via binding callback", async () => {
    const mockCdp = createMockCDP();
    const launches: Array<{ appId: number; gameName: string }> = [];
    const exits: Array<{ appId: number; gameName: string }> = [];

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: (appId, gameName) => launches.push({ appId, gameName }),
      onGameExit: (appId, gameName) => exits.push({ appId, gameName }),
      loaderPort: 33820,
      sessionToken: "test-token",
    });

    const bindingCmd = mockCdp.sentCommands.find(
      (c) => c.method === "Runtime.addBinding",
    );
    const bindingName = bindingCmd?.params.name as string;

    const exitEvent: GameSessionEvent = {
      type: "exit",
      appId: 570,
      gameName: "Dota 2",
      timestamp: Date.now(),
    };

    mockCdp.emitEvent("Runtime.bindingCalled", {
      name: bindingName,
      payload: JSON.stringify(exitEvent),
    });

    expect(exits).toHaveLength(1);
    expect(exits[0].appId).toBe(570);
    expect(exits[0].gameName).toBe("Dota 2");
    expect(launches).toHaveLength(0);

    await monitor.cleanup();
  });

  it("cleanup function unsubscribes from events and evaluates cleanup script", async () => {
    const mockCdp = createMockCDP();

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: () => {},
      onGameExit: () => {},
      loaderPort: 33820,
      sessionToken: "test-token",
    });

    // Before cleanup: binding handler is registered
    expect(mockCdp.eventHandlers.has("Runtime.bindingCalled")).toBe(true);

    const cmdCountBefore = mockCdp.sentCommands.length;

    await monitor.cleanup();

    // After cleanup: binding handler should be removed
    expect(mockCdp.eventHandlers.has("Runtime.bindingCalled")).toBe(false);

    // Should have evaluated the cleanup script
    const cleanupEvals = mockCdp.sentCommands
      .slice(cmdCountBefore)
      .filter((c) => c.method === "Runtime.evaluate");
    expect(cleanupEvals.length).toBeGreaterThanOrEqual(1);

    const cleanupExpr = cleanupEvals[0].params.expression as string;
    expect(cleanupExpr).toContain("__loadoutGameSessionMonitor");
    expect(cleanupExpr).toContain("stop");
  });

  it("handles CDP disconnect gracefully during cleanup", async () => {
    const mockCdp = createMockCDP();

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: () => {},
      onGameExit: () => {},
      loaderPort: 33820,
      sessionToken: "test-token",
    });

    // Simulate CDP disconnect
    mockCdp.disconnect();

    // Cleanup should not throw even though CDP is disconnected
    await expect(monitor.cleanup()).resolves.toBeUndefined();
  });

  it("ignores binding callbacks with wrong name", async () => {
    const mockCdp = createMockCDP();
    const launches: Array<{ appId: number; gameName: string }> = [];

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: (appId, gameName) => launches.push({ appId, gameName }),
      onGameExit: () => {},
      loaderPort: 33820,
      sessionToken: "test-token",
    });

    // Emit a binding event with a different name — should be ignored
    mockCdp.emitEvent("Runtime.bindingCalled", {
      name: "someOtherBinding",
      payload: JSON.stringify({
        type: "launch",
        appId: 440,
        gameName: "Team Fortress 2",
        timestamp: Date.now(),
      }),
    });

    expect(launches).toHaveLength(0);

    await monitor.cleanup();
  });

  it("ignores malformed binding payloads without crashing", async () => {
    const mockCdp = createMockCDP();
    const launches: Array<{ appId: number; gameName: string }> = [];
    const logMessages: string[] = [];

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: (appId, gameName) => launches.push({ appId, gameName }),
      onGameExit: () => {},
      loaderPort: 33820,
      sessionToken: "test-token",
      log: (msg) => logMessages.push(msg),
    });

    const bindingCmd = mockCdp.sentCommands.find(
      (c) => c.method === "Runtime.addBinding",
    );
    const bindingName = bindingCmd?.params.name as string;

    // Emit a binding event with invalid JSON payload
    mockCdp.emitEvent("Runtime.bindingCalled", {
      name: bindingName,
      payload: "not-json{{{",
    });

    // Should not crash and should not fire callbacks
    expect(launches).toHaveLength(0);
    // Should have logged the error
    expect(logMessages.some((m) => m.includes("Failed to parse"))).toBe(true);

    await monitor.cleanup();
  });

  it("polls MainRunningApp and dispatches via the CDP binding (no fetch)", async () => {
    const mockCdp = createMockCDP();

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: () => {},
      onGameExit: () => {},
      loaderPort: 12345,
      sessionToken: "super-secret-token",
    });

    const evalCmds = mockCdp.sentCommands.filter((c) => c.method === "Runtime.evaluate");
    const scriptExpr = evalCmds[0].params.expression as string;

    // Steam's CEF blocks fetch() to localhost (mixed content), so the script
    // must NOT include the loader port or session token — dispatch goes
    // through the CDP binding callback and the in-process broadcast hook.
    expect(scriptExpr).not.toContain("super-secret-token");
    expect(scriptExpr).not.toContain("/api/rpc");
    // It MUST include the binding name.
    expect(scriptExpr).toContain("__loadoutGameSessionCallback");

    await monitor.cleanup();
  });

  it("handles multiple launch/exit events in sequence", async () => {
    const mockCdp = createMockCDP();
    const events: GameSessionEvent[] = [];

    const monitor = await createGameSessionMonitor(mockCdp.cdp, {
      onGameLaunch: (appId, gameName) =>
        events.push({ type: "launch", appId, gameName, timestamp: Date.now() }),
      onGameExit: (appId, gameName) =>
        events.push({ type: "exit", appId, gameName, timestamp: Date.now() }),
      loaderPort: 33820,
      sessionToken: "test-token",
    });

    const bindingCmd = mockCdp.sentCommands.find(
      (c) => c.method === "Runtime.addBinding",
    );
    const bindingName = bindingCmd?.params.name as string;

    // Launch game 1
    mockCdp.emitEvent("Runtime.bindingCalled", {
      name: bindingName,
      payload: JSON.stringify({ type: "launch", appId: 730, gameName: "CS2", timestamp: 1 }),
    });

    // Launch game 2
    mockCdp.emitEvent("Runtime.bindingCalled", {
      name: bindingName,
      payload: JSON.stringify({ type: "launch", appId: 570, gameName: "Dota 2", timestamp: 2 }),
    });

    // Exit game 1
    mockCdp.emitEvent("Runtime.bindingCalled", {
      name: bindingName,
      payload: JSON.stringify({ type: "exit", appId: 730, gameName: "CS2", timestamp: 3 }),
    });

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "launch", appId: 730 });
    expect(events[1]).toMatchObject({ type: "launch", appId: 570 });
    expect(events[2]).toMatchObject({ type: "exit", appId: 730 });

    await monitor.cleanup();
  });
});
