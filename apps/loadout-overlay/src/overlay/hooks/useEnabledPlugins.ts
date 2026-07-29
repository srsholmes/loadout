import { useCallback } from "react";
import { useConfigValue, setConfigValue } from "../lib/userConfig";

const DISABLED_KEY = "disabledPlugins";
const WELCOME_KEY = "welcomeCompleted";

/**
 * Persisted plugin enablement — a deny-list (`disabledPlugins`) so
 * plugins installed later default to enabled. The backend loader reads
 * the same key at startup and never imports a disabled plugin's code;
 * writing it through setConfigValue also triggers the loader's
 * runtime-enable path (a newly-enabled plugin is loaded live, while a
 * newly-disabled one needs an app restart to actually unload).
 *
 * The legacy `enabledPlugins` allow-list is migrated by the backend at
 * startup, so this hook only ever sees the deny-list key.
 */
export function useEnabledPlugins() {
  const [disabled, setDisabled] = useConfigValue<string[] | undefined>(DISABLED_KEY, undefined);

  const isEnabled = useCallback(
    (id: string) => !(disabled ?? []).includes(id),
    [disabled],
  );

  const toggle = useCallback(
    (id: string) => {
      const base = disabled ?? [];
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      setDisabled(next);
    },
    [disabled, setDisabled],
  );

  return { disabled, setDisabled, isEnabled, toggle };
}

export function setWelcomeCompleted(v: boolean): void {
  setConfigValue(WELCOME_KEY, v);
}
