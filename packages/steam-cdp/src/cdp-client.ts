/**
 * Minimal Chrome DevTools Protocol client for CEF injection.
 *
 * Connects to a CEF tab's WebSocket debug endpoint and sends CDP commands.
 * Used by anything that needs to evaluate JavaScript inside Steam's CEF
 * (or any other CEF-based target).
 *
 * For Steam-specific usage there's a higher-level wrapper in
 * `./steam-client.ts` that exposes typed methods like
 * `apps.setAppLaunchOptions(...)` — prefer that for Steam interop.
 */

export interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
}

export class CDPClient {
  private ws: WebSocket | null = null;
  private cmdId = 0;
  private pending = new Map<
    number,
    { resolve: (v: CDPResponse) => void; reject: (e: Error) => void }
  >();
  private eventHandlers = new Map<
    string,
    Set<(params: Record<string, unknown>) => void>
  >();
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);

      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) =>
        reject(new Error(`CDP WebSocket error: ${e}`)),
      );

      this.ws.addEventListener("message", (ev) => {
        let msg: CDPResponse | CDPEvent;
        try {
          msg = JSON.parse(
            typeof ev.data === "string" ? ev.data : ev.data.toString(),
          );
        } catch {
          return;
        }

        // Response to a command
        if ("id" in msg) {
          const res = msg as CDPResponse;
          const pending = this.pending.get(res.id);
          if (pending) {
            this.pending.delete(res.id);
            pending.resolve(res);
          }
          return;
        }

        // Event
        const event = msg as CDPEvent;
        if (event.method) {
          this.eventHandlers
            .get(event.method)
            ?.forEach((fn) => fn(event.params ?? {}));
        }
      });

      this.ws.addEventListener("close", () => {
        // Reject all pending commands
        for (const [, pending] of this.pending) {
          pending.reject(new Error("CDP WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<CDPResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP WebSocket not connected");
    }

    const id = ++this.cmdId;

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`CDP ${method} timeout after ${opts.timeoutMs}ms`));
          }
        }, opts.timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(
    method: string,
    handler: (params: Record<string, unknown>) => void,
  ): () => void {
    let set = this.eventHandlers.get(method);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.eventHandlers.delete(method);
    };
  }

  async evaluate(
    expression: string,
    opts: {
      /** Wait for the evaluated expression's promise to settle. Default false. */
      awaitPromise?: boolean;
      /**
       * Return values by-value rather than as remote object handles.
       * Default `true` — most callers want the actual value back, and
       * returning handles is more useful when the caller plans to issue
       * follow-up CDP calls against the object (rare).
       */
      returnByValue?: boolean;
      /** Reject the underlying `send()` after this many ms. */
      timeoutMs?: number;
    } = {},
  ): Promise<unknown> {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        userGesture: true,
        awaitPromise: opts.awaitPromise ?? false,
        returnByValue: opts.returnByValue ?? true,
      },
      { timeoutMs: opts.timeoutMs },
    );

    if (res.error) {
      throw new Error(`CDP evaluate error: ${res.error.message}`);
    }

    const result = res.result as
      | { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
      | undefined;
    if (result?.exceptionDetails) {
      throw new Error(`JS exception: ${result.exceptionDetails.text}`);
    }

    return result?.result?.value;
  }

  async hasGlobalVar(name: string): Promise<boolean> {
    const result = await this.evaluate(`typeof ${name} !== 'undefined'`);
    return result === true;
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
