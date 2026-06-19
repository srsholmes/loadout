import { useEffect, useState } from "react";
import { useCurrentGame } from "../sdk";
import { steamArtworkUrls } from "@loadout/steam-paths/artwork";
import { GameHero } from "./GameHero";

/**
 * Home-screen hero for the currently-running game: the shared
 * `<GameHero>` banner fed by `useCurrentGame()`, showing just the game
 * logo over its artwork — no "Now playing" label, title text, or AppID.
 * Renders nothing when no game is active (or its logo fails to load).
 * Detail views use `<GameHero>` directly with the *selected* game; this
 * is the only surface that tracks the running one.
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
      {!logoFailed && (
        <img
          src={art.logo}
          alt=""
          className="max-h-20 max-w-[40%] object-contain drop-shadow-lg"
          onError={() => setLogoFailed(true)}
        />
      )}
    </GameHero>
  );
}
