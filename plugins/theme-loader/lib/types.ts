// ---------------------------------------------------------------------------
// Community theme registry (live from api.deckthemes.com via lib/themes-cache)
// ---------------------------------------------------------------------------

export interface CommunityThemeEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  version: string;
  /** deckthemes blob id for the theme zip (canonical install source). */
  downloadBlobId: string;
  githubRepo: string | null;
  githubUrl: string | null;
  /**
   * Hotlink URL for the theme thumbnail, served by the upstream
   * deckthemes CDN. The user's CEF webview loads it directly; we do
   * not bundle, cache, or re-host the image.
   */
  thumbnailUrl: string | null;
  downloadCount: number;
  starCount: number;
  updated: string;
  target: string;
}

// ---------------------------------------------------------------------------
// ThemeDB-format theme manifest (theme.json) — interop format used by
// community themes published to deckthemes.com.
// ---------------------------------------------------------------------------

/** Array of target contexts (SP / MainMenu / QuickAccess) a CSS file applies to. */
export type InjectTargets = string[];

/** Manifest v2 inject map: filename → targets[]. */
export type InjectMap = Record<string, InjectTargets>;

export interface ThemePatch {
  default: string;
  type?: "dropdown" | "slider" | "checkbox";
  values: Record<string, InjectMap>;
}

export interface ThemePackManifest {
  name: string;
  author?: string;
  version?: string;
  manifest_version?: number;
  /** Baseline CSS files that are always injected. */
  inject?: InjectMap;
  /** User-toggleable variants. Map of patch name → patch definition. */
  patches?: Record<string, ThemePatch>;
  dependencies?: Record<string, unknown>;
  id?: string;
}

// ---------------------------------------------------------------------------
// Unified theme info returned by getThemes()
// ---------------------------------------------------------------------------

export type ThemeKind = "pack";

export interface ThemeListEntry {
  /** Stable ID used by enable/disable/setThemePackVariant. */
  id: string;
  name: string;
  kind: ThemeKind;
  active: boolean;
  /** For packs: hotlink URL to the upstream thumbnail (if known). */
  thumbnailUrl?: string | null;
  /** For packs: parsed theme.json patches for the variant picker */
  patches?: Record<string, { default: string; type?: string; values: string[] }>;
  /** For packs: per-patch selected variant */
  variants?: Record<string, string>;
  /** For packs: attribution metadata captured at install time. */
  meta?: {
    author: string | null;
    description: string | null;
    version: string | null;
    sourceUrl: string | null;
    license: { fileName: string; content: string } | null;
  } | null;
}
