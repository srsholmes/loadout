import type { CSSProperties, ReactNode } from "react";

/**
 * Responsive, flowing grid for portrait {@link GameCard} tiles — the
 * shared container behind every picker/library view (SGDB, store-bridge,
 * recomp, LSFG-VK, ProtonDB, HLTB, playtime, launch-options, TDP).
 *
 * It replaces the old hand-rolled `grid grid-cols-4
 * sidebar-collapsed:grid-cols-6` divs that were copy-pasted across nine
 * plugins. Instead of pinning explicit column counts to the sidebar
 * state, it lets the grid *flow*: `repeat(auto-fill, minmax(min, 1fr))`
 * packs as many `>= minTileWidth` columns as the container can hold and
 * stretches them to share the leftover space. Collapse the sidebar or
 * drag the overlay onto a 1920 display and more columns simply appear —
 * no breakpoints, no per-plugin tuning.
 *
 * `auto-fill` (not `auto-fit`) is deliberate: with a sparse grid the
 * empty trailing tracks are preserved, so three games stay tile-sized
 * and left-aligned rather than ballooning to fill the row.
 *
 * To actually use that width on big screens the list view should drop
 * the centered 860px reading column — wrap it in `.page-content.full`
 * (see overlay/src/index.css) rather than plain `.page-content`.
 */
export interface GameCardGridProps {
  children: ReactNode;
  /**
   * Minimum tile width in px. The grid fits as many `>= minTileWidth`
   * columns as the container allows, then stretches them (1fr) to fill
   * the row. Smaller → denser. Default 150 (~5 tiles at the standard
   * sidebar-open width, many more when collapsed / on external displays).
   */
  minTileWidth?: number;
  /** Extra classes merged onto the grid (e.g. margin tweaks). */
  className?: string;
  style?: CSSProperties;
}

export function GameCardGrid({
  children,
  minTileWidth = 150,
  className,
  style,
}: GameCardGridProps) {
  return (
    <div
      className={["grid gap-2.5", className].filter(Boolean).join(" ")}
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(${minTileWidth}px, 1fr))`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
