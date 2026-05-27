/**
 * Lazy-fetch gate keyed on viewport intersection.
 *
 * Returns `[inView, attachRef]`. Attach the ref to the element you
 * want to gate on. As soon as that element first enters the viewport
 * (with a configurable `rootMargin`), `inView` flips to `true` and
 * stays there — the observer disconnects so re-entries don't fire
 * additional renders.
 *
 * Used by HLTB / ProtonDB Badges / theme-loader to defer per-card
 * network fetches until the card is actually near the viewport.
 * Without this, a 2000-game library fans out 2000 simultaneous API
 * requests on mount and trips rate limits.
 *
 *   const [inView, ref] = useIntersectionGate({ rootMargin: "200px" });
 *
 * `rootMargin` defaults to "200px" — starts the fetch just before
 * the card visibly lands on-screen so the data resolves while it's
 * still scrolling into view.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseIntersectionGateOptions {
  /** rootMargin to pass to IntersectionObserver. Default "200px". */
  rootMargin?: string;
  /** Set to true to skip the observer entirely and act as if the
   *  element is already in view. Useful for tests / a debug flag. */
  forceInView?: boolean;
}

export function useIntersectionGate<T extends Element = HTMLElement>(
  opts: UseIntersectionGateOptions = {},
): [boolean, (node: T | null) => void] {
  const { rootMargin = "200px", forceInView = false } = opts;
  const [inView, setInView] = useState(forceInView);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeRef = useRef<T | null>(null);

  // Once we've flipped to in-view we never observe again. Disconnect
  // is also called on unmount in the cleanup below.
  useEffect(() => {
    if (inView || forceInView) return;
    const node = nodeRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [inView, forceInView, rootMargin]);

  const attachRef = useCallback((node: T | null) => {
    nodeRef.current = node;
    // No state nudge here — the effect above already runs after the
    // first mount when nodeRef.current is set. Subsequent
    // re-attachments (rare; the consumer's component would have to
    // re-mount the gated element) reuse the existing observer if
    // we're still pre-viewport.
  }, []);

  return [inView, attachRef];
}
