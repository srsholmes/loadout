import { useCallback } from "react";
import { useConfigValue } from "../lib/userConfig";

const CONFIG_KEY = "favoritePlugins";

/**
 * Persisted list of favorite plugin IDs (sidebar pins them to the top).
 * Backed by the user config file so reinstalls don't wipe the list.
 */
export function useFavorites() {
  const [favorites, setFavorites] = useConfigValue<string[]>(CONFIG_KEY, []);

  const isFavorite = useCallback(
    (id: string) => favorites.includes(id),
    [favorites],
  );

  const toggle = useCallback(
    (id: string) => {
      const next = favorites.includes(id)
        ? favorites.filter((x) => x !== id)
        : [...favorites, id];
      setFavorites(next);
    },
    [favorites, setFavorites],
  );

  return { favorites, isFavorite, toggle };
}
