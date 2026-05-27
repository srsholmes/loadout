// Programmatic Steam Quick Access Menu (QAM) dismissal via Chrome
// DevTools Protocol.
//
// Why this exists: when the user has Steam's QAM open in BPM home with
// a game alive in baselayer, opening our overlay reliably wedges
// gamescope's compositor → device-wide input freeze. The QAM is NOT a
// separate X window — it's a CEF browser_view popup INSIDE Steam BPM's
// X window (page title "QuickAccess_uid2" in Steam's CDP target list).
// We can't manipulate the QAM via X11 atoms because there's nothing on
// the X tree to manipulate. But Steam's CEF instance exposes CDP on
// localhost:8080, and dispatching Input.dispatchKeyEvent(Escape) into
// the QAM's page reliably closes it (verified empirically).
//
// We only call into this from gamescope-atoms.ts during show() when
// we detect the trigger scenario. Failure / timeout / Steam not having
// CDP open is silently ignored — it's a best-effort cleanup.

import { trace } from "./trace";

/** Steam's CEF DevTools port. Hard-coded by Steam. */
const STEAM_CDP_PORT = 8080;

/** Page title Steam gives its QAM browser_view. Stable since Big Picture
 *  Mode launched (each popup gets a `_uid2` suffix on a stable name). */
const QAM_PAGE_TITLE = "QuickAccess_uid2";

/** Cap any single CDP fetch / WebSocket round-trip. Prevents a stalled
 *  Steam CEF from hanging our show() hot path. */
const CDP_OP_TIMEOUT_MS = 800;

interface CdpTarget {
  title?: string;
  type?: string;
  webSocketDebuggerUrl?: string;
}

/** Network dependencies used to talk to Steam's CDP. Injectable so
 *  tests can stub them per-call without mutating globals (which leaks
 *  across Bun test files). Production callers omit `deps` and get the
 *  real `globalThis.fetch` / `globalThis.WebSocket`. */
export interface CdpDeps {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
}

const realDeps: CdpDeps = {
  // Direct reference rather than a wrapper, so the function carries
  // Bun's static `fetch.preconnect` property (required by `typeof fetch`
  // since bun-types ≥ 1.3). The wrapper used to be here for "easier
  // mocking" but tests pass a custom `deps` instead of mutating the
  // global, so the wrapper served no purpose.
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
};

/** Run an async operation under a timeout. Resolves to `null` if the
 *  operation throws or times out. */
async function withTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  ms: number,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      trace(`[steam-cdp] ${label}: timeout after ${ms}ms`);
      resolve(null);
    }, ms);
    fn()
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((err) => {
        clearTimeout(timer);
        trace(`[steam-cdp] ${label}: error ${err}`);
        resolve(null);
      });
  });
}

/** Find the QAM target via Steam's CDP HTTP introspection endpoint. */
async function findQamTarget(deps: CdpDeps): Promise<CdpTarget | null> {
  return withTimeout(
    "findQamTarget",
    async () => {
      const res = await deps.fetch(
        `http://localhost:${STEAM_CDP_PORT}/json/list`,
      );
      if (!res.ok) return null;
      const targets = (await res.json()) as CdpTarget[];
      return (
        targets.find(
          (t) => t.type === "page" && t.title === QAM_PAGE_TITLE,
        ) ?? null
      );
    },
    CDP_OP_TIMEOUT_MS,
  );
}

/** Open a single CDP WebSocket session, run the given operations, and
 *  close. The ops are passed an opaque `send` function and a `next` to
 *  await the next reply; the chain ends when ops return. */
async function withCdpSession<T>(
  deps: CdpDeps,
  url: string,
  fn: (
    send: (msg: object) => void,
    nextMessage: () => Promise<unknown>,
  ) => Promise<T>,
): Promise<T | null> {
  return withTimeout(
    "cdpSession",
    () =>
      new Promise<T>((resolve, reject) => {
        const ws = new deps.WebSocket(url);
        let pending: ((m: unknown) => void) | null = null;
        let id = 0;
        const send = (msg: object) => {
          ws.send(JSON.stringify({ id: ++id, ...msg }));
        };
        const nextMessage = () =>
          new Promise<unknown>((res) => {
            pending = res;
          });
        ws.addEventListener("open", async () => {
          try {
            const v = await fn(send, nextMessage);
            ws.close();
            resolve(v);
          } catch (err) {
            ws.close();
            reject(err);
          }
        });
        ws.addEventListener("message", (e: { data: string }) => {
          if (pending) {
            const p = pending;
            pending = null;
            p(JSON.parse(e.data));
          }
        });
        ws.addEventListener("error", (e) => {
          ws.close();
          reject(e);
        });
      }),
    CDP_OP_TIMEOUT_MS,
  );
}

/**
 * If Steam's QAM is currently visible, send Escape into its CEF page
 * via CDP to dismiss it. Returns true if dismissal was sent (the QAM
 * was open and we got a CDP session); false otherwise.
 *
 * Best-effort: a non-existent / unreachable Steam CDP, a timeout on
 * the WebSocket, or a steady-state hidden QAM all return false without
 * error. Callers should not block on this — failure to dismiss falls
 * back to whatever behaviour `show()` would have had anyway.
 */
export async function dismissSteamQuickAccessIfOpen(
  deps: CdpDeps = realDeps,
): Promise<boolean> {
  const target = await findQamTarget(deps);
  if (!target?.webSocketDebuggerUrl) return false;
  const dismissed = await withCdpSession(
    deps,
    target.webSocketDebuggerUrl,
    async (send, next) => {
      // Probe visibility first.
      send({
        method: "Runtime.evaluate",
        params: {
          expression: "!document.hidden",
          returnByValue: true,
        },
      });
      const probe = (await next()) as {
        result?: { result?: { value?: boolean } };
      };
      const visible = probe.result?.result?.value === true;
      if (!visible) return false;

      // Synthesize Escape keyDown + keyUp on the QAM page. Steam's UI
      // listens for Escape on the QAM and treats it as "close menu".
      send({
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyDown",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27,
        },
      });
      await next();
      send({
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyUp",
          key: "Escape",
          code: "Escape",
          windowsVirtualKeyCode: 27,
          nativeVirtualKeyCode: 27,
        },
      });
      await next();
      return true;
    },
  );
  if (dismissed) {
    trace(`[steam-cdp] QAM was open — dispatched Escape via CDP`);
  }
  return dismissed === true;
}
