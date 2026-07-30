/**
 * Measures a tile grid and reports which slice of it to mount.
 *
 * The arithmetic is in `lib/windowing.ts`; this is the part that touches the
 * DOM — reading the resolved column count, the row pitch, and the scroll
 * position, and re-reading them when the container resizes or the overlay's
 * zoom changes.
 *
 * It deliberately renders everything on the first pass. There is no way to
 * measure a tile that has not been laid out, and guessing the height from
 * `minTileWidth` and an assumed aspect ratio would be wrong the moment the
 * card's label wraps to two lines.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { columnsFromTemplate, computeWindow, noWindow } from "../lib/windowing";
import type { WindowResult } from "../lib/windowing";

export interface UseVisibleRowsArgs {
  total: number;
  /** Wraps the grid; its first element child is the grid itself. */
  gridWrapperRef: RefObject<HTMLElement | null>;
  /**
   * Wraps the whole list — top spacer, grid and bottom spacer.
   *
   * Measuring the grid's own offset instead is a feedback loop: the grid sits
   * below `padTop`, so its offset grows as you scroll, which pushes the
   * computed row further down, which grows `padTop` again. At one scroll
   * position it collapsed the window to zero tiles and the page went blank.
   * The list container's top never moves.
   */
  listRef: RefObject<HTMLElement | null>;
  /** The scrolling ancestor — the plugin page. */
  scrollRef: RefObject<HTMLElement | null>;
  overscanRows?: number;
}

interface Measurement {
  columns: number;
  rowHeight: number;
  gridTop: number;
}

export function useVisibleRows({
  total,
  gridWrapperRef,
  listRef,
  scrollRef,
  overscanRows,
}: UseVisibleRowsArgs): WindowResult {
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  /** Set while a rAF is already queued, so a scroll burst does one read. */
  const pending = useRef(false);

  const measure = useCallback(() => {
    const wrapper = gridWrapperRef.current;
    const scroller = scrollRef.current;
    const grid = wrapper?.firstElementChild as HTMLElement | null | undefined;
    const firstTile = grid?.firstElementChild as HTMLElement | null | undefined;
    if (!wrapper || !scroller || !grid || !firstTile) return;

    const columns = columnsFromTemplate(getComputedStyle(grid).gridTemplateColumns);
    if (columns < 1) return;

    // Row pitch is the tile plus the gap between rows, which the grid owns.
    //
    // `offsetHeight`, not `getBoundingClientRect().height`: the overlay shell
    // wraps plugins in a `zoom: 1.6` subtree, where rects come back scaled by
    // the zoom while `clientHeight` and `scrollTop` stay in layout pixels.
    // Mixing the two made every row measure 1.6x too tall.
    const rowGap = Number.parseFloat(getComputedStyle(grid).rowGap) || 0;
    const rowHeight = firstTile.offsetHeight + rowGap;
    if (rowHeight <= 0) return;

    // Where the grid starts within the scrolled content — tab strip, summary
    // line and any diagnostics included. Summed through the offsetParent chain
    // so it stays in the same layout pixels as `scrollTop`.
    const list = listRef.current;
    if (!list) return;
    let gridTop = 0;
    for (
      let node: HTMLElement | null = list;
      node && node !== scroller;
      node = node.offsetParent as HTMLElement | null
    ) {
      gridTop += node.offsetTop;
    }

    setMeasurement((prev) =>
      prev &&
      prev.columns === columns &&
      Math.abs(prev.rowHeight - rowHeight) < 1 &&
      Math.abs(prev.gridTop - gridTop) < 1
        ? prev
        : { columns, rowHeight, gridTop },
    );
    setScroll({ top: scroller.scrollTop, height: scroller.clientHeight });
  }, [gridWrapperRef, listRef, scrollRef]);

  // Layout effect: measure before paint, so the first windowed render replaces
  // the full one without a visible flash of four thousand tiles.
  useLayoutEffect(() => {
    measure();
  }, [measure, total]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const onScroll = () => {
      if (pending.current) return;
      pending.current = true;
      requestAnimationFrame(() => {
        pending.current = false;
        setScroll({ top: scroller.scrollTop, height: scroller.clientHeight });
      });
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });

    // Re-measure on resize: collapsing the sidebar or moving the overlay to an
    // external display changes the column count, and a stale count would put
    // the padding out by whole rows.
    const observer = new ResizeObserver(() => measure());
    observer.observe(scroller);
    const wrapper = gridWrapperRef.current;
    if (wrapper) observer.observe(wrapper);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
    // `total` is in the deps for a reason that is easy to miss: the page
    // renders a spinner before the library lands, so on the first pass
    // `scrollRef.current` is null and this effect bails. Refs are not reactive,
    // so with only stable deps it would never run again and the strip would
    // never scroll-window at all. `total` going 0 -> N is the signal that the
    // real container has mounted.
  }, [measure, scrollRef, gridWrapperRef, total]);

  if (!measurement) return noWindow(total);

  return computeWindow({
    total,
    columns: measurement.columns,
    rowHeight: measurement.rowHeight,
    gridTop: measurement.gridTop,
    scrollTop: scroll.top,
    viewportHeight: scroll.height,
    ...(overscanRows === undefined ? {} : { overscanRows }),
  });
}
