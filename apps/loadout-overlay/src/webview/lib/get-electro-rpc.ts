// Typed accessor for the Electroview instance stashed on `window` by
// main.tsx. Centralizes the runtime null-check + cast so subscriber call
// sites can drop their `(window as any).__electroview` boilerplate and
// get a narrow type back instead.
//
// Returns `null` outside Electrobun (vite dev, vitest, etc.) so callers
// can early-return without crashing. The `WebviewMessages` schema lives
// in `@loadout/types` so the channel surface is import-free for
// plugins.

import type { WebviewMessages } from "@loadout/types";

/** Narrow surface of `Electroview.rpc` that the webview subscribers
 *  actually use. `request` is a runtime-built record from defineRPC()'s
 *  schema; we type it loosely here because individual call sites narrow
 *  per-method (see `webview/lib/electrobun.ts`). */
export interface ElectroRpc {
  request?: Record<string, (args?: unknown) => Promise<unknown>>;
  addMessageListener<K extends keyof WebviewMessages>(
    name: K,
    handler: (payload: WebviewMessages[K]) => void,
  ): void;
  removeMessageListener?<K extends keyof WebviewMessages>(
    name: K,
    handler: (payload: WebviewMessages[K]) => void,
  ): void;
}

/**
 * Look up the Electroview instance + RPC on `window`. Returns the typed
 * `ElectroRpc` when both are present; `null` otherwise (standalone vite
 * dev, vitest, or before main.tsx has finished bootstrapping). `Window`
 * is augmented in root `types/window-augmentations.d.ts` with a looser
 * shape (payload typed as `unknown`); the cast below narrows it to the
 * `WebviewMessages`-keyed surface this helper exposes. Centralising the
 * cast here means subscriber call sites stay assertion-free.
 */
export function getElectroRpc(): ElectroRpc | null {
  const rpc = window.__electroview?.rpc;
  if (!rpc || typeof rpc.addMessageListener !== "function") return null;
  return rpc as unknown as ElectroRpc;
}
