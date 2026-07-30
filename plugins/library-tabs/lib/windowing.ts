/**
 * Which rows of a tile grid are worth mounting. [iso]
 *
 * Evaluation was never the bottleneck — filtering 4356 games against eight
 * rules is under 25 ms. **Rendering is.** Every `GameCard` is a DOM subtree
 * with an image, and mounting four thousand of them stalls CEF on a handheld
 * long before the user has scrolled to the second row.
 *
 * The arithmetic lives here, apart from the measuring, because it is the part
 * that can be wrong in interesting ways: an off-by-one at the top of the range
 * blanks the row you are looking at, and a wrong padding makes the scrollbar
 * jump under your thumb. Pure and total, so it can be tested exhaustively.
 */

export interface WindowInput {
  /** How many tiles the tab matched. */
  total: number;
  /** Tiles per row, from the grid's resolved `gridTemplateColumns`. */
  columns: number;
  /** Row pitch in px — tile height plus the grid's row gap. */
  rowHeight: number;
  /** Scroll offset of the container the grid lives in. */
  scrollTop: number;
  /** Visible height of that container. */
  viewportHeight: number;
  /** Distance from the top of the scroll content to the top of the grid. */
  gridTop: number;
  /**
   * Rows to keep mounted beyond the viewport, each side. Two is enough to
   * cover a fast flick without the next row popping in visibly, and cheap: at
   * five columns that is ten extra tiles, not four thousand.
   */
  overscanRows?: number;
}

export interface WindowResult {
  /** First tile index to render. */
  start: number;
  /** One past the last tile index to render. */
  end: number;
  /** Spacer above the grid, standing in for the rows that aren't mounted. */
  padTop: number;
  /** Spacer below, so the scrollbar reflects the whole list. */
  padBottom: number;
  /** Total rows the list would occupy. */
  rows: number;
}

const DEFAULT_OVERSCAN = 2;

/**
 * Everything, unwindowed. Used before the grid has been measured — rendering
 * the real thing once is what makes a measurement possible at all, and it is
 * also the honest fallback if measuring ever fails.
 */
export function noWindow(total: number): WindowResult {
  return { start: 0, end: total, padTop: 0, padBottom: 0, rows: 1 };
}

export function computeWindow(input: WindowInput): WindowResult {
  const {
    total,
    columns,
    rowHeight,
    scrollTop,
    viewportHeight,
    gridTop,
    overscanRows = DEFAULT_OVERSCAN,
  } = input;

  // Any of these being nonsense means we have not measured properly yet.
  // Mounting everything is slow; mounting nothing is broken, so prefer slow.
  if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, rows: 0 };
  if (columns < 1 || rowHeight <= 0 || viewportHeight <= 0) return noWindow(total);

  const rows = Math.ceil(total / columns);

  // How far the grid itself has scrolled past the top of the viewport. Negative
  // while the grid is still below the fold, which clamps to row 0.
  const scrolledIntoGrid = scrollTop - gridTop;

  const firstVisibleRow = Math.floor(scrolledIntoGrid / rowHeight);
  const rowsInViewport = Math.ceil(viewportHeight / rowHeight);

  const firstRow = Math.max(0, Math.min(rows, firstVisibleRow - overscanRows));
  // `+ 1` because a viewport that spans a fraction of a row still shows part of
  // the next one; without it the bottom row blanks as it slides into view.
  const lastRow = Math.max(
    firstRow,
    Math.min(rows, firstVisibleRow + rowsInViewport + overscanRows + 1),
  );

  // A measurement that is momentarily stale can put the viewport far above the
  // grid, which collapses the range to nothing and blanks the page. Rendering
  // one row too many is invisible; rendering none is a bug the user sees.
  const hasContentBelow = firstRow * columns < total;
  const safeLastRow = hasContentBelow ? Math.max(lastRow, firstRow + 1) : lastRow;

  return {
    // Clamped to `total`, not just to `rows * columns`: the last row is usually
    // partial, so `firstRow * columns` can land past the final tile when the
    // container is scrolled beyond the end. Unclamped it yields start > end,
    // which is incoherent even though the slice happens to come back empty.
    start: Math.min(firstRow * columns, total),
    end: Math.min(total, safeLastRow * columns),
    padTop: firstRow * rowHeight,
    padBottom: Math.max(0, (rows - safeLastRow) * rowHeight),
    rows,
  };
}

/**
 * Columns actually resolved by the browser, read back from the grid rather
 * than recomputed from `minTileWidth`.
 *
 * `GameCardGrid` uses `repeat(auto-fill, minmax(N, 1fr))`, so the count
 * depends on the container width, the gap and the overlay's zoom. Duplicating
 * that calculation would drift from whatever CSS actually did; the resolved
 * value is a list of pixel tracks, and its length is the answer.
 */
export function columnsFromTemplate(gridTemplateColumns: string): number {
  const tracks = gridTemplateColumns.trim().split(/\s+/).filter(Boolean);
  // `none` (display:grid not applied yet) or an empty string means unmeasured.
  if (tracks.length === 0 || gridTemplateColumns.trim() === "none") return 0;
  return tracks.length;
}
