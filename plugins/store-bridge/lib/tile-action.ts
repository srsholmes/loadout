/**
 * Pure tile-action selector — given a game's current status + whether
 * an install is in flight, return the action the tile's primary
 * button represents. No I/O, no React, no `this` — extracted from
 * `app.tsx` so a regression in the branching can be caught locally.
 *
 * The action's `variant` drives button styling; `kind` is the
 * discriminant the click handler switches on. Adding a fifth state
 * (e.g. "Updating…") happens here, not in `app.tsx`.
 */

export type TileAction =
  | { kind: "install"; label: string; variant: "primary"; disabled?: boolean }
  | { kind: "cancel"; label: string; variant: "danger"; disabled?: boolean }
  | { kind: "launch"; label: string; variant: "primary"; disabled?: boolean }
  | { kind: "add-to-steam"; label: string; variant: "secondary"; disabled?: boolean };

/** Minimal shape `pickTileAction` reads — kept loose so callers can
 *  pass the full GameInfo without recasting. */
export interface TileActionInput {
  status: "library" | "installed" | "imported";
  installed?: { addedToSteam: boolean };
}

export function pickTileAction(
  g: TileActionInput,
  isInstalling: boolean,
): TileAction {
  if (isInstalling) {
    // During install the tile's primary button becomes Cancel —
    // the install state is already visible in the progress strip
    // above, so the button doubles as the abort affordance rather
    // than a disabled "Installing…" placeholder.
    return { kind: "cancel", label: "Cancel", variant: "danger" };
  }
  if (g.status === "library") {
    return { kind: "install", label: "Install", variant: "primary" };
  }
  // Installed or imported — needs to land in Steam before launch
  // works via `steam://rungameid/`.
  if (g.installed?.addedToSteam) {
    return { kind: "launch", label: "Play", variant: "primary" };
  }
  return { kind: "add-to-steam", label: "Add to Steam", variant: "secondary" };
}
