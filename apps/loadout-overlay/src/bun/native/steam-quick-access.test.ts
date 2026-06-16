import { describe, it, expect, beforeEach } from "bun:test";
import {
  dismissSteamMenusIfOpen,
  type CdpDeps,
} from "./steam-quick-access";

// Tests inject mock fetch + WebSocket via the CdpDeps parameter rather
// than mutating globalThis. Module-scope global mutation hit a Bun
// module-cache quirk where running this file alongside others left the
// test runner in a state where downstream files re-loading ffi.ts etc.
// would misreport exports as missing.

interface MockTarget {
  type?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

let mockTargets: MockTarget[] = [];
let fetchShouldFail = false;
const mockResponses = {
  evaluateValue: undefined as unknown,
  ackKeyEvents: true,
};
let sentMessages: Array<{ url: string; msg: unknown }> = [];

class MockWebSocket {
  readonly url: string;
  private listeners: Record<string, Array<(e: unknown) => void>> = {
    open: [],
    message: [],
    error: [],
  };

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this._fire("open", {}));
  }

  addEventListener(event: string, fn: (e: unknown) => void): void {
    (this.listeners[event] ??= []).push(fn);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as {
      id: number;
      method: string;
      params?: { expression?: string; type?: string };
    };
    sentMessages.push({ url: this.url, msg });

    let reply: object | null = null;
    if (msg.method === "Runtime.evaluate") {
      reply = {
        id: msg.id,
        result: { result: { value: mockResponses.evaluateValue } },
      };
    } else if (msg.method === "Input.dispatchKeyEvent") {
      if (mockResponses.ackKeyEvents) {
        reply = { id: msg.id, result: {} };
      }
    }
    if (reply) {
      queueMicrotask(() =>
        this._fire("message", { data: JSON.stringify(reply) }),
      );
    }
  }

  close(): void {
    /* no-op */
  }

  private _fire(event: string, payload: object): void {
    for (const fn of this.listeners[event] ?? []) fn(payload);
  }
}

const mockDeps: CdpDeps = {
  fetch: (async (url: string) => {
    if (fetchShouldFail) throw new Error("network fail");
    if (url.includes("/json/list")) {
      return { ok: true, json: async () => mockTargets } as Response;
    }
    return { ok: false, json: async () => null } as Response;
  }) as typeof fetch,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  WebSocket: MockWebSocket as any,
};

beforeEach(() => {
  mockTargets = [];
  fetchShouldFail = false;
  mockResponses.evaluateValue = undefined;
  mockResponses.ackKeyEvents = true;
  sentMessages = [];
});

describe("dismissSteamMenusIfOpen", () => {
  it("returns false when Steam's CDP isn't reachable", async () => {
    fetchShouldFail = true;
    expect(await dismissSteamMenusIfOpen(mockDeps)).toBe(false);
  });

  it("returns false when no menu page is in the target list", async () => {
    mockTargets = [
      {
        type: "page",
        title: "Steam Big Picture Mode",
        webSocketDebuggerUrl: "ws://bpm",
      },
    ];
    expect(await dismissSteamMenusIfOpen(mockDeps)).toBe(false);
  });

  it("does not send Escape when the menu page is hidden", async () => {
    mockTargets = [
      {
        type: "page",
        title: "QuickAccess_uid2",
        webSocketDebuggerUrl: "ws://qam",
      },
    ];
    mockResponses.evaluateValue = false;
    expect(await dismissSteamMenusIfOpen(mockDeps)).toBe(false);
    const keyEvents = sentMessages.filter(
      (s) =>
        (s.msg as { method: string }).method === "Input.dispatchKeyEvent",
    );
    expect(keyEvents).toHaveLength(0);
  });

  it("dispatches keyDown + keyUp Escape when the QAM is visible", async () => {
    mockTargets = [
      {
        type: "page",
        title: "QuickAccess_uid2",
        webSocketDebuggerUrl: "ws://qam",
      },
    ];
    mockResponses.evaluateValue = true;
    expect(await dismissSteamMenusIfOpen(mockDeps)).toBe(true);
    const keyEvents = sentMessages
      .map((s) => s.msg)
      .filter(
        (m): m is { method: string; params: { type: string; key: string } } =>
          (m as { method: string }).method === "Input.dispatchKeyEvent",
      );
    expect(keyEvents).toHaveLength(2);
    expect(keyEvents[0].params.type).toBe("keyDown");
    expect(keyEvents[0].params.key).toBe("Escape");
    expect(keyEvents[1].params.type).toBe("keyUp");
    expect(keyEvents[1].params.key).toBe("Escape");
  });

  it("dispatches Escape into the main menu when it is the open one", async () => {
    mockTargets = [
      {
        type: "page",
        title: "Steam Big Picture Mode",
        webSocketDebuggerUrl: "ws://bpm",
      },
      {
        type: "page",
        title: "MainMenu_uid2",
        webSocketDebuggerUrl: "ws://main",
      },
    ];
    mockResponses.evaluateValue = true;
    expect(await dismissSteamMenusIfOpen(mockDeps)).toBe(true);
    const urls = new Set(sentMessages.map((s) => s.url));
    expect([...urls]).toEqual(["ws://main"]);
  });

  it("only targets Steam's menu pages, not BPM or others", async () => {
    mockTargets = [
      {
        type: "page",
        title: "Steam Big Picture Mode",
        webSocketDebuggerUrl: "ws://bpm",
      },
      {
        type: "page",
        title: "MainMenu_uid2",
        webSocketDebuggerUrl: "ws://main",
      },
      {
        type: "page",
        title: "QuickAccess_uid2",
        webSocketDebuggerUrl: "ws://qam",
      },
    ];
    mockResponses.evaluateValue = true;
    await dismissSteamMenusIfOpen(mockDeps);
    const urls = new Set(sentMessages.map((s) => s.url));
    expect([...urls].sort()).toEqual(["ws://main", "ws://qam"]);
  });
});
