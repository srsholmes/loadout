import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { FocusContext } from "./spatial-nav";
import { ensureConnected, call as wsCall, subscribe } from "./ws-client";
import { PluginHeaderSlotProvider } from "./components/PluginHeader";

interface SteamLoaderContextValue {
  ready: boolean;
}

export const SteamLoaderContext = createContext<SteamLoaderContextValue>({ ready: false });

export function SteamLoaderProvider({ children }: { children: ReactNode }) {
  const readyRef = useRef(false);

  useEffect(() => {
    ensureConnected();
    readyRef.current = true;
  }, []);

  const value = useMemo(() => ({ ready: true }), []);

  return (
    <SteamLoaderContext.Provider value={value}>
      {children}
    </SteamLoaderContext.Provider>
  );
}

/**
 * Combined provider for plugin frontends.
 * Sets up the WebSocket connection AND connects the plugin's focusable
 * elements into the shell's spatial-navigation tree.
 *
 * parentFocusKey is provided by the shell (PluginHost) and tells the
 * plugin's FocusContext which zone its focusable elements belong to.
 * This uses the LOCAL FocusContext (from spatial-nav.ts, created with
 * the plugin's own React.createContext) — no cross-root hook issues.
 *
 * `headerSlot` is the overlay topbar's DOM element. Plugins can
 * project content into it via `<PluginHeader>` from any depth in
 * their tree (state, callbacks, colocation all stay inside one
 * React root). The shell passes it via `mount(container, opts)`.
 */
export function PluginProvider({
  children,
  parentFocusKey,
  headerSlot,
}: {
  children: ReactNode;
  parentFocusKey?: string;
  headerSlot?: HTMLElement | null;
}) {
  return (
    <SteamLoaderProvider>
      <FocusContext.Provider value={parentFocusKey ?? "content"}>
        <PluginHeaderSlotProvider slot={headerSlot ?? null}>
          {children}
        </PluginHeaderSlotProvider>
      </FocusContext.Provider>
    </SteamLoaderProvider>
  );
}

export function useBackend(pluginId: string) {
  const ctx = useContext(SteamLoaderContext);

  const call = useCallback(
    (method: string, ...args: unknown[]): Promise<unknown> => {
      return wsCall({ plugin: pluginId, method, args });
    },
    [pluginId],
  );

  const useEvent = ({ event, handler }: { event: string; handler: (data: unknown) => void }) => {
    const handlerRef = useRef(handler);
    handlerRef.current = handler;

    useEffect(() => {
      return subscribe({
        plugin: pluginId,
        event,
        handler: (data) => handlerRef.current(data),
      });
    }, [event]);
  };

  // CRITICAL: memoize the returned object so callers can put the
  // whole result in a useEffect dep array without triggering a new
  // effect run on every parent render. Several picker plugins do
  // `const gameBrowser = useBackend("game-browser"); useEffect(...,
  // [gameBrowser])` — without this memo, every parent render
  // re-fetched the library.
  return useMemo(
    () => ({ call, useEvent, ready: ctx.ready }),
    // `useEvent` is a stable function reference per-render here, but
    // it closes over `pluginId` and `handlerRef.current` so we only
    // need it to change when `pluginId` changes. The function itself
    // is recreated every render, so we omit it from the dep list and
    // rely on `call` (which is `useCallback`-memoized on pluginId)
    // as the proxy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [call, ctx.ready],
  );
}

// ---------------------------------------------------------------------------
// Core service: game-detection
// ---------------------------------------------------------------------------

export const GAME_DETECTION_SERVICE_ID = "__core:game-detection";

export interface CurrentGame {
  appId: number;
  gameName: string;
  startTime: number;
}

export interface GameSessionRecord extends CurrentGame {
  endTime?: number;
}

interface GameChangedPayload {
  currentGame: CurrentGame | null;
  recentSessions: GameSessionRecord[];
}

/**
 * Subscribe to the loader's currently-running Steam game. Returns `null`
 * when no game is active. Updates live as games launch or exit.
 *
 * Backed by the `__core:game-detection` service, which receives launch
 * and exit notifications from the in-Steam injector via the existing
 * `__broadcast` RPC fan-out. Plugins should prefer this hook over
 * implementing `handleGameLaunch` / `handleGameExit` magic methods.
 */
export function useCurrentGame(): CurrentGame | null {
  const { call, useEvent, ready } = useBackend(GAME_DETECTION_SERVICE_ID);
  const [current, setCurrent] = useState<CurrentGame | null>(null);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    call("getCurrentGame")
      .then((g) => {
        if (alive) setCurrent((g as CurrentGame | null) ?? null);
      })
      .catch(() => {
        // Service unavailable (offline, not registered) — keep current null.
      });
    return () => {
      alive = false;
    };
  }, [ready, call]);

  useEvent({
    event: "gameChanged",
    handler: (data) => {
      const payload = data as GameChangedPayload;
      setCurrent(payload.currentGame ?? null);
    },
  });

  return current;
}
