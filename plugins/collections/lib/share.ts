/**
 * Exporting and importing tabs.
 *
 * TabMaster's sharing only reaches **other local users of the same device**
 * — a `visibleToOthers` flag plus a walk over its own `usersDict`. There is
 * no share code, no file, no way to post a tab in a Discord thread. Given
 * how much effort a good rule tree takes to build, that's the wrong
 * boundary. Here a tab becomes a string you can paste anywhere.
 *
 * Three safety rules, all of them learned from TabMaster's issue tracker:
 *
 * 1. **Import never overwrites.** It adds. Colliding ids and labels are
 *    suffixed. Someone else's tab must not be able to replace yours.
 * 2. **Imported tabs never arrive mirroring.** `mirror.enabled` is forced
 *    off regardless of what the envelope says, so pasting a share code
 *    cannot rewrite your Steam collections as a side effect.
 * 3. **Imports run through the migration chain first**, so a code exported
 *    from an older build still lands correctly.
 *
 * Isomorphic: pure, no I/O. Uses base64url so a code survives being pasted
 * into a URL, a YAML file or a chat client without escaping.
 */

import type { Rule, Tab } from "./types";
import type { CollectionsConfig } from "./config";
import { COLLECTIONS_SCHEMA_VERSION, uniqueTabId } from "./config";
import { migrate } from "./migrations";
import { RULE_KINDS, ruleDef } from "./rules";
import { MAX_RULE_DEPTH } from "./rule-tree";

/** Rule kinds this build can evaluate. */
const KNOWN_KINDS = new Set<string>(RULE_KINDS);

/** Discriminator, so we can reject a code meant for something else. */
export const SHARE_KIND = "loadout.collections";

export interface ShareEnvelope {
  kind: typeof SHARE_KIND;
  schemaVersion: number;
  exportedAt: number;
  tabs: Tab[];
}

/**
 * Wrap tabs for export. `exportedAt` is injected rather than read from the
 * clock so specs are deterministic.
 */
export function exportTabs(tabs: readonly Tab[], exportedAt = Date.now()): ShareEnvelope {
  return {
    kind: SHARE_KIND,
    schemaVersion: COLLECTIONS_SCHEMA_VERSION,
    exportedAt,
    // Deep clone so a later edit to a live tab can't mutate an envelope the
    // caller is still holding.
    tabs: structuredClone(tabs) as Tab[],
  };
}

// ── base64url ──────────────────────────────────────────────────────────
//
// Hand-rolled rather than pulled from Buffer: this module is bundled into
// the CEF webview, where `node:buffer` isn't available.

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeShareString(env: ShareEnvelope): string {
  const json = JSON.stringify(env);
  return toBase64Url(new TextEncoder().encode(json));
}

/**
 * Decode a share string.
 *
 * Throws with a **user-facing** message on every failure path — this is text
 * a person pasted, so "that doesn't look like a Collections code" is more
 * use than a `SyntaxError` from `JSON.parse`.
 */
export function decodeShareString(text: string): ShareEnvelope {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("Paste a share code first");

  let json: string;
  try {
    json = new TextDecoder().decode(fromBase64Url(trimmed));
  } catch {
    throw new Error("That doesn't look like a share code — it may have been truncated");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("That share code is damaged and couldn't be read");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("That share code is damaged and couldn't be read");
  }
  const env = parsed as Record<string, unknown>;

  if (env.kind !== SHARE_KIND) {
    throw new Error("That code isn't a Collections share code");
  }
  if (!Array.isArray(env.tabs) || env.tabs.length === 0) {
    throw new Error("That share code contains no tabs");
  }

  return {
    kind: SHARE_KIND,
    schemaVersion:
      typeof env.schemaVersion === "number" ? env.schemaVersion : 0,
    exportedAt: typeof env.exportedAt === "number" ? env.exportedAt : 0,
    tabs: env.tabs as Tab[],
  };
}

/**
 * Reject a tab whose rule tree this build cannot evaluate.
 *
 * A share code is input from another person, and `decodeShareString` casts
 * `env.tabs` straight to `Tab[]`. Two things got through, both fatal *after*
 * the import had been persisted:
 *
 *   - **An unknown rule kind.** `DEFS[rule.kind]` is `undefined`, so
 *     `evaluateLeaf`, `isRuleComplete` and `requiredFacts` all throw. The tab
 *     imports cleanly and then breaks the plugin permanently — exactly the
 *     forward-compat case `migrations.ts` refuses a whole file for.
 *   - **Unbounded depth.** `MAX_RULE_DEPTH` is 4 and the builder enforces it,
 *     but nothing did on this path: a 39 KB code imports a tree 501 deep, and
 *     a larger one blows the stack inside `ruleProblems` — a `RangeError`, not
 *     one of this module's user-facing errors.
 */
