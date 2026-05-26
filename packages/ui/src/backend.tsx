import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ensureConnected, onConnect, call as wsCall, subscribe } from "./ws-client";
import { FocusContext } from "./spatial-nav";

interface BackendContextValue {
  ready: boolean;
}

const BackendContext = createContext<BackendContextValue>({ ready: false });

export function BackendProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureConnected();
    const off = onConnect(() => setReady(true));
    return off;
  }, []);

  const value = useMemo(() => ({ ready }), [ready]);
  return <BackendContext.Provider value={value}>{children}</BackendContext.Provider>;
}

/**
 * Wraps a plugin's tree with the backend connection + its slot in the
 * shell's focus tree. Called by PluginHost.
 */
export function PluginProvider({
  children,
  parentFocusKey,
}: {
  children: ReactNode;
  parentFocusKey?: string;
}) {
  return (
    <BackendProvider>
      <FocusContext.Provider value={parentFocusKey ?? "content"}>{children}</FocusContext.Provider>
    </BackendProvider>
  );
}

export interface BackendApi {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  useEvent(args: { event: string; handler: (data: unknown) => void }): void;
  ready: boolean;
}

export function useBackend(pluginId: string): BackendApi {
  const ctx = useContext(BackendContext);

  const call = useCallback(
    (method: string, ...args: unknown[]): Promise<unknown> =>
      wsCall({ plugin: pluginId, method, args }),
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

  return useMemo(
    () => ({ call, useEvent, ready: ctx.ready }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [call, ctx.ready],
  );
}
