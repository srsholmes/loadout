import { useConfigValue } from "../lib/userConfig";

const CONFIG_KEY = "sidebarAutoCollapse";

/**
 * Persisted preference for auto-collapsing the sidebar while focus is
 * inside the plugin content area. Stored in the user config file.
 */
export function useSidebarAutoCollapseSetting(): [boolean, (v: boolean) => void] {
  return useConfigValue<boolean>(CONFIG_KEY, false);
}
