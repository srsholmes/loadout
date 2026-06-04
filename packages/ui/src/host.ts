// Overlay host bridge for plugins. The Electrobun webview host installs
// its RPC requester at globalThis.__electroview.rpc.request.* — the same
// global the overlay's own @overlay/lib/host shim uses. Plugins run in
// that webview document, so this reaches the host at runtime. Outside the
// overlay (standalone dev, unit tests) it is a safe no-op.

declare global {
  // eslint-disable-next-line no-var
  var __electroview:
    | {
        rpc?: {
          request?: Record<string, (args?: unknown) => Promise<unknown>>;
        };
      }
    | undefined;
}

/** Ask the Electrobun overlay host to hide the overlay window. Resolves
 *  immediately (no-op) when there is no host transport. */
export async function hideOverlay(): Promise<void> {
  const hide = globalThis.__electroview?.rpc?.request?.hide;
  if (typeof hide === "function") await hide();
}
