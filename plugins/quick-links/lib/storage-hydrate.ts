/**
 * Pure storage hydration helpers — turning whatever shape lives on
 * disk (or nothing on a fresh install) into a fully-populated
 * `QuickLinksStorage`. Lives in `lib/` so the merge rules (built-ins
 * win on shape, user mutations win on values, legacy gaming-mode-
 * browser imports only when our own storage is empty) are testable
 * without backend mocks.
 *
 * Types are duplicated from `backend.ts` (kept structurally compatible
 * via the `*Shape` suffix) so this module has no circular import
 * back to `backend.ts`.
 */

export interface LinkTemplateShape {
  id: string;
  name: string;
  urlTemplate: string;
  description?: string;
  suffixGroup?: string;
  steamOnly?: boolean;
  builtin: boolean;
  enabled: boolean;
}

export interface GamePinsShape {
  pinnedTemplateIds: string[];
  customLinks: { name: string; url: string }[];
}

export interface InstalledShortcutShape {
  browserId: string;
  name: string;
  kind: "native" | "flatpak";
  appId: number;
  gameId64: string;
  exe: string;
  launchOptionsBase: string;
}

export interface QuickLinksStorageShape {
  version: 1;
  templates: LinkTemplateShape[];
  suffixes: Record<string, string[]>;
  perGame: Record<string, GamePinsShape>;
  hidden: string[];
  selectedBrowserId?: string | null;
  installedBrowsers: InstalledShortcutShape[];
}

/** A fresh-install storage snapshot, seeded with the supplied defaults. */
export function emptyStorage(
  defaultTemplates: readonly LinkTemplateShape[],
  defaultSuffixes: Readonly<Record<string, string[]>>,
): QuickLinksStorageShape {
  return {
    version: 1,
    templates: defaultTemplates.map((t) => ({ ...t })),
    suffixes: Object.fromEntries(
      Object.entries(defaultSuffixes).map(([k, v]) => [k, [...v]]),
    ),
    perGame: {},
    hidden: [],
    installedBrowsers: [],
  };
}

/**
 * Merge a partial-on-disk shape with current defaults. The defaults
 * win on shape (so a new built-in template added in a later version
 * shows up on first read), but the user's mutations to existing
 * built-ins (renamed, disabled, urlTemplate edited) win.
 *
 * `legacyInstalled` is the (possibly empty) list of browser shortcuts
 * imported from the pre-#121 `gaming-mode-browser` plugin storage. It
 * is only adopted when `raw.installedBrowsers` is absent — once
 * Quick Links has its own list, the legacy data is ignored.
 */
export function hydrate(
  raw: Partial<QuickLinksStorageShape>,
  legacyInstalled: InstalledShortcutShape[],
  defaultTemplates: readonly LinkTemplateShape[],
  defaultSuffixes: Readonly<Record<string, string[]>>,
): QuickLinksStorageShape {
  const base = emptyStorage(defaultTemplates, defaultSuffixes);
  const userTemplates = Array.isArray(raw.templates) ? raw.templates : [];
  const userById = new Map(userTemplates.map((t) => [t.id, t]));

  // Built-ins: take base shape, layer user overrides on top.
  const merged: LinkTemplateShape[] = [];
  const seen = new Set<string>();
  for (const def of base.templates) {
    const user = userById.get(def.id);
    if (user && user.builtin) {
      merged.push({ ...def, ...user, builtin: true });
    } else {
      merged.push(def);
    }
    seen.add(def.id);
  }
  // User-added templates (builtin === false) come after built-ins.
  for (const t of userTemplates) {
    if (seen.has(t.id)) continue;
    if (!t || typeof t.id !== "string" || typeof t.urlTemplate !== "string")
      continue;
    merged.push({ ...t, builtin: false });
  }

  const suffixes =
    raw.suffixes && typeof raw.suffixes === "object"
      ? { ...base.suffixes, ...raw.suffixes }
      : base.suffixes;

  const perGame =
    raw.perGame && typeof raw.perGame === "object"
      ? (raw.perGame as Record<string, GamePinsShape>)
      : {};

  const hidden = Array.isArray(raw.hidden)
    ? raw.hidden.filter((x): x is string => typeof x === "string")
    : [];

  const selectedBrowserId =
    typeof raw.selectedBrowserId === "string" && raw.selectedBrowserId.length > 0
      ? raw.selectedBrowserId
      : null;

  // Browser-shortcut migration. If our own storage has installedBrowsers,
  // use that. Otherwise (first run after #121 lands), import whatever
  // gaming-mode-browser had registered so the user doesn't lose their
  // shortcut.
  const installedBrowsers = Array.isArray(raw.installedBrowsers)
    ? raw.installedBrowsers
    : legacyInstalled;

  return {
    version: 1,
    selectedBrowserId,
    templates: merged,
    suffixes,
    perGame,
    hidden,
    installedBrowsers,
  };
}
