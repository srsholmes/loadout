import {
  useEffect,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { useFocusable } from "../spatial-nav";
import { Badge, type BadgeVariant } from "./Badge";
import { friendlyCollectionName } from "../collection-aliases";

/**
 * Portrait-tile game card shared across the picker UIs (SGDB,
 * ProtonDB Badges, HLTB, LSFG-VK). Structure mirrors ProtonDB /
 * HLTB's existing tile layout:
 *
 *   ┌──────────────────────┐
 *   │ [topLeftBadge]   [topRightBadge]   │
 *   │                                    │
 *   │             image (2:3)            │
 *   │                                    │
 *   │ [collection badges, bottom row]    │
 *   ├────────────────────────────────────┤
 *   │  Title (truncated)                 │
 *   │  Optional subtitle                 │
 *   │  Optional action button(s)         │
 *   └────────────────────────────────────┘
 *
 * Two interaction modes:
 *   - With `onPick`, the whole tile is a button (spatial-nav-focusable,
 *     Enter triggers onPick). LSFG-VK additionally puts an Apply/Remove
 *     Button in `action` below the title.
 *   - Without `onPick`, the tile is a passive `<div>` (ProtonDB /
 *     HLTB live-data tiles); still focusable so it can show its
 *     focused outline as the user pans through the grid.
 *
 * Image fallback chain: `imageUrl` → `fallbackImageUrl` → placeholder
 * gradient. Failures are detected via `<img onError>`. Resetting the
 * `imageUrl` (e.g. after a refresh-token bump) restarts the chain.
 *
 * IntersectionObserver-driven lazy fetches are NOT handled here —
 * the plugin owns its data layer. Use the `rootRef` callback to
 * attach an observer to the card's root element from the parent.
 */
export interface GameCardProps {
  /** Primary image URL — the preferred art source. */
  imageUrl: string;
  /** Fallback URL tried if `imageUrl` 404s. */
  fallbackImageUrl?: string;
  /** Game title rendered under the image. */
  title: string;
  /** Collection / tag labels overlaid on the bottom edge of the
   *  image. The first `maxCollections` entries are shown, color-coded
   *  by a stable hash so each collection always lands on the same
   *  badge variant. */
  collections?: string[];
  /** Cap on collection badges rendered. Default 1 — keeps the image
   *  legible while still showing the most important categorisation. */
  maxCollections?: number;
  /** Replaces the auto-rendered `collections` badges in the bottom-of-
   *  image overlay row with arbitrary content. HLTB uses this to drop
   *  its time chips (Main / +Ex / 100%) into the same slot rather
   *  than a subtitle line under the title. `collections` is ignored
   *  when this is present. */
  overlayBadges?: ReactNode;
  /** Overlay slot at the image's top-left corner. Typical use:
   *  "RUNNING" chip for the currently-playing game. */
  topLeftBadge?: ReactNode;
  /** Overlay slot at the image's top-right corner. Typical use:
   *  ProtonDB tier chip or applied/installed indicator. */
  topRightBadge?: ReactNode;
  /** Optional small line rendered below the title (status text, time
   *  chips, tier descriptions). */
  subtitle?: ReactNode;
  /** Optional action area rendered below the title (and subtitle, if
   *  present). LSFG-VK uses this for the Apply / Remove button. */
  action?: ReactNode;
  /** Click + Enter handler. When provided, the tile becomes a
   *  semantic button. Spatial-nav focus is wired automatically. */
  onPick?: () => void;
  /** Highlights the tile with an accent border. Drives the "currently
   *  playing" / "selected" visual treatment in every plugin. */
  highlighted?: boolean;
  /** Receives the card's root element after mount/unmount. Pair this
   *  with an IntersectionObserver in the parent for lazy-loaded data
   *  (used by ProtonDB / HLTB to gate per-card backend calls). */
  rootRef?: (node: HTMLDivElement | null) => void;
}

// Badge palette used for collection labels. Deliberately omits
// "neutral" so collection chips always have a distinguishable hue.
const COLLECTION_PALETTE: BadgeVariant[] = [
  "primary",
  "secondary",
  "accent",
  "info",
  "success",
  "warning",
  "error",
];

/**
 * Map a collection name to a stable Badge variant. We hash with the
 * classic 5-bit Daniel J. Bernstein loop so the same collection name
 * always picks the same colour regardless of where it appears in
 * the UI (so e.g. "Nintendo 64" is the same hue in SGDB, HLTB, and
 * ProtonDB Badges).
 */
export function collectionBadgeVariant(name: string): BadgeVariant {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  // Non-null: index is a modulo of the palette length, always in bounds.
  return COLLECTION_PALETTE[Math.abs(h) % COLLECTION_PALETTE.length]!;
}

type Phase = "primary" | "fallback" | "placeholder";

export function GameCard({
  imageUrl,
  fallbackImageUrl,
  title,
  collections,
  maxCollections = 1,
  overlayBadges,
  topLeftBadge,
  topRightBadge,
  subtitle,
  action,
  onPick,
  highlighted = false,
  rootRef,
}: GameCardProps) {
  const [phase, setPhase] = useState<Phase>("primary");
  const { ref: focRef, focused } = useFocusable({ onEnterPress: onPick });

  // Restart the fallback chain whenever the URL changes (e.g. after a
  // cache-bust refresh token). Without this, a tile that fell through
  // to "placeholder" on its previous render would stay there even
  // when the new URL is reachable.
  useEffect(() => {
    setPhase("primary");
  }, [imageUrl]);

  // `useFocusable` returns a RefObject; mutate its `.current` so
  // both spatial-nav and the parent IntersectionObserver see the
  // same DOM node. The card renders as `<button>` or `<div>` (see
  // `interactive` below), so we accept the union here and let the
  // parent IntersectionObserver treat both as `Element`.
  const setMergedRef = (node: HTMLElement | null) => {
    (focRef as { current: HTMLElement | null }).current = node;
    rootRef?.(node as HTMLDivElement | null);
  };

  const currentSrc =
    phase === "primary"
      ? imageUrl
      : phase === "fallback" && fallbackImageUrl
        ? fallbackImageUrl
        : null;

  const interactive = onPick !== undefined;
  const visibleCollections = (collections ?? []).slice(0, maxCollections);

  const className = [
    "flex flex-col gap-2 p-2 bg-[var(--bg-inset)] rounded-xl text-[var(--fg-1)] transition-all duration-150 text-left w-full",
    interactive ? "cursor-pointer" : "",
    highlighted
      ? "border-2 border-[var(--accent)]"
      : "border border-[var(--line)]",
    focused
      ? "scale-[1.03]"
      : interactive
        ? "hover:border-[var(--accent)]/40"
        : "",
  ]
    .filter(Boolean)
    .join(" ");

  const focusStyle: CSSProperties | undefined = focused
    ? { animation: "focusPulse 2s ease-in-out infinite" }
    : undefined;

  const body = (
    <>
      <div className="aspect-[2/3] rounded-md overflow-hidden bg-base-300 relative">
        {currentSrc ? (
          <img
            src={currentSrc}
            alt=""
            loading="lazy"
            onError={() =>
              setPhase((p) =>
                p === "primary" && fallbackImageUrl
                  ? "fallback"
                  : "placeholder",
              )
            }
            className="w-full h-full object-cover block"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-base-300 to-base-200" />
        )}
        {topLeftBadge && (
          <div className="absolute top-1.5 left-1.5">{topLeftBadge}</div>
        )}
        {topRightBadge && (
          <div className="absolute top-1.5 right-1.5">{topRightBadge}</div>
        )}
        {/* Bottom-of-image badge row. `overlayBadges` wins when set
            (HLTB's time chips, future ProtonDB rating, etc.) so the
            caller can drop its own ReactNode straight into the
            shared slot. Otherwise we auto-render the friendly-named
            collection badges from `collections`. `min-w-0` on the
            flex parent + child lets the badge text actually shrink
            with the container instead of forcing the badge wider
            than the image. */}
        {overlayBadges ? (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex flex-wrap gap-1 min-w-0">
            {overlayBadges}
          </div>
        ) : visibleCollections.length > 0 ? (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex flex-wrap gap-1 min-w-0">
            {visibleCollections.map((c) => (
              // Solid backdrop under each badge so the soft variant tint
              // stays legible over bright artwork. `--bg-inset` matches
              // the card's own panel inset so the chip reads as part of
              // the UI rather than the image. Rounded-full matches the
              // DaisyUI badge pill shape so the wrapper is invisible.
              <span
                key={c}
                title={c}
                className="max-w-full inline-flex rounded-full"
                style={{ background: "var(--bg-inset)" }}
              >
                <Badge
                  variant={collectionBadgeVariant(c)}
                  size="xs"
                  className="max-w-full truncate min-w-0"
                >
                  {friendlyCollectionName(c)}
                </Badge>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div
        className="text-[11.5px] font-semibold leading-tight truncate"
        title={title}
      >
        {title}
      </div>

      {subtitle && (
        <div className="min-h-[16px] min-w-0 text-[10.5px] text-[var(--fg-3)] overflow-hidden">
          {subtitle}
        </div>
      )}

      {/* Stop clicks on the action button(s) from bubbling to the card's
          own onClick (the interactive+action branch below wraps the whole
          body in a <div onClick={onPick}>). Without this, clicking e.g.
          "Remove" fires both the button handler AND onPick — a double
          invocation. Gamepad A still reaches onPick via onEnterPress. */}
      {action && (
        <div
          className="flex items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {action}
        </div>
      )}
    </>
  );

  // Render decision:
  //   - interactive + no inner action  → <button>: spatial-nav focus +
  //     Enter + native click-anywhere come for free.
  //   - interactive + inner action     → <div> with onClick: the
  //     `action` slot already contains a real <Button>, and nesting
  //     a <button> inside another <button> is invalid HTML (browsers
  //     parse-fix by lifting the inner one out, breaking the layout).
  //     `useFocusable` still wires the d-pad → A handler via
  //     `onEnterPress`, and the div's onClick covers mouse clicks
  //     anywhere on the card body. LSFG-VK uses this shape so that
  //     gamepad A on the card behaves the same as clicking Apply,
  //     while mouse users still have the explicit Apply button.
  //   - non-interactive                → plain <div>, just receives
  //     focus outline as the user pans through the grid.
  // `data-game-card` is a stable, render-neutral hook for tooling — the
  // screenshot script clicks the first tile to reach a plugin's detail
  // page regardless of each grid's bespoke class names.
  if (interactive && !action) {
    return (
      <button
        ref={setMergedRef}
        onClick={onPick}
        type="button"
        data-game-card=""
        className={className}
        style={focusStyle}
      >
        {body}
      </button>
    );
  }
  if (interactive) {
    return (
      <div
        ref={setMergedRef}
        onClick={onPick}
        role="button"
        data-game-card=""
        className={className}
        style={focusStyle}
      >
        {body}
      </div>
    );
  }
  return (
    <div ref={setMergedRef} data-game-card="" className={className} style={focusStyle}>
      {body}
    </div>
  );
}
