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
 * 2. **Never fail a whole load over one bad collection.** `coerceConfig`
 *    salvages what parses and *reports* what it dropped, so the UI can offer
 *    a restore instead of showing an empty plugin.
 * 3. **Version from day one.** Shipping v1 with a working (if empty)
 *    migration chain means v2 is a data change, not an emergency.
 *
 * Only **managed** collections are persisted. A linked collection already
 * exists in Steam, so Steam is its source of truth; copying it here would
 * only create two records to disagree with each other.
 *
 * Isomorphic: pure, no I/O. The filesystem lives in `storage.ts`.
 */

import type {
  BadgeKind,
  ManagedCollection,
  MirrorLedger,
  SortSpec,
} from "./types";

/**
 * Bump whenever the persisted shape changes, and add a migration keyed by
 * the version being migrated *from* in `migrations.ts`.
 */
export const COLLECTIONS_SCHEMA_VERSION = 1;

export interface CollectionsSettings {
  /** Default `GameCardGrid.minTileWidth` for a new collection. */
  defaultTileWidth: number;
  showCounts: boolean;
  /** How rules whose data source could not answer are treated by default. */
  indeterminatePolicy: "pass" | "fail";
  /**
   * Optional prefix for the Steam collection names we create, for anyone who
   * wants ours visually grouped in Steam's sidebar. Empty by default —
   * a prefix makes them look bolted on rather than native.
   */
  namePrefix: string;
}

/** Per-game overrides, keyed by appId. */
export interface GameOverride {
  sortAs?: string;
  displayName?: string;
  hidden?: boolean;
}

export interface CollectionsConfig {
  schemaVersion: number;
  /** Managed collections only; linked ones are read live from Steam. */
  collections: ManagedCollection[];
  /** Explicit grid order. Ids absent from this list are appended. */
  collectionOrder: string[];
  gameOverrides: Record<string, GameOverride>;
  mirror: {
    /** Keep Steam in step automatically as collections change. */
    autoSync: boolean;
    /** A sync was wanted but Steam wasn't reachable. Retried on next load. */
    pendingSync: boolean;
    ledger: MirrorLedger;
  };
  settings: CollectionsSettings;
}

export function defaultSettings(): CollectionsSettings {
  return {
    defaultTileWidth: 150,
    showCounts: true,
    indeterminatePolicy: "pass",
    namePrefix: "",
  };
}

/**
 * A brand-new install has **no** collections.
 *
 * Deliberately empty. The previous design shipped five built-in tabs — All,
 * Installed, Recently played and so on — but those are Steam's own library
 * filters, which Steam already provides; recreating them as collections put
 * a second "All" beside Steam's and made "built-in" mean two different things
 * on one screen. The grid is not empty in practice either: it lists the
 * collections you already have in Steam.
 */