function unsupportedReason(rule: Rule, depth = 1): string | null {
  if (depth > MAX_RULE_DEPTH) {
    return `Its rules are nested deeper than ${MAX_RULE_DEPTH} levels`;
  }
  if (rule.kind === "group") {
    for (const child of rule.children) {
      const reason = unsupportedReason(child, depth + 1);
      if (reason) return reason;
    }
    return null;
  }
  if (!KNOWN_KINDS.has(rule.kind)) {
    return `It uses a rule this version doesn't know about ("${rule.kind}")`;
  }
  // `invert` on a kind the registry says cannot be inverted is TabMaster's
  // issue #277 — an invisible toggle that silently changes what matches,
  // with no UI to discover or clear it.
  if ("invert" in rule && rule.invert === true && ruleDef(rule.kind)?.invertible === false) {
    return `One of its rules can't be inverted ("${rule.kind}")`;
  }
  return null;
}

export interface ImportResult {
  config: CollectionsConfig;
  /** Ids of tabs actually added. */
  added: string[];
  /** `[from, to]` for each id or label we had to rename. */
  renamed: Array<[string, string]>;
  /** Tabs we refused, with a reason for each. */
  rejected: Array<{ label: string; reason: string }>;
}

/** Append " (2)", " (3)", … until the label is unused. */
function uniqueLabel(existing: Set<string>, base: string): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!existing.has(candidate)) return candidate;
  }
}

/**
 * Merge an envelope's tabs into a config.
 *
 * Always additive. Never mutates `current`.
 */
export function importTabs(
  current: CollectionsConfig,
  envelope: unknown,
): ImportResult {
  const env =
    typeof envelope === "string"
      ? decodeShareString(envelope)
      : (envelope as ShareEnvelope);

  const rejected: ImportResult["rejected"] = [];
  const renamed: ImportResult["renamed"] = [];
  const added: string[] = [];

  // Run the incoming tabs through the migration chain by wrapping them in a
  // config shell, so a code from an older build lands in today's shape.
  const shell = migrate({
    ...current,
    schemaVersion: env.schemaVersion,
    tabs: env.tabs,
    tabOrder: env.tabs.map((t) => t?.id).filter((id) => typeof id === "string"),
  });

  // `migrate` refuses a file from the future rather than coercing it, and that
  // verdict must be honoured here too. Ignoring it silently downgraded the
  // code — stripping the very fields a newer build added — which is the
  // `removeUnknownTypes` behaviour `migrations.ts` names as the thing not to
  // do.
  if (shell.refused) {
    throw new Error(
      "That share code was made by a newer version of Loadout. Update Loadout to import it.",
    );
  }

  // A share code whose tabs were all dropped leaves `coerceConfig` to
  // substitute the *current* config's tabs, so iterating them would report the
  // importer's own built-ins as rejected — five tabs the code never contained.
  const incomingIds = new Set(
    env.tabs.map((t) => (t as { id?: unknown } | null)?.id).filter((id) => typeof id === "string"),
  );
  const salvaged = shell.config.tabs.filter((t) => incomingIds.has(t.id));
  if (salvaged.length === 0) {
    return { config: current, added, renamed, rejected };
  }

  let config: CollectionsConfig = {
    ...current,
    tabs: [...current.tabs],
    tabOrder: [...current.tabOrder],
  };
  const labels = new Set(current.tabs.map((t) => t.label));

  // `shell.config.tabs` holds only the envelope's tabs — the shell overwrote
  // `tabs` before migrating — so every entry here is genuinely incoming.
  // An earlier version skipped entries matching a current tab by id+label,
  // which meant importing the same code twice silently did nothing instead
  // of creating "Mine (2)".
  for (const incoming of salvaged) {
    const unsupported = unsupportedReason(incoming.root);
    if (unsupported) {
      rejected.push({ label: incoming.label, reason: unsupported });
      continue;
    }

    if (incoming.builtin !== undefined) {
      // Builtins are defined by this build, not by a share code — importing
      // one would create a second "Installed" the user can't edit.
      rejected.push({
        label: incoming.label,
        reason: "Built-in tabs can't be imported",
      });
      continue;
    }

    const id = uniqueTabId(config, incoming.id);
    if (id !== incoming.id) renamed.push([incoming.id, id]);

    const label = uniqueLabel(labels, incoming.label);
    if (label !== incoming.label) renamed.push([incoming.label, label]);
    labels.add(label);

    const tab: Tab = {
      ...incoming,
      id,
      label,
      mirror: {
        // Forced off: importing someone's tab must never rewrite your Steam
        // collections as a side effect.
        enabled: false,
        collectionName: label,
      },
    };

    config = {
      ...config,
      tabs: [...config.tabs, tab],
      tabOrder: [...config.tabOrder, id],
    };
    added.push(id);
  }

  return { config, added, renamed, rejected };
}
