import { useEffect, useState, type ReactNode } from "react";

export interface GameHeroProps {
  /** Primary background artwork URL (e.g. a Steam hero / store hero). */
  heroUrl?: string;
  /** Fallback background tried if `heroUrl` fails to load (e.g. the
   *  narrower Steam header). After both fail, a solid panel shows. */
  fallbackHeroUrl?: string;
  /** Accessible alt text for the artwork. */
  gameName?: string;
  /** Extra classes appended to the container — typically a margin
   *  (`mb-6`) or a height override. The core look (rounded, scrim,
   *  `h-40`) is fixed so every hero matches the home screen. */
  className?: string;
  /** Content overlaid along the bottom of the hero — the game logo,
   *  title, badges, or action chrome. Laid out left-to-right, bottom-
   *  aligned (use `ml-auto` to push a block to the right edge). */
  children?: ReactNode;
}

/**
 * Full-bleed game hero banner: artwork background with a bottom-up
 * gradient scrim and a bottom-aligned content row. The single source of
 * the "now playing"-style banner used on the home screen and on every
 * plugin's game-detail view, so they all look identical.
 *
 * Artwork failures fall through `heroUrl` → `fallbackHeroUrl` → solid
 * panel; the chain resets when the URLs change (e.g. navigating between
 * games) so a previous game's 404 doesn't blank the next one.
 */
export function GameHero({
  heroUrl,
  fallbackHeroUrl,
  gameName,
  className,
  children,
}: GameHeroProps) {
  const [primaryFailed, setPrimaryFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);

  useEffect(() => {
    setPrimaryFailed(false);
    setFallbackFailed(false);
  }, [heroUrl, fallbackHeroUrl]);

  const src = !primaryFailed ? heroUrl : !fallbackFailed ? fallbackHeroUrl : undefined;

  return (
    <div
      className={`relative h-40 rounded-xl overflow-hidden bg-base-200 ring-1 ring-base-300/50 shadow-lg ${className ?? ""}`}
    >
      {src && (
        <img
          src={src}
          alt={gameName ?? ""}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => {
            if (!primaryFailed) setPrimaryFailed(true);
            else setFallbackFailed(true);
          }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-base-100/95 via-base-100/50 to-transparent" />
      <div className="absolute inset-0 flex items-end p-5 gap-4">{children}</div>
    </div>
  );
}
