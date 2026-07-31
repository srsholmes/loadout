/**
 * Merge the generated baseline (`plugins/<id>/agent.json`) with the
 * hand-written curation (`package.json → plugin.agent`) into the shape
 * the `/api/agent` routes serve.
 *
 * Pure: no filesystem, no network, no clock. Everything the merge needs
 * arrives as an argument, so the whole module is directly unit-testable
 * and the route layer stays a thin adapter.
 */

import type {
  AgentDoc,
  AgentIndexEntry,
  AgentManifest,
  AgentMethodDoc,
  AgentSafety,
} from "@loadout/types";

/** Generator output-format version. Bump when `AgentDoc`'s shape changes. */
export const AGENT_DOC_VERSION = 1;

/**
 * Method-name prefixes we treat as read-only when nobody has curated an
 * explicit safety class.
 *
 * The alternative — defaulting every uncurated method to `write` — is
 * more conservative on paper but worse in practice: it marks all ~450
 * methods across the shipped plugins as gated, so the first thing anyone
 * would do is switch the write gate off wholesale, which is strictly
 * worse than a good-enough default. These prefixes are the ones that are
 * unambiguously observational in this codebase.
 *
 * Deliberately excluded as too ambiguous to guess at: `check*` and
 * `scan*` (may cache or write state), `start*`, `apply*`, `set*`,
 * `toggle*`, `install*`, `remove*` — those all fall through to `write`.
 *
 * Anything inferred here is flagged `safetyInferred: true` and rendered
 * as "inferred" in the docs, so a reader can tell a guess from a
 * declaration. Curating a method always wins over the heuristic.
 */
const READ_PREFIXES = ["get", "list", "read", "fetch", "search", "query", "find", "is", "has"];

/**
 * Best-effort safety class for a method nobody has curated.
 * Conservative by default — `write` unless the name is clearly a getter.
 */
export function inferSafety(methodName: string): AgentSafety {
  for (const prefix of READ_PREFIXES) {
    if (!methodName.startsWith(prefix)) continue;
    // `getX` matches; `gettable` shouldn't. Require the prefix to end at
    // a camelCase boundary so we're keying on a real verb.
    const rest = methodName.slice(prefix.length);
    if (rest === "" || rest[0] === rest[0]?.toUpperCase()) return "read";
  }
  return "write";
}

/**
 * A name-only baseline, for a plugin with no generated `agent.json` —
 * a third-party plugin, or one added since docs were last generated.
 *
 * Types are unknown here by construction: the names come from reflecting
 * over the live instance, and a runtime function object carries no
 * parameter type information. Saying so explicitly (`type: "unknown"`)
 * is the point — an agent learns the method exists and that its
 * signature is undocumented, rather than being told nothing at all.
 */
export function baselineFromMethodNames(id: string, names: string[]): AgentDoc {
  return {
    id,
    generatorVersion: AGENT_DOC_VERSION,
    methods: names.map((name) => ({
      name,
      args: [],
      returns: { type: "unknown", tsType: "unknown" },
      safety: inferSafety(name),
      safetyInferred: true,
      notes:
        "Signature not documented — this plugin has no generated agent.json, " +
        "so argument types are unknown. Check the plugin's backend.ts.",
    })),
  };
}

export interface ResolvedPluginDoc {
  id: string;
  name: string;
  summary: string;
  category?: string;
  status: "loaded" | "disabled" | "error";
  methods: AgentMethodDoc[];
  events: NonNullable<AgentDoc["events"]>;
  /** True when no generated baseline was available and names were reflected. */
  degraded: boolean;
}

export interface MergeArgs {
  meta: {
    id: string;
    name: string;
    description?: string;
    category?: string;
    agent?: AgentManifest;
  };
  status: "loaded" | "disabled" | "error";
  /** Parsed `plugins/<id>/agent.json`, when present. */
  baseline?: AgentDoc;
  /** Live method names, used only when `baseline` is absent. */
  methodNames?: string[];
}

/**
 * Produce the full documentation for one plugin.
 *
 * Curation is merged *over* the baseline field by field, so a plugin can
 * curate one method's description without restating its signature — the
 * generated types stay authoritative for shape, the manifest stays
 * authoritative for meaning.
 */
export function mergePluginDoc({
  meta,
  status,
  baseline,
  methodNames = [],
}: MergeArgs): ResolvedPluginDoc {
  const degraded = !baseline;
  const doc = baseline ?? baselineFromMethodNames(meta.id, methodNames);
  const curation = meta.agent?.methods ?? {};

  const methods = doc.methods
    .filter((m) => !curation[m.name]?.hidden)
    .map((m): AgentMethodDoc => {
      const c = curation[m.name];
      // An explicitly curated safety class is a declaration; anything
      // else is a guess, and the flag says which.
      const declared = c?.safety;
      return {
        ...m,
        description: c?.description ?? m.description,
        safety: declared ?? m.safety ?? inferSafety(m.name),
        safetyInferred: declared === undefined,
        example: c?.example ?? m.example,
        notes: c?.notes ?? m.notes,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    id: meta.id,
    name: meta.name,
    summary: meta.agent?.summary ?? meta.description ?? "",
    category: meta.category,
    status,
    methods,
    events: doc.events ?? [],
    degraded,
  };
}

/** Count a plugin's methods by safety class, for the index. */
export function countBySafety(methods: AgentMethodDoc[]): Record<AgentSafety, number> {
  const counts: Record<AgentSafety, number> = {
    read: 0,
    write: 0,
    destructive: 0,
  };
  for (const m of methods) counts[m.safety]++;
  return counts;
}

/** Collapse a resolved doc into its one-line index entry. */
export function toIndexEntry(doc: ResolvedPluginDoc): AgentIndexEntry {
  return {
    id: doc.id,
    name: doc.name,
    summary: doc.summary,
    category: doc.category,
    status: doc.status,
    methodCounts: countBySafety(doc.methods),
    href: `/api/agent/${encodeURIComponent(doc.id)}`,
  };
}

/**
 * Whether a call to this method needs the caller to have opted into
 * writes. Reads never do; everything else always does — including a
 * method whose `read` class was only inferred is *not* gated, since the
 * heuristic above is deliberately narrow.
 */
export function requiresWriteOptIn(method: AgentMethodDoc): boolean {
  return method.safety !== "read";
}