export function defaultConfig(): CollectionsConfig {
  return {
    schemaVersion: COLLECTIONS_SCHEMA_VERSION,
    collections: [],
    collectionOrder: [],
    gameOverrides: {},
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
// Hand-rolled rather than zod: the repo has no schema library, and a plugin
// config is not worth a dependency the whole bundle then carries.

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Structural problems in a rule tree.
 *
 * Deliberately shallow: it checks that the tree *is a tree* — objects, string
 * kinds, arrays where arrays belong — and leaves whether a rule kind is known
 * to `rules.ts`. A config carrying a rule this build doesn't recognise is a
 * forward-compat question, not a corrupt file.
 */
function ruleProblems(rule: unknown, at: string, depth = 1): string[] {
  if (!isRecord(rule)) return [`${at} is not an object`];
  if (typeof rule.kind !== "string") return [`${at}.kind must be a string`];
  if (depth > 8) return [`${at} is nested too deeply`];

  if (rule.kind === "group") {
    if (!Array.isArray(rule.children)) return [`${at}.children must be a list`];
    if (rule.combinator !== "all" && rule.combinator !== "any") {
      return [`${at}.combinator must be "all" or "any"`];
    }
    return rule.children.flatMap((child, i) =>
      ruleProblems(child, `${at}.children[${i}]`, depth + 1),
    );
  }
  return typeof rule.id === "string" ? [] : [`${at}.id must be a string`];
}

function collectionProblems(raw: unknown, index: number): string[] {
  const at = `collections[${index}]`;
  if (!isRecord(raw)) return [`${at} is not an object`];

  const problems: string[] = [];
  if (typeof raw.id !== "string" || raw.id === "") problems.push(`${at}.id must be a non-empty string`);
  if (typeof raw.label !== "string") problems.push(`${at}.label must be a string`);
  if (!Array.isArray(raw.sort)) problems.push(`${at}.sort must be a list`);
  if (raw.limit !== null && typeof raw.limit !== "number") {
    problems.push(`${at}.limit must be a number or null`);
  }
  if (raw.indeterminatePolicy !== "pass" && raw.indeterminatePolicy !== "fail") {
    problems.push(`${at}.indeterminatePolicy must be "pass" or "fail"`);
  }
  if (!isRecord(raw.display) || typeof raw.display.tileWidth !== "number") {
    problems.push(`${at}.display is malformed`);
  }
  problems.push(...ruleProblems(raw.root, `${at}.root`));
  return problems;
}

/**
 * Everything wrong with a config, as sentences.
 *
 * `saveConfig` runs this and **throws rather than writing** on any problem: a
 * validation failure is a bug we want loudly, not a corrupt file discovered a
 * week later.
 */
export function validateConfig(raw: unknown): string[] {
  if (!isRecord(raw)) return ["The settings file is not an object"];

  const problems: string[] = [];
  if (typeof raw.schemaVersion !== "number") problems.push("schemaVersion must be a number");
  if (typeof raw.schemaVersion === "number" && raw.schemaVersion > COLLECTIONS_SCHEMA_VERSION) {
    problems.push(
      `The settings file was written by a newer version of Loadout ` +
        `(schema ${raw.schemaVersion}, this build understands ${COLLECTIONS_SCHEMA_VERSION})`,
    );
  }

  if (!Array.isArray(raw.collections)) {
    problems.push("The settings file has no collection list");
  } else {
    raw.collections.forEach((c, i) => problems.push(...collectionProblems(c, i)));
    const ids = raw.collections
      .filter(isRecord)
      .map((c) => c.id)
      .filter((id): id is string => typeof id === "string");
    const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dupe !== undefined) problems.push(`Two or more collections share the id "${dupe}"`);
  }

  if (!isStringArray(raw.collectionOrder)) problems.push("collectionOrder must be a list of ids");
  if (!isRecord(raw.mirror)) problems.push("mirror settings are missing");
  else if (!isRecord(raw.mirror.ledger) || !Array.isArray(raw.mirror.ledger.entries)) {
    problems.push("The mirror ledger is malformed");
  }
  if (!isRecord(raw.settings)) problems.push("settings are missing");

  return problems;
}

export interface CoerceResult {
  config: CollectionsConfig;
  /** What we salvaged past, as sentences worth showing the user. */
  dropped: string[];
}

function coerceCollection(raw: Record<string, unknown>): ManagedCollection {
  const display = isRecord(raw.display) ? raw.display : {};
  return {
    id: raw.id as string,
    label: raw.label as string,
    ...(typeof raw.icon === "string" ? { icon: raw.icon } : {}),
    root: raw.root as ManagedCollection["root"],
    sort: raw.sort as SortSpec[],
    ...(isStringArray(raw.manualOrder) ? { manualOrder: raw.manualOrder } : {}),
    limit: (raw.limit as number | null) ?? null,
    display: {
      tileWidth: display.tileWidth as number,
      showLabels: display.showLabels !== false,
      badges: (isStringArray(display.badges) ? display.badges : []) as BadgeKind[],
    },
    indeterminatePolicy: raw.indeterminatePolicy as "pass" | "fail",
  };
}

/**
 * Salvage as much of a damaged config as parses, and say what was lost.
 *
 * Never throws. One malformed collection must not cost the user the other
 * nineteen, and an empty plugin with no explanation is the worst outcome of
 * all — it looks like the settings were never there.
 */
export function coerceConfig(raw: unknown): CoerceResult {
  const base = defaultConfig();
  const dropped: string[] = [];
  if (!isRecord(raw)) return { config: base, dropped: ["The settings file was unreadable"] };

  const collections: ManagedCollection[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of (Array.isArray(raw.collections) ? raw.collections : []).entries()) {
    const problems = collectionProblems(entry, i);
    if (problems.length > 0) {
      const label = isRecord(entry) && typeof entry.label === "string" ? `"${entry.label}"` : `#${i + 1}`;
      dropped.push(`Collection ${label} was malformed and could not be loaded`);
      continue;
    }
    const collection = coerceCollection(entry as Record<string, unknown>);
    if (seen.has(collection.id)) {
      // Two collections with one id breaks React keys and the mirror ledger
      // alike — the ledger would not know which one owns the Steam collection.
      dropped.push(`A second collection named "${collection.label}" reused an existing id`);
      continue;
    }
    seen.add(collection.id);
    collections.push(collection);
  }

  const order = (isStringArray(raw.collectionOrder) ? raw.collectionOrder : []).filter((id) =>
    seen.has(id),
  );
  for (const c of collections) if (!order.includes(c.id)) order.push(c.id);

  const rawMirror = isRecord(raw.mirror) ? raw.mirror : {};
  const rawLedger = isRecord(rawMirror.ledger) ? rawMirror.ledger : {};
  const entries = (Array.isArray(rawLedger.entries) ? rawLedger.entries : []).filter(
    (e): e is Record<string, unknown> =>
      isRecord(e) &&
      typeof e.managedId === "string" &&
      typeof e.steamCollectionId === "string" &&
      typeof e.steamName === "string" &&
      isStringArray(e.appIds) &&
      typeof e.lastSyncedAt === "number",
  );
  if (Array.isArray(rawLedger.entries) && entries.length !== rawLedger.entries.length) {
    // Losing a ledger row orphans a real Steam collection: nothing records
    // that it is ours, so it can never be updated or cleaned up again.
    dropped.push(
      "Some mirror records were malformed; the Steam collections they named " +
        "will no longer be updated by this plugin",
    );
  }

  const rawSettings = isRecord(raw.settings) ? raw.settings : {};
  return {
    config: {
      schemaVersion: COLLECTIONS_SCHEMA_VERSION,
      collections,
      collectionOrder: order,
      gameOverrides: isRecord(raw.gameOverrides)
        ? (raw.gameOverrides as Record<string, GameOverride>)
        : {},
      mirror: {
        autoSync: rawMirror.autoSync === true,
        pendingSync: rawMirror.pendingSync === true,
        ledger: { version: 1, entries: entries as unknown as MirrorLedger["entries"] },
      },
      settings: {
        defaultTileWidth:
          typeof rawSettings.defaultTileWidth === "number"
            ? rawSettings.defaultTileWidth
            : base.settings.defaultTileWidth,
        showCounts: rawSettings.showCounts !== false,
        indeterminatePolicy:
          rawSettings.indeterminatePolicy === "fail" ? "fail" : "pass",
        namePrefix:
          typeof rawSettings.namePrefix === "string"
            ? rawSettings.namePrefix
            : base.settings.namePrefix,
      },
    },
    dropped,
  };
}

/** Collections in grid order. Shared by the UI and the mirror so the two never disagree. */
export function orderedCollections(config: CollectionsConfig): ManagedCollection[] {
  const byId = new Map(config.collections.map((c) => [c.id, c]));
  const out: ManagedCollection[] = [];
  for (const id of config.collectionOrder) {
    const c = byId.get(id);
    if (c) out.push(c);
  }
  for (const c of config.collections) if (!config.collectionOrder.includes(c.id)) out.push(c);
  return out;
}

/** A collection id not already in use, derived from `base`. */
export function uniqueCollectionId(config: CollectionsConfig, base: string): string {
  const taken = new Set(config.collections.map((c) => c.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
