/**
 * The persisted config: shape, defaults, validation, and salvage.
 *
 * Config durability is a feature here, not plumbing. TabMaster's settings
 * live in one Decky JSON file with no schema version and no automatic
 * backup; a Decky plugin-reload loop can corrupt it, and its own maintainer
 * has told users there is no way to recover — "unfortunately, as far as I
 * know there's no way to recover them". The community reaction is exactly
 * what you'd expect: "spent a lot of time putting together those tabs, I
 * really do not want to lose all that."
 *
 * Three rules follow from that:
 *
 * 1. **Never persist an invalid config.** `validateConfig` runs before every
 *    write and the write throws rather than proceeding. A validation failure
 *    is a bug we want loudly, not a corrupted file discovered next week.
 * 2. **Never fail a whole load over one bad tab.** `coerceConfig` salvages
 *    what parses and *reports* what it dropped, so the UI can offer a
 *    restore instead of showing an empty plugin.
 * 3. **Version from day one.** Shipping v1 with a working (if empty)
 *    migration chain means v2 is a data change, not an emergency.
 *
 * Isomorphic: pure, no I/O. The filesystem lives in `backups.ts`/`storage.ts`.
 */

import type {
  BadgeKind,
  BuiltinTabId,
  GroupSpec,
  MirrorLedger,
  SortSpec,
  Tab,
} from "./types";
import { builtinTabs } from "./templates";

/**
 * Bump whenever the persisted shape changes, and add a migration keyed by
 * the version being migrated *from* in `migrations.ts`.
 */
export const LIBRARY_TABS_SCHEMA_VERSION = 1;

export interface LibraryTabsSettings {
  /** Default `GameCardGrid.minTileWidth` for tabs that don't override it. */
  defaultTileWidth: number;
  /** Show per-tab match counts in the strip. */
  showCounts: boolean;
  /** Default policy for newly-created tabs. */
  indeterminatePolicy: "pass" | "fail";
  /** How many timestamped backups to keep. */
  maxBackups: number;
  /**
   * Optional prefix for mirrored Steam collection names.
   *
   * Empty by default: identity comes from the ledger, so a prefix isn't
   * needed and clean names look native in Steam's sidebar. It's exposed
   * because a prefix is the only way to answer "which of these did Loadout
   * make?" from inside Steam's own UI, which may turn out to matter more
   * than tidiness once people have twenty of them.
   */
  mirrorPrefix: string;
}

export interface GameOverride {
  /** Overrides `GameMetadata.sortAs` for sorting. */
  sortAs?: string;
  /** Overrides the displayed title. */
  displayName?: string;
  /** Hide from every tab, regardless of rules. */
  hidden?: boolean;
}

export interface TabProfile {
  id: string;
  label: string;
  /**
   * Games that activate this profile on launch. Empty means manual-only.
   *
   * TabMaster's Tab Profiles are global and manual — you apply them by hand
   * from a menu, and they never switch themselves. Keying them to a game is
   * the version people actually ask for.
   */
  appIds: string[];
  /** Tab ids to make visible, in order. */
  tabIds: string[];
}

export interface LibraryTabsConfig {
  schemaVersion: number;
  tabs: Tab[];
  /** Explicit strip order. Tab ids absent from this list are appended. */
  tabOrder: string[];
  /**
   * Which tab opens by default. `null` means "the first visible one".
   *
   * TabMaster cannot do this — its issue #221 asks for exactly it, and the
   * only workaround is hiding All Games entirely.
   */
  defaultTabId: string | null;
  /** Builtin tabs the user has hidden. */
  hiddenBuiltinTabs: BuiltinTabId[];
  /** Per-game overrides, keyed by appId. */
  gameOverrides: Record<string, GameOverride>;
  profiles: TabProfile[];
  mirror: {
    autoSync: boolean;
    /** A sync was wanted but Steam wasn't reachable. Retried opportunistically. */
    pendingSync: boolean;
    ledger: MirrorLedger;
  };
  settings: LibraryTabsSettings;
}

export function defaultSettings(): LibraryTabsSettings {
  return {
    defaultTileWidth: 150,
    showCounts: true,
    indeterminatePolicy: "pass",
    maxBackups: 20,
    mirrorPrefix: "",
  };
}

export function defaultConfig(): LibraryTabsConfig {
  const tabs = builtinTabs();
  return {
    schemaVersion: LIBRARY_TABS_SCHEMA_VERSION,
    tabs,
    tabOrder: tabs.map((t) => t.id),
    defaultTabId: null,
    hiddenBuiltinTabs: [],
    gameOverrides: {},
    profiles: [],
    mirror: {
      autoSync: false,
      pendingSync: false,
      ledger: { version: 1, entries: [] },
    },
    settings: defaultSettings(),
  };
}

