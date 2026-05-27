/**
 * Cross-root toast bridge.
 *
 * Each plugin bundles its own React + its own copy of every SDK
 * import, so a `react-hot-toast` singleton imported inside a plugin
 * can't reach a `<Toaster />` mounted in the shell — they're two
 * different module instances with two different stores. The shell
 * owns the toaster; plugins just dispatch a `CustomEvent` that the
 * shell forwards to its singleton. Same trick the spatial-nav
 * registry uses for cross-root D-pad nav.
 */

export type ToastKind = "success" | "error" | "loading";

export interface NotifyOptions {
  /** Visual variant. Defaults to "success". */
  kind?: ToastKind;
  /** Auto-dismiss after this many ms. Omit for the library default. */
  duration?: number;
  /**
   * Stable id — passing the same id twice replaces the existing toast
   * in place (useful for "loading → success" flows).
   */
  id?: string;
}

export interface ToastEventDetail {
  message: string;
  kind: ToastKind;
  duration?: number;
  id?: string;
}

export const TOAST_EVENT = "sl:toast" as const;

export function notify(message: string, opts: NotifyOptions = {}): void {
  if (typeof window === "undefined") return;
  const detail: ToastEventDetail = {
    message,
    kind: opts.kind ?? "success",
    duration: opts.duration,
    id: opts.id,
  };
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail }));
}
