import { useEffect, useState } from "react";
import { useCurrentGame } from "../sdk";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";
import { GameHero } from "./GameHero";

/**
 * Home-screen hero for the currently-running game: the shared
 * `<GameHero>` banner fed by `useCurrentGame()`, with the game logo (or
 * its title) and a "Now playing" label. Renders nothing when no game is
 * active. Detail views use `<GameHero>` directly with the *selected*
 * game; this is the only surface that tracks the running one.
 */
export function NowPlaying() {
  const game = useCurrentGame();
  const [logoFailed, setLogoFailed] = useState(false);

  // Reset the logo fallback when the running game changes.
  const appId = game?.appId;
  useEffect(() => {
    setLogoFailed(false);
  }, [appId]);

  if (!game) return null;

  const art = steamArtworkUrls(game.appId);

  return (
    <GameHero
      heroUrl={art.hero}
      fallbackHeroUrl={art.header}
      gameName={game.gameName}
      className="mb-6"
    >
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
    </GameHero>
  );
}
