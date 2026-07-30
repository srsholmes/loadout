#!/usr/bin/env bun
/**
 * Maintainer tool. Captures the plugin's view of a real Steam library to a
 * corpus file, so the rule and tab tests can run against thousands of real
 * games instead of ten hand-written fixtures.
 *
 *   bun run capture:corpus
 *   bun run capture:corpus -- --out ~/somewhere-else.ndjson
 *
 * **Why the corpus is captured through the plugin's own RPC** rather than by
 * reading Steam directly: the corpus has to be *definitionally* what the plugin
 * sees. A parallel reader in this script would drift from the real code path,
 * and the tests built on it would stop proving anything about the plugin. So it
 * asks `library-tabs.getSnapshot` over the loader's websocket — the same call
 * `app.tsx` makes on mount. When the `appstore` provider lands, this script
 * captures the better data with no changes at all.
 *
 * **The corpus is never committed.** It is a dump of a real library, so it goes
 * to `~/.cache/loadout/` and `.gitignore` covers the in-repo paths in case
 * someone redirects it. What *is* committed is the profile — aggregate
 * population counts with no game names — which is the reviewable record of what
 * the corpus contained and what the test floors are calibrated against.
 *
 * Read-only with respect to Steam and to the plugin's config.
 */

import type { GameMetadata, GameMetadataSnapshot } from "@loadout/types";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The loader's fixed local port — see `getUrl()` in `packages/ui/src/ws-client.ts`. */
const LOADER_ORIGIN = "http://127.0.0.1:33820";
const RPC_TIMEOUT_MS = 60_000;

/** Bumped whenever the corpus line format changes, so the loader can refuse stale files. */
export const CORPUS_SCHEMA_VERSION = 1;

export interface CorpusMeta {
  schemaVersion: number;
  capturedAt: number;
  appCount: number;
  /** Provider states at capture time — explains why a field is sparse. */
  providers: Record<string, { status: string; reason?: string }>;
}

function defaultCorpusPath(): string {
  return (
    process.env.LIBRARY_TABS_CORPUS ??
    join(homedir(), ".cache", "loadout", "library-tabs-corpus.ndjson")
  );
}

function argValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

// ── Talking to the loader ──────────────────────────────────────────────

/**
 * `/api/token` is the one unauthenticated route (`apps/loadout/src/loader/auth.ts`),
 * deliberately, so local tooling can bootstrap without scraping the webview.
 */
async function fetchToken(): Promise<string> {
  const res = await fetch(`${LOADER_ORIGIN}/api/token`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`/api/token returned ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("/api/token returned no token");
  return body.token;
}

async function callPlugin<T>(plugin: string, method: string): Promise<T> {
  const token = await fetchToken();
  const ws = new WebSocket(
    `ws://127.0.0.1:33820/ws?token=${encodeURIComponent(token)}`,
  );
  const requestId = `capture-${method}-${Date.now()}`;

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${plugin}.${method} timed out after ${RPC_TIMEOUT_MS}ms`));
    }, RPC_TIMEOUT_MS);

    ws.onopen = () => ws.send(JSON.stringify({ id: requestId, plugin, method, args: [] }));

    ws.onmessage = (event) => {
      // The socket also carries plugin event broadcasts, which arrive
      // unsolicited and can land before the reply. Match on the request id
      // rather than taking whatever shows up first.
      let frame: { id?: string; result?: T; error?: string };
      try {
        frame = JSON.parse(String(event.data)) as typeof frame;
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (frame.id !== requestId) return;

      clearTimeout(timer);
      ws.close();
      if (frame.error) reject(new Error(`${plugin}.${method}: ${frame.error}`));
      else resolve(frame.result as T);
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(
        new Error(
          `Couldn't reach the Loadout backend at ${LOADER_ORIGIN}. ` +
            "Is loadout.service running?",
        ),
      );
    };
  });
}

// ── Profiling ──────────────────────────────────────────────────────────

/**
 * Whether a field carries real information, as opposed to the sentinel that
 * means "nobody told us". `-1` is unknown for every numeric by convention
 * (`packages/types/src/game-metadata.ts`); `0` is a real answer for
 * `lastPlayed` / `playtimeMinutes` ("provably never played") and is counted.
 */