// ── Narrowing helpers ──────────────────────────────────────────────────
//
// Hand-rolled rather than zod: the repo has no schema library, the plugin
// bundle stays small, and — the real reason — every message below is shown
// to a user, which a generic validator's output is not.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

const SORT_FIELDS = new Set<SortSpec["field"]>([
  "sortAs", "name", "lastPlayed", "playtimeMinutes", "sizeOnDisk",
  "releaseDate", "reviewPercentage", "deckCompat", "random", "manual",
]);

const BADGE_KINDS = new Set<BadgeKind>([
  "deckCompat", "playtime", "size", "protonTier", "hltb", "reviewScore",
  "collection",
]);

/** Validate a rule tree. Returns problems, prefixed for context. */
function ruleProblems(rule: unknown, path: string): string[] {
  if (!isRecord(rule)) return [`${path} is not an object`];
  if (typeof rule.id !== "string" || rule.id.length === 0) {
    return [`${path} is missing an id`];
  }
  if (typeof rule.kind !== "string") return [`${path} is missing a kind`];

  if (rule.kind === "group") {
    if (rule.combinator !== "all" && rule.combinator !== "any") {
      return [`${path} has an unknown combinator "${String(rule.combinator)}"`];
    }
    if (!Array.isArray(rule.children)) {
      return [`${path} is a group with no children list`];
    }
    return rule.children.flatMap((c, i) => ruleProblems(c, `${path}.children[${i}]`));
  }
  // Leaf parameters are not deep-checked here. The rule registry's own
  // predicates are defensive, and `isRuleComplete` reports half-built rules
  // in the UI — rejecting a whole config over one out-of-range slider would
  // be worse than rendering it and letting the user fix it.
  return [];
}

function tabProblems(tab: unknown, index: number): string[] {
  const at = `tabs[${index}]`;
  if (!isRecord(tab)) return [`${at} is not an object`];

  const problems: string[] = [];
  if (typeof tab.id !== "string" || tab.id.length === 0) {
    problems.push(`${at} is missing an id`);
  }
  if (typeof tab.label !== "string" || tab.label.length === 0) {
    problems.push(`${at} is missing a name`);
  }
  if (typeof tab.visible !== "boolean") problems.push(`${at}.visible must be true or false`);
  if (typeof tab.autoHide !== "boolean") problems.push(`${at}.autoHide must be true or false`);

  problems.push(...ruleProblems(tab.root, `${at}.root`));
  if (isRecord(tab.root) && tab.root.kind !== "group") {
    problems.push(`${at}.root must be a group`);
  }

  if (!Array.isArray(tab.sort)) {
    problems.push(`${at}.sort must be a list`);
  } else {
    for (const [i, spec] of tab.sort.entries()) {
      if (!isRecord(spec) || !SORT_FIELDS.has(spec.field as SortSpec["field"])) {
        problems.push(`${at}.sort[${i}] uses an unknown field`);
      } else if (spec.dir !== "asc" && spec.dir !== "desc") {
        problems.push(`${at}.sort[${i}] has an unknown direction`);
      }
    }
  }

  if (tab.limit !== null && typeof tab.limit !== "number") {
    problems.push(`${at}.limit must be a number or null`);
  }

  if (!isRecord(tab.group) || typeof tab.group.kind !== "string") {
    problems.push(`${at}.group is malformed`);
  }
  if (!isRecord(tab.display)) {
    problems.push(`${at}.display is malformed`);
  } else if (!Array.isArray(tab.display.badges)) {
    problems.push(`${at}.display.badges must be a list`);
  }
  if (!isRecord(tab.mirror) || typeof tab.mirror.enabled !== "boolean") {
    problems.push(`${at}.mirror is malformed`);
  }
  if (tab.indeterminatePolicy !== "pass" && tab.indeterminatePolicy !== "fail") {
    problems.push(`${at}.indeterminatePolicy must be "pass" or "fail"`);
  }

  return problems;
}

/**
 * Every problem with `raw`, as user-facing sentences. Empty means valid.
 *
 * Reports *all* problems rather than the first, so a user staring at a
 * restore dialog learns everything wrong with the file at once.
 */
