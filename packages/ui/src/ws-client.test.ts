import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getUrl, rejectAllPending } from "./ws-client";

/**
 * These tests pin the same-origin detection logic in getUrl(). The rule
 * is: "is this page actually served from our loader, or is it running
 * inside some wrapper/injection?" Every wrapper we care about gets a
 * dedicated case because the fallout of getting it wrong is silent —
 * new WebSocket(<garbage>) queues forever and plugins just spin.
 */

type WinStub = { location: { host?: string; hostname?: string; protocol?: string } } | null;

function setWindow(win: WinStub) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  // The SSR branch in getUrl() checks `typeof window !== "undefined"`,
  // so `delete` is the only way to simulate a Node context — assigning
  // null would leave typeof as "object" and crash on `.location`.
  if (win === null) {
    delete g.window;
  } else {
    g.window = win;
  }
}

function setToken(token: string | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (token == null) delete (globalThis as any).window?.__LOADOUT_TOKEN__;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  else if ((globalThis as any).window) (globalThis as any).window.__LOADOUT_TOKEN__ = token;
}

beforeEach(() => setWindow(null));
afterEach(() => setWindow(null));

describe("ws-client getUrl", () => {
  it("uses the page's own host when served from a normal origin (dev via vite proxy)", () => {
    setWindow({
      location: {
        host: "localhost:1420",
        hostname: "localhost",
        protocol: "http:",
      },
    });
    expect(getUrl()).toBe("ws://localhost:1420/ws");
  });

  it("upgrades to wss for https origins", () => {
    setWindow({
      location: {
        host: "foo.example",
        hostname: "foo.example",
        protocol: "https:",
      },
    });
    expect(getUrl()).toBe("wss://foo.example/ws");
  });

  it("falls back to the loader's port for about:blank (steamwebhelper injection)", () => {
    setWindow({ location: { host: "", hostname: "", protocol: "about:" } });
    expect(getUrl()).toBe("ws://localhost:33820/ws");
  });

  it("falls back for steamloopback.host (Steam's BPM tab loopback)", () => {
    setWindow({
      location: {
        host: "steamloopback.host",
        hostname: "steamloopback.host",
        protocol: "https:",
      },
    });
    expect(getUrl()).toBe("ws://localhost:33820/ws");
  });

  it("falls back for views: (Electrobun overlay shell)", () => {
    setWindow({
      location: { host: "overlay", hostname: "overlay", protocol: "views:" },
    });
    expect(getUrl()).toBe("ws://localhost:33820/ws");
  });

  it("falls back when there is no window (SSR / node context)", () => {
    setWindow(null);
    expect(getUrl()).toBe("ws://localhost:33820/ws");
  });

  it("appends ?token=… when window.__LOADOUT_TOKEN__ is set", () => {
    setWindow({ location: { host: "localhost:1420", hostname: "localhost", protocol: "http:" } });
    setToken("abc-123");
    expect(getUrl()).toBe("ws://localhost:1420/ws?token=abc-123");
  });

  it("url-encodes reserved characters in the token", () => {
    setWindow({ location: { host: "localhost:1420", hostname: "localhost", protocol: "http:" } });
    setToken("a&b=c d");
    expect(getUrl()).toBe("ws://localhost:1420/ws?token=a%26b%3Dc%20d");
  });
});

/**
 * Audit C-010: when the WebSocket closes mid-flight, any pending
 * request promises would otherwise stay un-settled forever — the
 * response never comes. `rejectAllPending` is the centralised
 * cleanup that `onclose` now calls.
 *
 * The pending map is module-private, so we only assert the exported
 * helper is safe to call (no-throw, idempotent). The behavioural
 * test that `onclose` calls it would require booting a real WebSocket;
 * the static call from `onclose` is small enough to read by eye.
 */
describe("ws-client rejectAllPending (C-010)", () => {
  it("is a no-op when nothing is in flight", () => {
    expect(() => rejectAllPending(new Error("WebSocket closed"))).not.toThrow();
  });
  it("is idempotent across repeated invocations", () => {
    rejectAllPending(new Error("first"));
    expect(() => rejectAllPending(new Error("second"))).not.toThrow();
  });
});
