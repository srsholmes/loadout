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

import type { Tab } from "./types";
import type { CollectionsConfig } from "./config";
import { COLLECTIONS_SCHEMA_VERSION, uniqueTabId } from "./config";
import { migrate } from "./migrations";

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
  for (const incoming of shell.config.tabs) {
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