export function validateConfig(raw: unknown): string[] {
  if (!isRecord(raw)) return ["The settings file is not an object"];

  const problems: string[] = [];

  if (typeof raw.schemaVersion !== "number") {
    problems.push("The settings file has no schema version");
  } else if (raw.schemaVersion > LIBRARY_TABS_SCHEMA_VERSION) {
    problems.push(
      `The settings file was written by a newer version of Loadout ` +
        `(schema ${raw.schemaVersion}, this build understands ${LIBRARY_TABS_SCHEMA_VERSION})`,
    );
  }

  if (!Array.isArray(raw.tabs)) {
    problems.push("The settings file has no tab list");
  } else {
    raw.tabs.forEach((tab, i) => problems.push(...tabProblems(tab, i)));
    const ids = raw.tabs
      .filter(isRecord)
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    for (const dupe of new Set(dupes)) {
      problems.push(`Two or more tabs share the id "${dupe}"`);
    }
  }

  if (!isStringArray(raw.tabOrder)) problems.push("tabOrder must be a list of tab ids");
  if (raw.defaultTabId !== null && typeof raw.defaultTabId !== "string") {
    problems.push("defaultTabId must be a tab id or null");
  }
  if (!isStringArray(raw.hiddenBuiltinTabs)) {
    problems.push("hiddenBuiltinTabs must be a list of tab ids");
  }
  if (!isRecord(raw.gameOverrides)) problems.push("gameOverrides must be an object");
  if (!Array.isArray(raw.profiles)) problems.push("profiles must be a list");

  if (!isRecord(raw.mirror)) {
    problems.push("mirror settings are missing");
  } else if (!isRecord(raw.mirror.ledger) || !Array.isArray(raw.mirror.ledger.entries)) {
    problems.push("The Steam collection ledger is malformed");
  }

  if (!isRecord(raw.settings)) problems.push("settings are missing");

  return problems;
}

// ── Salvage ────────────────────────────────────────────────────────────

/** Coerce one tab, filling defaults. Returns null if unsalvageable. */
function coerceTab(raw: unknown, index: number): Tab | null {
  if (tabProblems(raw, index).length > 0) return null;
  const t = raw as Record<string, unknown>;
  return {
    id: t.id as string,
    label: t.label as string,
    ...(typeof t.icon === "string" ? { icon: t.icon } : {}),
    visible: t.visible as boolean,
    autoHide: t.autoHide as boolean,
    ...(typeof t.builtin === "string" ? { builtin: t.builtin as BuiltinTabId } : {}),
    root: t.root as Tab["root"],
    sort: t.sort as SortSpec[],
    ...(isStringArray(t.manualOrder) ? { manualOrder: t.manualOrder } : {}),
    limit: (t.limit as number | null) ?? null,
    group: t.group as GroupSpec,
    display: {
      tileWidth:
        typeof (t.display as Record<string, unknown>).tileWidth === "number"
          ? ((t.display as Record<string, unknown>).tileWidth as number)
          : 150,
      showLabels: (t.display as Record<string, unknown>).showLabels !== false,
      badges: ((t.display as Record<string, unknown>).badges as unknown[]).filter(
        (b): b is BadgeKind => BADGE_KINDS.has(b as BadgeKind),
      ),
    },
    mirror: {
      enabled: (t.mirror as Record<string, unknown>).enabled as boolean,
      collectionName:
        typeof (t.mirror as Record<string, unknown>).collectionName === "string"
          ? ((t.mirror as Record<string, unknown>).collectionName as string)
          : (t.label as string),
    },
    indeterminatePolicy: t.indeterminatePolicy as "pass" | "fail",
  };
}

export interface CoerceResult {
  config: LibraryTabsConfig;
  /** User-facing descriptions of what had to be discarded. */
  dropped: string[];
}

/**
 * Best-effort load: keep every tab that parses, drop the rest, and say what
 * went. Losing one hand-built tab is bad; losing all of them because one was
 * corrupt is much worse, and it is the failure users are vocal about.
 *
 * A config that can't be salvaged at all falls back to defaults — which is
 * still recoverable, because `storage.ts` writes a backup before it lands.
 */
