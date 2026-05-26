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
const queued: Array<{ args: CallArgs; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

export interface CallArgs {
  plugin: string;
  method: string;
  args: unknown[];
}

const DEFAULT_PORT = 33820;

function token(): string {
  return typeof window !== "undefined" ? (window.__LOADOUT_TOKEN__ ?? "") : "";
}

export function getUrl(port = DEFAULT_PORT): string {
  const t = token();
  const base = `ws://127.0.0.1:${port}/ws`;
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

export function rejectAllPending(err: Error): void {
  for (const req of pending.values()) {
    try {
      req.reject(err);
    } catch {}
  }
  pending.clear();
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  ws = new WebSocket(getUrl());

  ws.onopen = () => {
    connectAttempt = 0;
    while (queued.length > 0) {
      const item = queued.shift()!;
      sendRequest(item.args, item.resolve, item.reject);
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
      const key = `${msg.plugin}:${msg.event}`;
      eventListeners.get(key)?.forEach((fn) => fn(msg.data));
      return;
    }
    const res = msg as RpcResponse;
    const req = pending.get(res.id);
    if (req) {
      pending.delete(res.id);
      if (res.error) req.reject(new Error(res.error));
      else req.resolve(res.result);
    }
  };

  ws.onclose = () => {
    rejectAllPending(new Error("WebSocket closed"));
    const delay = Math.min(1000 * 2 ** connectAttempt, 10000);
    connectAttempt++;
    setTimeout(connect, delay);
  };

  ws.onerror = () => ws?.close();
}

export function ensureConnected(): void {
  connect();
}

export function onConnect(fn: () => void): () => void {
  connectListeners.add(fn);
  return () => {
    connectListeners.delete(fn);
  };
}

function sendRequest(
  request: CallArgs,
  resolve: (v: unknown) => void,
  reject: (e: Error) => void,
): void {
  const id = crypto.randomUUID();
  pending.set(id, { resolve, reject });
  const req: RpcRequest = {
    id,
    plugin: request.plugin,
    method: request.method,
    args: request.args,
  };
  ws!.send(JSON.stringify(req));
}

export function call(args: CallArgs): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendRequest(args, resolve, reject);
    } else {
      queued.push({ args, resolve, reject });
      connect();
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
