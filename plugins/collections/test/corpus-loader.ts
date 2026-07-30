/**
 * Loads the captured library corpus for the Tier-B tests.
 *
 * **This is not a replacement for `fixtures/library.ts`.** The two have
 * different jobs and must not drift into each other:
 *
 * - The 10-record fixture is for **exact-count** unit tests. It is hand-written,
 *   every field is populated, and asserting `matched.length === 3` against it is
 *   correct and stable.
 * - The corpus is for **properties**. It is a real library of thousands of apps
 *   where most fields are sparse, and no assertion against it may name an exact
 *   count — only floors, fractions and relations. That is what makes it survive
 *   a re-capture while still catching a rule that has no data behind it.
 *
 * The corpus is captured by `scripts/capture-library-corpus.ts` and lives
 * outside the repo (see that file for why). Tests that need it are named
 * `*.corpus.spec.ts` and run via `bun run test:corpus`, never in CI.
 */

import type { GameMetadata } from "@loadout/types";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildEvalGames } from "../lib/facts";
import type { EvalGame } from "../lib/types";

/** Must match `CORPUS_SCHEMA_VERSION` in the capture script. */
const EXPECTED_SCHEMA_VERSION = 1;

export interface CorpusMeta {
  schemaVersion: number;
  capturedAt: number;
  appCount: number;
  providers: Record<string, { status: string; reason?: string }>;
}

/** Fields a probe rule can pick a representative value from. */
export type SetField = "storeTags" | "genres" | "developers" | "publishers" | "collections";
/** Fields a probe rule can split on. */
export type NumericField =
  | "releaseDate"
  | "playtimeMinutes"
  | "sizeOnDisk"
  | "lastPlayed"
  | "purchasedAt"
  | "reviewPercentage"
  | "metacritic";

export interface Corpus {
  meta: CorpusMeta;
  games: readonly GameMetadata[];
  evalGames: readonly EvalGame[];
  size: number;
  /** How many games carry a real value for this field (sentinels excluded). */
  populated(field: keyof GameMetadata): number;
  /** The most common member of a set-valued field, or null when none exist. */
  topValue(field: SetField): string | null;
  /**
   * A threshold that splits the library as evenly as this field allows.
   *
   * Deliberately not the plain median: 96% of a real library is non-Steam
   * shortcuts with `sizeOnDisk: 0`, so the median is 0 and `min: 0` matches
   * everything — which reads as "the size rule is broken" when it is the probe
   * that is useless. This scans the distinct populated values and picks the one
   * whose `>=` share is closest to half.
   *
   * `null` when nothing is populated, which is itself the signal that the rule
   * cannot discriminate on this corpus.
   */
  splitPoint(field: NumericField): number | null;
}

function corpusPath(): string {
  return (
    process.env.COLLECTIONS_CORPUS ??
    join(homedir(), ".cache", "loadout", "collections-corpus.ndjson")
  );
}

/** Mirrors the capture script's sentinel rules — see the note there about `"unknown"`. */
function isPopulated(game: GameMetadata, field: keyof GameMetadata): boolean {
  const value = game[field];
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return value !== -1;
  if (typeof value === "string") return value.length > 0 && value !== "unknown";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") return Object.values(value).some(Boolean);
  return false;
}

let cached: Corpus | null = null;

export function corpusExists(): boolean {
  return existsSync(corpusPath());
}

/**
 * Parse the corpus. Cached per module instance — with `--isolate` that means
 * once per spec file, which is fine for a handful of files but is the reason
 * not to grow to twenty.
 */
export function loadCorpus(): Corpus {
  if (cached) return cached;

  const path = corpusPath();
  if (!existsSync(path)) {
    throw new Error(
      `No library corpus at ${path}.\n\n` +
        "Capture one on a device with Steam running:\n" +
        "  bun run capture:corpus\n\n" +
        "Or point COLLECTIONS_CORPUS at an existing capture.",
    );
  }

  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const [header, ...rest] = lines;
  if (!header) throw new Error(`${path} is empty`);

  const meta = JSON.parse(header) as CorpusMeta;
  if (meta.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `Corpus at ${path} is schema v${meta.schemaVersion}, expected ` +
        `v${EXPECTED_SCHEMA_VERSION}. Re-run: bun run capture:corpus`,
    );
  }

  const games = rest.map((line) => JSON.parse(line) as GameMetadata);
  if (games.length === 0) throw new Error(`${path} has a header but no games`);

  // No facts bag, deliberately: it mirrors what `app.tsx` actually does today
  // (`buildEvalGames(snapshot?.games ?? [])`), which is precisely why every
  // fact-backed rule evaluates indeterminate in the real UI.
  const evalGames = buildEvalGames(games);

  const populatedCache = new Map<string, number>();

  cached = {
    meta,
    games,
    evalGames,
    size: games.length,

    populated(field) {
      const key = String(field);
      const hit = populatedCache.get(key);
      if (hit !== undefined) return hit;
      const n = games.filter((g) => isPopulated(g, field)).length;
      populatedCache.set(key, n);
      return n;
    },

    topValue(field) {
      const counts = new Map<string, number>();
      for (const game of games) {
        for (const value of game[field] ?? []) {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
      let best: string | null = null;
      let bestCount = 0;
      for (const [value, count] of counts) {
        if (count > bestCount) {
          best = value;
          bestCount = count;
        }
      }
      return best;
    },

    splitPoint(field) {
      const values = games
        .map((g) => g[field])
        .filter((v): v is number => typeof v === "number" && v !== -1)
        .sort((a, b) => a - b);
      if (values.length === 0) return null;

      // Walk the distinct values; for each, the count at or above it is the
      // remaining tail. Pick whichever lands closest to an even split of the
      // WHOLE corpus (not just the populated subset) — a rule is judged against
      // every game it will be shown to.
      let best = values[0] ?? null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value === undefined) continue;
        if (i > 0 && value === values[i - 1]) continue; // distinct values only
        const distance = Math.abs((values.length - i) / games.length - 0.5);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = value;
        }
      }
      return best;
    },
  };

  return cached;
}