function isPopulated(game: GameMetadata, field: keyof GameMetadata): boolean {
  const value = game[field];
  if (value === undefined || value === null) return false;
  if (typeof value === "number") return value !== -1;
  // `"unknown"` is the sentinel for the compat enums, exactly as `-1` is for
  // numerics. Counting it as populated reported `deckCompat` at 100% when every
  // single value was "we don't know" — which is the opposite of the truth and
  // would have set a test floor that could never fail.
  if (typeof value === "string") return value.length > 0 && value !== "unknown";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") return Object.values(value).some(Boolean);
  return false;
}

function histogram(games: readonly GameMetadata[], field: "kind" | "source"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const game of games) {
    const key = String(game[field]);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function profileMarkdown(meta: CorpusMeta, games: readonly GameMetadata[]): string {
  const total = games.length || 1;
  const fields = Object.keys(games[0] ?? {}) as Array<keyof GameMetadata>;

  const rows = fields
    .map((field) => {
      const n = games.filter((g) => isPopulated(g, field)).length;
      return { field, n, pct: Math.round((n / total) * 100) };
    })
    .sort((a, b) => b.n - a.n || String(a.field).localeCompare(String(b.field)));

  const lines: string[] = [
    "# Library corpus profile",
    "",
    "Generated by `plugins/library-tabs/scripts/capture-library-corpus.ts`.",
    "**Aggregate counts only — this file contains no game names**, so it is safe",
    "to commit while the corpus itself stays local and gitignored.",
    "",
    "This is what the Tier-B non-degeneracy floors are calibrated against. A field",
    "at 0% is a rule that cannot possibly discriminate; that is the point of",
    "capturing it.",
    "",
    `Captured: ${new Date(meta.capturedAt).toISOString()}`,
    `Apps: **${meta.appCount}**`,
    "",
    "## Provider states at capture",
    "",
    "| Provider | Status | Reason |",
    "|---|---|---|",
    ...Object.entries(meta.providers).map(
      ([id, p]) => `| \`${id}\` | ${p.status} | ${p.reason ?? ""} |`,
    ),
    "",
    "## Field population",
    "",
    "| Field | Populated | % |",
    "|---|---:|---:|",
    ...rows.map((r) => `| \`${String(r.field)}\` | ${r.n} | ${r.pct}% |`),
    "",
    "## Kind histogram",
    "",
    "```json",
    JSON.stringify(histogram(games, "kind"), null, 2),
    "```",
    "",
    "## Source histogram",
    "",
    "```json",
    JSON.stringify(histogram(games, "source"), null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const outPath = argValue("--out") ?? defaultCorpusPath();

  process.stderr.write("Asking library-tabs for its snapshot…\n");
  const snapshot = await callPlugin<GameMetadataSnapshot>("library-tabs", "getSnapshot");

  const games = [...(snapshot.games ?? [])].sort((a, b) =>
    a.appId.localeCompare(b.appId),
  );
  if (games.length === 0) {
    throw new Error(
      "The snapshot contained no games. Is the library scanned and Steam running?",
    );
  }

  const meta: CorpusMeta = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    capturedAt: Date.now(),
    appCount: games.length,
    providers: Object.fromEntries(
      Object.entries(snapshot.providers ?? {}).map(([id, state]) => [
        id,
        { status: state.status, ...(state.reason ? { reason: state.reason } : {}) },
      ]),
    ),
  };

  // NDJSON, sorted by appId: one meta header then one game per line. Line-based
  // so a diff between two captures is readable rather than one enormous blob.
  const body = [JSON.stringify(meta), ...games.map((g) => JSON.stringify(g))].join("\n");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${body}\n`, "utf8");

  const profilePath = join(process.cwd(), "docs", "library-corpus-profile.md");
  await writeFile(profilePath, profileMarkdown(meta, games), "utf8");

  process.stderr.write(
    `\nCorpus:  ${outPath}  (${games.length} apps)\n` +
      `Profile: ${profilePath}\n\n` +
      "The corpus is deliberately NOT committed. Run `bun run test:corpus` to\n" +
      "exercise every rule and tab against it.\n",
  );
}

await main();
