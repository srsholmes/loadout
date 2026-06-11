// Programmatic Steam menu dismissal via Chrome DevTools Protocol.
//
// Why this exists: when the user has one of Steam's BPM menus open —
// the Quick Access Menu (QAM, the "…" side panel) or the main menu
// (the Steam-button menu) — with a game alive in baselayer, opening our
// overlay reliably wedges gamescope's compositor → device-wide input
// freeze. Neither menu is a separate X window — each is a CEF
// browser_view popup INSIDE Steam BPM's X window (page titles
// "QuickAccess_uid2" / "MainMenu_uid2" in Steam's CDP target list). We
// can't manipulate them via X11 atoms because there's nothing on the X
// tree to manipulate. But Steam's CEF instance exposes CDP on
// localhost:8080, and dispatching Input.dispatchKeyEvent(Escape) into
// the open menu's page reliably closes it (verified empirically).
//
// We only call into this from gamescope-atoms.ts during show() when
// we detect the trigger scenario. Failure / timeout / Steam not having
// CDP open is silently ignored — it's a best-effort cleanup.

import { trace } from "./trace";

/** Steam's CEF DevTools port. Hard-coded by Steam. */
const STEAM_CDP_PORT = 8080;

/** Page titles Steam gives its BPM menu browser_views. Both wedge
 *  gamescope the same way when our overlay opens over them, and both
 *  dismiss via the same CDP Escape. Stable since Big Picture Mode
 *  launched (each popup gets a `_uid2` suffix on a stable name). */
const STEAM_MENU_PAGE_TITLES = [
  "QuickAccess_uid2",
  "MainMenu_uid2",
] as const;

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

/** Enumerate Steam's CDP page targets via its HTTP introspection
 *  endpoint. Returns [] on any failure / timeout so callers can treat
 *  "Steam CDP unreachable" identically to "no menus open". */
async function listCdpTargets(deps: CdpDeps): Promise<CdpTarget[]> {
  const targets = await withTimeout(
    "listCdpTargets",
    async () => {
      const res = await deps.fetch(
        `http://localhost:${STEAM_CDP_PORT}/json/list`,
      );
      if (!res.ok) return null;
      return (await res.json()) as CdpTarget[];
    },
    CDP_OP_TIMEOUT_MS,
  );
  return targets ?? [];
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
 * If the given Steam menu CEF page is currently visible, send Escape
 * into it via CDP to dismiss it. Returns true if dismissal was sent
 * (the page was open and we got a CDP session); false otherwise.
 */
async function dismissTargetIfVisible(
  deps: CdpDeps,
  target: CdpTarget,
): Promise<boolean> {
  if (!target.webSocketDebuggerUrl) return false;
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

      // Synthesize Escape keyDown + keyUp on the menu page. Steam's UI
      // listens for Escape on its menus and treats it as "close menu".
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
  return dismissed === true;
}

/**
 * If any of Steam's BPM menus (QAM or main menu) is currently visible,
 * send Escape into its CEF page via CDP to dismiss it. Returns true if
 * at least one menu was dismissed; false otherwise.
 *
 * One CDP target-list fetch, then a per-menu visibility probe — only
 * the menu(s) actually open get an Escape. A hidden menu is a no-op.
 *
 * Best-effort: a non-existent / unreachable Steam CDP, a timeout on
 * the WebSocket, or steady-state hidden menus all return false without
 * error. Callers should not block on this — failure to dismiss falls
 * back to whatever behaviour `show()` would have had anyway.
 */
export async function dismissSteamMenusIfOpen(
  deps: CdpDeps = realDeps,
): Promise<boolean> {
  const targets = await listCdpTargets(deps);
  let dismissedAny = false;
  for (const title of STEAM_MENU_PAGE_TITLES) {
    const target = targets.find(
      (t) => t.type === "page" && t.title === title,
    );
    if (!target) continue;
    if (await dismissTargetIfVisible(deps, target)) {
      dismissedAny = true;
      trace(`[steam-cdp] ${title} was open — dispatched Escape via CDP`);
    }
  }
  return dismissedAny;
}
