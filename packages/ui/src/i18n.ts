/**
 * Shared i18n core. Lives in `@loadout/ui` on purpose: plugin bundles
 * resolve `@loadout/ui` to the shell's `globalThis.__LOADOUT_SDK`
 * singleton (see apps/loadout/src/loader/inject-builder.ts), so the host
 * shell and every plugin share ONE i18next instance and ONE React. That
 * means `setLanguage()` re-renders the whole tree — shell + every mounted
 * plugin root — with no per-plugin provider wiring.
 *
 * Resource model:
 *  - The shell registers its own strings under the `app` namespace at
 *    init (`appResources`), bundled statically by Vite.
 *  - Each plugin uses its plugin id as a namespace and ships
 *    `i18n/<lang>.json` files served by the loader. They're fetched
 *    lazily the first time a plugin calls `usePluginTranslation(id)` via
 *    the injected `loadNamespaceResource` fetcher (kept out of this
 *    package so `@loadout/ui` stays free of overlay/backend specifics).
 *
 * Language codes are lowercase BCP-47-ish (`en-gb`, `zh-cn`) to match the
 * per-plugin `i18n/<code>.json` filenames; i18next runs with
 * `lowerCaseLng: true` so `en-GB` and `en-gb` resolve the same file.
 */

import i18n from "i18next";
import { initReactI18next, useTranslation, Trans } from "react-i18next";
import { useEffect, useReducer } from "react";

export interface SupportedLanguage {
  /** Lowercase locale code — matches the `i18n/<code>.json` filename. */
  code: string;
  /** Human-readable label shown in the language picker. */
  label: string;
}

/** Languages the app ships. English is the source + fallback. */
export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: "en-gb", label: "English" },
  { code: "zh-cn", label: "中文 (简体)" },
];

export const DEFAULT_LANGUAGE = "en-gb";

const APP_NAMESPACE = "app";

/** Fetcher for a namespace's resources, injected at init by the shell. */
export type LoadNamespaceResource = (
  lng: string,
  ns: string,
) => Promise<Record<string, string> | null>;

let loadNamespaceResource: LoadNamespaceResource = async () => null;

/** Tracks `${lng}:${ns}` combos already fetched so we never refetch. */
const loadedBundles = new Set<string>();

/**
 * Resolve an arbitrary OS / browser locale string to the closest
 * supported code. Handles `zh_CN.UTF-8`, `en_GB`, `zh-Hans`, etc.
 * Falls back to {@link DEFAULT_LANGUAGE} when nothing matches.
 */
export function normalizeLocale(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_LANGUAGE;
  // `zh_CN.UTF-8` / `en_GB@euro` → `zh-cn` / `en-gb`
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[_]/g, "-")
    .replace(/[.@].*$/, "");
  if (!cleaned || cleaned === "c" || cleaned === "posix") return DEFAULT_LANGUAGE;

  const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
  // Exact match first (`zh-cn`).
  if (codes.includes(cleaned)) return cleaned;
  // Then language-prefix match (`zh`, `zh-hans`, `zh-tw` → `zh-cn`).
  const lang = cleaned.split("-")[0];
  const prefixMatch = codes.find((c) => c.split("-")[0] === lang);
  if (prefixMatch) return prefixMatch;
  return DEFAULT_LANGUAGE;
}

/** True once {@link initI18n} has run. */
export function isI18nInitialized(): boolean {
  return i18n.isInitialized;
}

export interface InitI18nOptions {
  language: string;
  /** `{ [lng]: { app: { key: value } } }` — bundled shell strings. */
  appResources: Record<string, Record<string, Record<string, string>>>;
  loadNamespaceResource: LoadNamespaceResource;
}

/**
 * Initialize the shared i18next instance. Idempotent — calling it again
 * just refreshes the resource loader and switches language.
 */
export async function initI18n(opts: InitI18nOptions): Promise<void> {
  loadNamespaceResource = opts.loadNamespaceResource;

  if (i18n.isInitialized) {
    await i18n.changeLanguage(opts.language);
    return;
  }

  await i18n.use(initReactI18next).init({
    lng: opts.language,
    fallbackLng: DEFAULT_LANGUAGE,
    lowerCaseLng: true,
    defaultNS: APP_NAMESPACE,
    ns: [APP_NAMESPACE],
    resources: opts.appResources,
    interpolation: { escapeValue: false },
    react: {
      useSuspense: false,
      // Re-render components when a plugin namespace bundle is added at
      // runtime (we load them manually via addResourceBundle, not a
      // backend, so the default 'languageChanged'-only binding misses them).
      bindI18nStore: "added",
    },
  });
}

/**
 * Ensure a namespace's resources are loaded for the active language and
 * the fallback. Idempotent and safe to call repeatedly. No-op if the
 * bundle is already present (e.g. the statically-bundled `app` ns).
 */
export async function ensureNamespace(ns: string): Promise<void> {
  const langs = new Set<string>([i18n.language, DEFAULT_LANGUAGE]);
  await Promise.all(
    [...langs].map(async (lng) => {
      if (!lng) return;
      const key = `${lng}:${ns}`;
      if (loadedBundles.has(key)) return;
      if (i18n.hasResourceBundle(lng, ns)) {
        loadedBundles.add(key);
        return;
      }
      loadedBundles.add(key); // mark before await so concurrent callers don't double-fetch
      try {
        const res = await loadNamespaceResource(lng, ns);
        if (res) i18n.addResourceBundle(lng, ns, res, true, true);
      } catch {
        // Missing translation file → namespace stays untranslated and
        // keys fall back to English (or the raw key). Not fatal.
        loadedBundles.delete(key);
      }
    }),
  );
}

/**
 * Switch the active language at runtime and make sure every
 * already-active namespace has resources for the new language. All
 * mounted `useTranslation` / `usePluginTranslation` consumers re-render.
 */
export async function setLanguage(code: string): Promise<void> {
  await i18n.changeLanguage(code);
  // Re-hydrate namespaces the user has already touched in the new language.
  const active = (i18n.options.ns as string[] | undefined) ?? [APP_NAMESPACE];
  await Promise.all(active.map((ns) => ensureNamespace(ns)));
}

/** Current active language code. */
export function getLanguage(): string {
  return i18n.language || DEFAULT_LANGUAGE;
}

/**
 * Plugin-facing translation hook. Lazily loads the plugin's
 * `i18n/<lang>.json` (namespace = plugin id) and returns a `t` scoped to
 * it. Re-loads on language change so runtime switching Just Works.
 *
 *   const { t } = usePluginTranslation("battery-tracker");
 *   <span>{t("power_flow")}</span>
 */
export function usePluginTranslation(pluginId: string) {
  const result = useTranslation(pluginId, { useSuspense: false });
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const lng = result.i18n.language;

  useEffect(() => {
    let alive = true;
    ensureNamespace(pluginId).then(() => {
      if (alive) forceUpdate();
    });
    return () => {
      alive = false;
    };
  }, [pluginId, lng]);

  return result;
}

export { i18n, useTranslation, Trans };
