import type { RpcRequest, RpcResponse, RpcEvent } from "@loadout/types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type EventHandler = (data: unknown) => void;

let ws: WebSocket | null = null;
let connectAttempt = 0;
const pending = new Map<string, PendingRequest>();
const eventListeners = new Map<string, Set<EventHandler>>();
const connectListeners = new Set<() => void>();

/**
 * Reject every in-flight request promise and clear the pending map.
 * Used by `onclose` so a dropped socket doesn't strand callers forever.
 * Exported for tests.
 */
export function rejectAllPending(err: Error): void {
  for (const req of pending.values()) {
    try {
      req.reject(err);
    } catch {
      /* defensive — caller's reject handler shouldn't take down the loop */
    }
  }
  pending.clear();
}

function getToken(): string {
  return typeof window !== "undefined" ? window.__LOADOUT_TOKEN__ ?? "" : "";
}

function appendToken(url: string): string {
  const token = getToken();
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Resolve the WebSocket URL to connect to. Exported for tests — pulled
 * out so callers in other packages can verify the environment-detection
 * logic without mounting a real WebSocket.
 */
export function getUrl(): string {
  const loc = typeof window !== "undefined" ? window.location : null;
  // In injection / wrapper contexts, loc.host won't point to our server
  // and constructing `ws://<host>/ws` would fail:
  //   - about:blank                       (steamwebhelper injection)
  //   - steamloopback.host                (BPM tab loopback)
  //   - views://overlay/...               (Electrobun overlay shell)
  // In any of those cases, fall back to the default loader port directly.
  let base: string;
  if (
    loc && loc.host && loc.hostname !== "steamloopback.host" &&
    loc.protocol !== "about:" &&
    loc.protocol !== "views:"
  ) {
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    base = `${proto}//${loc.host}/ws`;
  } else {
    base = "ws://localhost:33820/ws";
  }
  return appendToken(base);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  ws = new WebSocket(getUrl());

  ws.onopen = () => {
    connectAttempt = 0;
    while (queued.length > 0) {
      const { args, resolve, reject } = queued.shift()!;
      sendRequest(args, resolve, reject);
    }
    connectListeners.forEach((fn) => fn());
  };

  ws.onmessage = (ev) => {
    let msg: RpcResponse | RpcEvent;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }

    if ("type" in msg && msg.type === "event") {
      const event = msg as RpcEvent;
      const key = `${event.plugin}:${event.event}`;
      eventListeners.get(key)?.forEach((fn) => fn(event.data));
      return;
    }

    const res = msg as RpcResponse;
    const req = pending.get(res.id);
    if (req) {
      pending.delete(res.id);
      if (res.error) {
        req.reject(new Error(res.error));
      } else {
        req.resolve(res.result);
      }
    }
  };

  ws.onclose = () => {
    // Audit C-010: any in-flight request promises would otherwise stay
    // un-settled forever — the response that would resolve them is gone
    // with the socket. Reject so call() sites can fail fast instead of
    // hanging until the user navigates away.
    rejectAllPending(new Error("WebSocket closed"));
    const delay = Math.min(1000 * 2 ** connectAttempt, 10000);
    connectAttempt++;
    setTimeout(connect, delay);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

export function ensureConnected(): void {
  connect();
}

export function onConnect(fn: () => void): () => void {
  connectListeners.add(fn);
  return () => connectListeners.delete(fn);
}

export interface CallArgs {
  plugin: string;
  method: string;
  args: unknown[];
}

function sendRequest(request: CallArgs, resolve: (v: unknown) => void, reject: (e: Error) => void) {
  const id = crypto.randomUUID();
  pending.set(id, { resolve, reject });
  const req: RpcRequest = { id, plugin: request.plugin, method: request.method, args: request.args };
  ws!.send(JSON.stringify(req));
}

const queued: Array<{ args: CallArgs; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

export function call(args: CallArgs): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendRequest(args, resolve, reject);
    } else {
      queued.push({ args, resolve, reject });
    }
  });
}

export interface SubscribeArgs {
  plugin: string;
  event: string;
  handler: EventHandler;
}

export function subscribe({ plugin, event, handler }: SubscribeArgs): () => void {
  const key = `${plugin}:${event}`;
  let set = eventListeners.get(key);
  if (!set) {
    set = new Set();
    eventListeners.set(key, set);
  }
  set.add(handler);
  return () => {
    set!.delete(handler);
    if (set!.size === 0) eventListeners.delete(key);
  };
}
