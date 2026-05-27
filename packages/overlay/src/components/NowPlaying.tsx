import { useEffect, useState } from "react";
import { useCurrentGame } from "@loadout/ui";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";

export function NowPlaying() {
  const game = useCurrentGame();
  // Two-stage fallback: hero (1920×620) → header (460×215) → solid color.
  // Shortcuts without any local art fail every URL, so we have to drop
  // the <img> out of the tree rather than leave a broken-image glyph.
  const [heroFailed, setHeroFailed] = useState(false);
  const [headerFailed, setHeaderFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  // Reset failure flags when the running game changes — without this,
  // switching from a no-art shortcut (e.g. uncustomised non-Steam) to
  // a Steam app keeps the panel blank because the previous game's
  // 404s already flipped every flag to true.
  //
  // Known limitation: if the user applies SGDB art for the currently-
  // running game *while the overlay is open*, the appId doesn't
  // change so the failed flags don't reset and the new art won't
  // appear until the user closes + reopens the overlay or switches
  // games. Fixing that needs an SGDB-emitted "art applied" event the
  // homepage subscribes to — out of scope for #113 / #115.
  const appId = game?.appId;
  useEffect(() => {
    setHeroFailed(false);
    setHeaderFailed(false);
    setLogoFailed(false);
  }, [appId]);

  if (!game) return null;

  const art = steamArtworkUrls(game.appId);
  const heroSrc = heroFailed ? art.header : art.hero;
  const showHeroImg = !(heroFailed && headerFailed);

  return (
    <div className="relative mb-6 h-40 rounded-xl overflow-hidden bg-base-200 ring-1 ring-base-300/50 shadow-lg">
      {showHeroImg && (
        <img
          src={heroSrc}
          alt={game.gameName}
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => {
            if (!heroFailed) setHeroFailed(true);
            else setHeaderFailed(true);
          }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-base-100/95 via-base-100/50 to-transparent" />
      <div className="absolute inset-0 flex items-end p-5 gap-4">
        {!logoFailed ? (
          <img
            src={art.logo}
            alt=""
            className="max-h-20 max-w-[40%] object-contain drop-shadow-lg"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <h2 className="text-2xl font-bold text-base-content drop-shadow-lg truncate">
            {game.gameName || `App ${game.appId}`}
          </h2>
        )}
        <div className="flex flex-col gap-0.5 ml-auto text-right">
          <span className="text-[10px] uppercase tracking-[0.12em] text-base-content/60 font-semibold">
            Now playing
          </span>
          {!logoFailed && (
            <span className="text-sm text-base-content/90 truncate max-w-[280px]">
              {game.gameName || `App ${game.appId}`}
            </span>
          )}
          <span className="text-[11px] text-base-content/50 font-mono">
            AppID {game.appId}
          </span>
        </div>
      </div>
    </div>
  );
}
