import { describe, expect, it } from "bun:test";
import { columnsFromTemplate, computeWindow, noWindow } from "./windowing";
import type { WindowInput } from "./windowing";

/** 5 columns, 200px rows, an 800px viewport, grid starting 100px down. */
function input(overrides: Partial<WindowInput> = {}): WindowInput {
  return {
    total: 4356,
    columns: 5,
    rowHeight: 200,
    scrollTop: 0,
    viewportHeight: 800,
    gridTop: 100,
    ...overrides,
  };
}

describe("computeWindow — the visible slice", () => {
  it("mounts a small multiple of the viewport, not the whole library", () => {
    const w = computeWindow(input());
    // 4 rows visible + 2 overscan + 1 partial ≈ 7 rows × 5 columns.
    expect(w.end - w.start).toBeLessThan(60);
    expect(w.rows).toBe(Math.ceil(4356 / 5));
  });

  it("starts at the top before the grid has been scrolled into", () => {
    const w = computeWindow(input({ scrollTop: 0 }));
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });

  it("stays at row 0 while the grid is still below the fold", () => {
    // Scrolled 50px, but the grid starts at 100px — nothing of it is above the
    // viewport top yet, and a negative row index would blank the first rows.
    const w = computeWindow(input({ scrollTop: 50 }));
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });

  it("advances by whole rows as it scrolls", () => {
    // 900px scrolled - 100px grid top = 800px = row 4. Minus 2 overscan = row 2.
    const w = computeWindow(input({ scrollTop: 900 }));
    expect(w.start).toBe(2 * 5);
    expect(w.padTop).toBe(2 * 200);
  });

  it("keeps padTop + rendered rows + padBottom equal to the full height", () => {
    // If this drifts the scrollbar jumps under the user's thumb.
    for (const scrollTop of [0, 500, 5000, 100_000, 900_000]) {
      const w = computeWindow(input({ scrollTop }));
      const renderedRows = Math.ceil((w.end - w.start) / 5);
      const accounted = w.padTop + renderedRows * 200 + w.padBottom;
      expect(accounted).toBe(w.rows * 200);
    }
  });

  it("covers a viewport that is not a whole number of rows", () => {
    // The fixture above is row-aligned (800 / 200 = exactly 4), so the partial
    // row the `+ 1` in `computeWindow` exists for is never exercised by it —
    // dropping that `+ 1` passed all sixteen other tests while blanking the
    // bottom row as it slid into view, which is the exact symptom the module
    // docstring names.
    // `overscanRows: 0` on purpose. With the default 2 the spare rows cover
    // the partial one regardless, so the `+ 1` is invisible — which is why
    // dropping it passed the whole suite.
    const ragged = { rowHeight: 180, viewportHeight: 500, gridTop: 0, overscanRows: 0 };
    for (let scrollTop = 0; scrollTop < 20_000; scrollTop += 37) {
      const w = computeWindow(input({ ...ragged, scrollTop }));
      const viewBottom = scrollTop + ragged.viewportHeight;
      const mountedBottom =
        w.padTop + Math.ceil((w.end - w.start) / 5) * ragged.rowHeight;
      if (scrollTop >= w.rows * ragged.rowHeight) continue;
      expect(w.padTop, `top gap at ${scrollTop}`).toBeLessThanOrEqual(scrollTop);
      expect(mountedBottom, `bottom gap at ${scrollTop}`).toBeGreaterThanOrEqual(
        Math.min(viewBottom, w.rows * ragged.rowHeight),
      );
    }
  });

  it("covers the viewport at every scroll position", () => {
    // The real regression risk: a window that renders rows the user cannot see
    // while blanking the one they can.
    for (let scrollTop = 0; scrollTop < 200_000; scrollTop += 137) {
      const w = computeWindow(input({ scrollTop }));
      const viewTop = scrollTop - 100;
      const viewBottom = viewTop + 800;
      const mountedTop = w.padTop;
      const mountedBottom = w.padTop + Math.ceil((w.end - w.start) / 5) * 200;
      if (viewTop >= w.rows * 200) continue; // scrolled past the end
      expect(mountedTop, `top gap at ${scrollTop}`).toBeLessThanOrEqual(Math.max(0, viewTop));
      expect(mountedBottom, `bottom gap at ${scrollTop}`).toBeGreaterThanOrEqual(
        Math.min(viewBottom, w.rows * 200),
      );
    }
  });

  it("clamps at the end rather than running past the last tile", () => {
    const w = computeWindow(input({ scrollTop: 10_000_000 }));
    expect(w.end).toBe(4356);
    expect(w.padBottom).toBe(0);
    expect(w.start).toBeLessThanOrEqual(w.end);
  });

  it("renders the exact tail when the last row is partial", () => {
    // 4356 / 5 leaves one final row of a single tile.
    const w = computeWindow(input({ total: 4356, scrollTop: 10_000_000 }));
    expect(w.end).toBe(4356);
    expect(4356 % 5).toBe(1);
  });

  it("honours a custom overscan", () => {
    const tight = computeWindow(input({ scrollTop: 2100, overscanRows: 0 }));
    const loose = computeWindow(input({ scrollTop: 2100, overscanRows: 5 }));
    expect(loose.start).toBeLessThan(tight.start);
    expect(loose.end - loose.start).toBeGreaterThan(tight.end - tight.start);
  });
});

describe("computeWindow — degenerate inputs", () => {
  it("renders nothing for an empty list", () => {
    const w = computeWindow(input({ total: 0 }));
    expect(w).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, rows: 0 });
  });

  it("falls back to rendering everything when unmeasured", () => {
    // Slow beats broken: a bad measurement must not blank the grid.
    for (const bad of [{ columns: 0 }, { rowHeight: 0 }, { viewportHeight: 0 }]) {
      const w = computeWindow(input(bad));
      expect(w.start).toBe(0);
      expect(w.end).toBe(4356);
    }
  });

  it("handles a single column", () => {
    const w = computeWindow(input({ columns: 1, scrollTop: 2100 }));
    expect(w.rows).toBe(4356);
    expect(w.end).toBeGreaterThan(w.start);
  });

  it("handles a list shorter than one screen", () => {
    const w = computeWindow(input({ total: 3 }));
    expect(w.start).toBe(0);
    expect(w.end).toBe(3);
    expect(w.padBottom).toBe(0);
  });
});

describe("columnsFromTemplate", () => {
  it("counts the resolved tracks", () => {
    expect(columnsFromTemplate("150px 150px 150px")).toBe(3);
    expect(columnsFromTemplate("  188.5px 188.5px  ")).toBe(2);
  });

  it("reports unmeasured rather than guessing", () => {
    // Reading the resolved value is the point: recomputing it from
    // minTileWidth would drift from whatever the browser actually did with
    // auto-fill, the gap and the overlay's zoom.
    expect(columnsFromTemplate("none")).toBe(0);
    expect(columnsFromTemplate("")).toBe(0);
  });
});

describe("noWindow", () => {
  it("spans the whole list with no padding", () => {
    expect(noWindow(12)).toEqual({ start: 0, end: 12, padTop: 0, padBottom: 0, rows: 1 });
  });
});
