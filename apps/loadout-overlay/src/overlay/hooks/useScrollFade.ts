import { useEffect, type RefObject } from "react";

/**
 * Adds `data-scroll-fade` attribute to a scrollable element
 * to control which edge gradients are visible.
 *
 * Values: "top" | "bottom" | "both" | removed (no fade needed).
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function update() {
      if (!el) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      const atTop = scrollTop < 2;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 2;
      const canScroll = scrollHeight > clientHeight + 2;

      if (!canScroll) {
        el.removeAttribute("data-scroll-fade");
      } else if (atTop) {
        el.setAttribute("data-scroll-fade", "bottom");
      } else if (atBottom) {
        el.setAttribute("data-scroll-fade", "top");
      } else {
        el.setAttribute("data-scroll-fade", "both");
      }
    }

    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);

    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ref]);
}
