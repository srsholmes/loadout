import { useCallback } from "react";
import { useConfigValue, getConfigValue, setConfigValue } from "../lib/userConfig";

const ENABLED_KEY = "enabledPlugins";
const WELCOME_KEY = "welcomeCompleted";

/**
 * Persisted enable list for the sidebar / homepage. `undefined` means the
 * user hasn't picked yet (pre-welcome), in which case every plugin is
 * surfaced — the welcome modal sits on top regardless, so this only
 * matters if the user has dismissed it.
 */
export function useEnabledPlugins() {
  const [enabled, setEnabled] = useConfigValue<string[] | undefined>(ENABLED_KEY, undefined);

  const isEnabled = useCallback(
    (id: string) => (enabled ? enabled.includes(id) : true),
    [enabled],
  );

  const toggle = useCallback(
    (id: string, allKnownIds: string[]) => {
      const base = enabled ?? allKnownIds;
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      setEnabled(next);
    },
    [enabled, setEnabled],
  );

  return { enabled, setEnabled, isEnabled, toggle };
}

export function isWelcomeCompleted(): boolean {
  return getConfigValue<boolean>(WELCOME_KEY, false);
}

export function setWelcomeCompleted(v: boolean): void {
  setConfigValue(WELCOME_KEY, v);
}