export function coerceConfig(raw: unknown): CoerceResult {
  const base = defaultConfig();
  if (!isRecord(raw)) {
    return {
      config: base,
      dropped: ["The settings file could not be read at all; starting fresh"],
    };
  }

  const dropped: string[] = [];

  const tabs: Tab[] = [];
  if (Array.isArray(raw.tabs)) {
    raw.tabs.forEach((rawTab, i) => {
      const tab = coerceTab(rawTab, i);
      if (tab) {
        tabs.push(tab);
      } else {
        const label =
          isRecord(rawTab) && typeof rawTab.label === "string"
            ? `"${rawTab.label}"`
            : `#${i + 1}`;
        dropped.push(`Tab ${label} was malformed and could not be loaded`);
      }
    });
  } else {
    dropped.push("The tab list was missing; restored the default tabs");
  }

  // Drop duplicate ids, keeping the first. Two tabs with one id breaks React
  // keys and the mirror ledger alike.
  const seen = new Set<string>();
  const deduped = tabs.filter((t) => {
    if (seen.has(t.id)) {
      dropped.push(`A second tab named "${t.label}" reused an existing id`);
      return false;
    }
    seen.add(t.id);
    return true;
  });

  const finalTabs = deduped.length > 0 ? deduped : base.tabs;
  const validIds = new Set(finalTabs.map((t) => t.id));

  const order = isStringArray(raw.tabOrder)
    ? raw.tabOrder.filter((id) => validIds.has(id))
    : [];
  // Any tab missing from the order goes on the end, so a hand-edited file
  // that forgot one doesn't make it disappear.
  for (const tab of finalTabs) if (!order.includes(tab.id)) order.push(tab.id);

  const defaultTabId =
    typeof raw.defaultTabId === "string" && validIds.has(raw.defaultTabId)
      ? raw.defaultTabId
      : null;
  if (typeof raw.defaultTabId === "string" && defaultTabId === null) {
    dropped.push("The default tab no longer exists; falling back to the first tab");
  }

  const rawMirror = isRecord(raw.mirror) ? raw.mirror : {};
  const rawLedger = isRecord(rawMirror.ledger) ? rawMirror.ledger : {};
  const ledgerEntries = Array.isArray(rawLedger.entries)
    ? rawLedger.entries.filter(
        (e): e is MirrorLedger["entries"][number] =>
          isRecord(e) &&
          typeof e.tabId === "string" &&
          typeof e.collectionId === "string" &&
          typeof e.collectionName === "string" &&
          isStringArray(e.appIds) &&
          typeof e.lastSyncedAt === "number",
      )
    : [];
  if (
    Array.isArray(rawLedger.entries) &&
    ledgerEntries.length !== rawLedger.entries.length
  ) {
    dropped.push(
      "Some Steam collection links were malformed; those collections will no longer be updated",
    );
  }

  const rawSettings = isRecord(raw.settings) ? raw.settings : {};
  const defaults = defaultSettings();

  return {
    config: {
      schemaVersion:
        typeof raw.schemaVersion === "number"
          ? raw.schemaVersion
          : LIBRARY_TABS_SCHEMA_VERSION,
      tabs: finalTabs,
      tabOrder: order,
      defaultTabId,
      hiddenBuiltinTabs: isStringArray(raw.hiddenBuiltinTabs)
        ? (raw.hiddenBuiltinTabs as BuiltinTabId[])
        : [],
      gameOverrides: isRecord(raw.gameOverrides)
        ? (raw.gameOverrides as Record<string, GameOverride>)
        : {},
      profiles: Array.isArray(raw.profiles)
        ? raw.profiles.filter(
            (p): p is TabProfile =>
              isRecord(p) &&
              typeof p.id === "string" &&
              typeof p.label === "string" &&
              isStringArray(p.appIds) &&
              isStringArray(p.tabIds),
          )
        : [],
      mirror: {
        autoSync: rawMirror.autoSync === true,
        pendingSync: rawMirror.pendingSync === true,
        ledger: { version: 1, entries: ledgerEntries },
      },
      settings: {
        defaultTileWidth:
          typeof rawSettings.defaultTileWidth === "number"
            ? rawSettings.defaultTileWidth
            : defaults.defaultTileWidth,
        showCounts: rawSettings.showCounts !== false,
        indeterminatePolicy:
          rawSettings.indeterminatePolicy === "fail" ? "fail" : "pass",
        maxBackups:
          typeof rawSettings.maxBackups === "number" && rawSettings.maxBackups > 0
            ? rawSettings.maxBackups
            : defaults.maxBackups,
        mirrorPrefix:
          typeof rawSettings.mirrorPrefix === "string"
            ? rawSettings.mirrorPrefix
            : defaults.mirrorPrefix,
      },
    },
    dropped,
  };
}

/**
 * Tabs in strip order, honouring `tabOrder` and dropping hidden builtins.
 * Shared by the UI and the mirror so the two never disagree about order.
 */
export function orderedTabs(config: LibraryTabsConfig): Tab[] {
  const byId = new Map(config.tabs.map((t) => [t.id, t] as const));
  const hidden = new Set<string>(config.hiddenBuiltinTabs);
  const out: Tab[] = [];
  for (const id of config.tabOrder) {
    const tab = byId.get(id);
    if (!tab) continue;
    byId.delete(id);
    if (tab.builtin && hidden.has(tab.builtin)) continue;
    out.push(tab);
  }
  // Anything not named in tabOrder still gets shown, at the end.
  for (const tab of byId.values()) {
    if (tab.builtin && hidden.has(tab.builtin)) continue;
    out.push(tab);
  }
  return out;
}

/** The tab that should open first. */
export function resolveDefaultTab(config: LibraryTabsConfig): Tab | null {
  const ordered = orderedTabs(config).filter((t) => t.visible);
  if (config.defaultTabId !== null) {
    const pinned = ordered.find((t) => t.id === config.defaultTabId);
    if (pinned) return pinned;
  }
  return ordered[0] ?? null;
}

/** Find an unused tab id derived from `base`. */
export function uniqueTabId(config: LibraryTabsConfig, base: string): string {
  const taken = new Set(config.tabs.map((t) => t.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

