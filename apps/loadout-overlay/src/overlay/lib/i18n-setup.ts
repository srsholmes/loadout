/**
 * Overlay-side wiring for the shared i18n core in `@loadout/ui`.
 *
 * Keeps all the overlay/backend specifics (statically-bundled shell
 * strings, the loader fetch for plugin translation files, OS-locale
 * detection) out of `@loadout/ui` so that package stays portable. The
 * core only knows how to switch languages and stitch namespaces together.
 */

import { initI18n, normalizeLocale, DEFAULT_LANGUAGE } from "@loadout/ui";
import { getConfigValue, setConfigValue } from "./userConfig";
import { apiUrl } from "./backend";
import { getSystemLocale } from "./host";
import enGb from "../i18n/en-gb.json";
import zhCn from "../i18n/zh-cn.json";

const LANGUAGE_CONFIG_KEY = "language";

/**
 * Shell strings, bundled statically by Vite under the `app` namespace.
 * Shape: `{ [lng]: { app: { …keys } } }`.
 */
const appResources = {
  "en-gb": { app: enGb as Record<string, unknown> },
  "zh-cn": { app: zhCn as Record<string, unknown> },
} as unknown as Record<string, Record<string, Record<string, string>>>;

/**
 * Fetch a plugin's translation bundle from the loader
 * (`/plugins/<id>/i18n/<lng>.json`). Returns `null` on 404 / parse
 * error — the core then leaves that namespace untranslated and keys fall
 * back to English.
 */
async function loadNamespaceResource(
  lng: string,
  ns: string,
): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(apiUrl(`/plugins/${ns}/i18n/${lng}.json`));
    if (!res.ok) return null;
    return (await res.json()) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * First-run language detection: prefer the host OS locale (reliable under
 * gamescope), fall back to the webview's `navigator.language`, then to
 * English. The result is normalized to a supported language code.
 */
export async function detectInitialLanguage(): Promise<string> {
  let raw = "";
  try {
    raw = await getSystemLocale();
  } catch {
    raw = "";
  }
  if (!raw && typeof navigator !== "undefined") {
    raw = navigator.language || (navigator.languages && navigator.languages[0]) || "";
  }
  return normalizeLocale(raw);
}

/**
 * Synchronous best-effort init for first paint — mirrors how the theme is
 * applied before render. Reads the persisted language from the userConfig
 * mirror (instant after the first boot) and initializes i18n with the
 * statically-bundled shell strings so the UI never flashes raw keys.
 * Fire-and-forget; {@link initOverlayI18n} reconciles afterwards.
 */
export function seedOverlayI18n(): void {
  const stored = getConfigValue<string>(LANGUAGE_CONFIG_KEY, "").trim();
  const language = stored ? normalizeLocale(stored) : DEFAULT_LANGUAGE;
  void initI18n({ language, appResources, loadNamespaceResource });
}

/**
 * Resolve the active language and initialize i18n. Call once at boot,
 * after `loadUserConfig()` so the persisted choice (if any) is available.
 *
 * - If the user has set a language, use it.
 * - Otherwise detect from the OS/browser, persist it, and use that.
 */
export async function initOverlayI18n(): Promise<void> {
  const stored = getConfigValue<string>(LANGUAGE_CONFIG_KEY, "").trim();
  let language = stored ? normalizeLocale(stored) : "";

  if (!language) {
    language = await detectInitialLanguage();
    // Persist the detected default so future boots are stable and the
    // Settings selector reflects the active language.
    setConfigValue(LANGUAGE_CONFIG_KEY, language);
  }

  await initI18n({ language, appResources, loadNamespaceResource });
}
