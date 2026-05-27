/**
 * CDPClient unit tests — focus on the wire-level send/receive contract,
 * timeout semantics, and evaluate() option handling. We don't spin up a
 * real WebSocket server; instead we shim CDPClient's `ws` field with a
 * minimal stub that implements the four method/event surfaces the
 * client touches.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { CDPClient } from "./cdp-client";

interface StubListener {
  (ev: unknown): void;
}

class StubWebSocket {
  readyState = 1; // OPEN
  sentMessages: string[] = [];
  private listeners = new Map<string, Set<StubListener>>();

  addEventListener(type: string, fn: StubListener): void {
    let s = this.listeners.get(type);
    if (!s) {
      s = new Set();
      this.listeners.set(type, s);
    }
    s.add(fn);
  }

  removeEventListener(type: string, fn: StubListener): void {
    this.listeners.get(type)?.delete(fn);
  }

  send(msg: string): void {
    this.sentMessages.push(msg);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.fire("close", {});
  }

  fire(type: string, ev: unknown): void {
    this.listeners.get(type)?.forEach((fn) => fn(ev));
  }

  /** Simulate a CDP response landing on the wire. */
  reply(id: number, payload: { result?: unknown; error?: { code: number; message: string } } = {}): void {
    this.fire("message", { data: JSON.stringify({ id, ...payload }) });
  }
}

/**
 * Build a CDPClient that's pre-wired against `stub` without actually
 * opening a WebSocket. `connect()` reuses the real wire-up path that the
 * production code goes through, just against the stub.
 */
async function makeClient(stub: StubWebSocket): Promise<CDPClient> {
  const client = new CDPClient("ws://stub");
  // Swap the global WebSocket so the real connect() picks up the stub,
  // then immediately fire "open" so the connect() promise resolves.
  const originalWS = globalThis.WebSocket as unknown;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = function (_url: string) {
    return stub;
  } as unknown;
  try {
    const connectPromise = client.connect();
    // Real ws.addEventListener("open", resolve) is registered synchronously.
    queueMicrotask(() => stub.fire("open", {}));
    await connectPromise;
    return client;
  } finally {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWS;
  }
}

describe("CDPClient.send", () => {
  let stub: StubWebSocket;
  let client: CDPClient;

  beforeEach(async () => {
    stub = new StubWebSocket();
    client = await makeClient(stub);
  });

  it("serialises {id, method, params} onto the wire", async () => {
    const pending = client.send("Page.reload", { ignoreCache: true });
    expect(stub.sentMessages).toHaveLength(1);
    const sent = JSON.parse(stub.sentMessages[0]);
    expect(sent.method).toBe("Page.reload");
    expect(sent.params).toEqual({ ignoreCache: true });
    expect(typeof sent.id).toBe("number");
    stub.reply(sent.id, { result: { ok: true } });
    const res = await pending;
    expect(res.result).toEqual({ ok: true });
  });

  it("returns the response shape (no auto-throw on error field)", async () => {
    const pending = client.send("Page.reload");
    const id = JSON.parse(stub.sentMessages[0]).id;
    stub.reply(id, { error: { code: -1, message: "fail" } });
    const res = await pending;
    expect(res.error).toEqual({ code: -1, message: "fail" });
  });

  it("rejects after timeoutMs elapses without a reply", async () => {
    const start = Date.now();
    await expect(
      client.send("Page.reload", {}, { timeoutMs: 30 }),
    ).rejects.toThrow(/timeout/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(500);
  });

  it("doesn't time out when the reply arrives first", async () => {
    const pending = client.send("Page.reload", {}, { timeoutMs: 200 });
    const id = JSON.parse(stub.sentMessages[0]).id;
    queueMicrotask(() => stub.reply(id, { result: { ok: true } }));
    const res = await pending;
    expect(res.result).toEqual({ ok: true });
    // Wait past the timeout to confirm no late rejection
    await new Promise((r) => setTimeout(r, 220));
  });

  it("rejects when the socket isn't connected", async () => {
    stub.close();
    await expect(client.send("Page.reload")).rejects.toThrow(/not connected/);
  });
});

describe("CDPClient.evaluate", () => {
  let stub: StubWebSocket;
  let client: CDPClient;

  beforeEach(async () => {
    stub = new StubWebSocket();
    client = await makeClient(stub);
  });

  it("defaults to userGesture + returnByValue", async () => {
    const pending = client.evaluate("1+1");
    const sent = JSON.parse(stub.sentMessages[0]);
    expect(sent.method).toBe("Runtime.evaluate");
    expect(sent.params.expression).toBe("1+1");
    expect(sent.params.userGesture).toBe(true);
    expect(sent.params.returnByValue).toBe(true);
    expect(sent.params.awaitPromise).toBe(false);
    stub.reply(sent.id, { result: { result: { value: 2 } } });
    expect(await pending).toBe(2);
  });

  it("passes awaitPromise through when requested", async () => {
    const pending = client.evaluate("Promise.resolve(42)", { awaitPromise: true });
    const sent = JSON.parse(stub.sentMessages[0]);
    expect(sent.params.awaitPromise).toBe(true);
    stub.reply(sent.id, { result: { result: { value: 42 } } });
    expect(await pending).toBe(42);
  });

  it("propagates timeoutMs to send()", async () => {
    await expect(
      client.evaluate("forever()", { timeoutMs: 20 }),
    ).rejects.toThrow(/timeout/);
  });

  it("surfaces a JS exception inside the evaluated expression", async () => {
    const pending = client.evaluate("throw new Error('boom')");
    const sent = JSON.parse(stub.sentMessages[0]);
    stub.reply(sent.id, {
      result: {
        result: { value: undefined },
        exceptionDetails: { text: "Uncaught Error: boom" },
      },
    });
    await expect(pending).rejects.toThrow(/Uncaught Error: boom/);
  });

  it("surfaces a CDP-level error response", async () => {
    const pending = client.evaluate("anything");
    const sent = JSON.parse(stub.sentMessages[0]);
    stub.reply(sent.id, { error: { code: -1, message: "Session closed" } });
    await expect(pending).rejects.toThrow(/Session closed/);
  });
});
