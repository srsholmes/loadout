/**
 * One collection on the grid.
 *
 * Not `GameCard`: that component's `aspect-[2/3]` and single `<img>` are
 * hard-coded, and a collection wants a 2×2 mosaic of the capsules inside it.
 * Modelled instead on `RulePalette`'s candidate card — a focusable button with
 * a title, a right-aligned count and a description line — which is the closest
 * prior art in this plugin.
 *
 * The card states which kind it is, because the two behave differently and the
 * difference is invisible once you are inside. A managed collection updates
 * itself: play a game for half an hour and it can leave a "barely started"
 * collection on the next sync. That is correct, and it is only jarring when it
 * happens silently — so the card says so before you ever open it.
 *
 * Registers focus via `useFocusable`. A raw `<button>` is invisible to the
 * D-pad, which is how the rule builder once shipped unusable on a handheld.
 */

import { useFocusable } from "@loadout/ui";
import type { CSSProperties } from "react";

export interface CollectionCardProps {
  label: string;
  count: number;
  /** Up to four appIds, rendered as a capsule mosaic. */
  previewAppIds: string[];
  kind: "managed" | "linked";
  /** Rules (managed) or a Steam filter (linked+dynamic) maintain the contents. */
  autoMaintained: boolean;
  onOpen: () => void;
}

/** Steam's capsule art for one app, served by the loader's grid route. */
function capsuleUrl(appId: string): string {
  return `http://localhost:33820/api/steam-grid/${appId}/capsule`;
}

const TILE: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

export function CollectionCard({
  label,
  count,
  previewAppIds,
  kind,
  autoMaintained,
  onOpen,
}: CollectionCardProps) {
  const { ref, focused } = useFocusable({ onEnterPress: onOpen });

  // Four slots always, so a collection with one game doesn't render a lone
  // capsule stretched across the whole card.
  const slots = [0, 1, 2, 3].map((i) => previewAppIds[i]);

  return (
    <button
      ref={ref as React.RefObject<HTMLButtonElement>}
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-2 rounded-xl border border-base-300 bg-base-200 p-2 text-left"
      style={{
        ...(focused ? { animation: "focusPulse 2s ease-in-out infinite" } : {}),
        // Inline: the shell's stylesheet is a separate release artifact, so a
        // utility only this plugin uses may simply not exist.
        outline: focused ? "2px solid var(--color-primary)" : "none",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gridTemplateRows: "1fr 1fr",
          gap: 2,
          aspectRatio: "1 / 1",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg-inset, rgba(0,0,0,0.25))",
        }}
      >
        {slots.map((appId, i) =>
          appId ? (
            <img
              key={`${appId}-${i}`}
              src={capsuleUrl(appId)}
              alt=""
              style={TILE}
              // A missing capsule is routine — shortcuts and ROMs often have
              // none. Hide the broken image rather than showing its icon.
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
              }}
            />
          ) : (
            <div key={`empty-${i}`} style={{ ...TILE, background: "rgba(255,255,255,0.04)" }} />
          ),
        )}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold truncate">{label}</span>
        <span className="text-xs text-base-content/60 shrink-0">{count}</span>
      </div>

      <span className="text-[11px] text-base-content/50 truncate">
        {kind === "managed"
          ? "Rules · updates itself"
          : autoMaintained
            ? "In Steam · Steam maintains it"
            : "In Steam"}
      </span>
    </button>
  );
}
