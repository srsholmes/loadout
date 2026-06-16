#!/usr/bin/env bun
/**
 * Audit every catalog entry's DOWNLOAD resolution against the live
 * GitHub API — the thing `test-installers.ts` deliberately skips.
 *
 * For each prebuilt / rom_extract game it checks:
 *   1. that it declares a releaseAssets pattern for at least one platform
 *   2. that the repo exists and has a non-prerelease release
 *   3. that the latest release actually contains an asset matching the
 *      glob for linux (preferred) or windows (Proton fallback)
 *
 * build_from_source entries are skipped (they clone, not download).
 *
 * Usage:  bun run plugins/recomp/scripts/audit-urls.ts [--all] [--json]
 *   --all   also list PASS rows (default: only failures + summary)
 *   --json  emit machine-readable JSON
 *
 * Auth: uses `gh auth token` if available (5000 req/h), else
 * unauthenticated (60 req/h — will rate-limit on the full catalog).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const showAll = process.argv.includes("--all");
const asJson = process.argv.includes("--json");

const ghToken = (() => {
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
})();
const authHeaders: Record<string, string> = {
  Accept: "application/vnd.github+json",
  ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
};

function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

interface Game {
  id: string;
  name: string;
  repo: string;
  installType: string;
  releaseAssets?: Record<string, string | null>;
}

type Result = { id: string; repo: string; ok: boolean; reason: string };

const games: Game[] = JSON.parse(
  await Bun.file(join(ROOT, "games.json")).text(),
).games;

// Only audit entries that CLAIM to be installable — i.e. declare at
// least one releaseAssets pattern. Entries with empty releaseAssets are
// intentional "in progress / not installable yet" catalog entries (they
// surface upstream decomp/recomp projects for visibility); they're not
// download targets, so auditing them as broken would be noise.
const targets = games.filter(
  (g) =>
    (g.installType === "prebuilt" || g.installType === "rom_extract") &&
    g.releaseAssets &&
    Object.values(g.releaseAssets).some((v) => typeof v === "string" && v),
);

async function check(g: Game): Promise<Result> {
  const assets = g.releaseAssets ?? {};
  const pattern = assets.linux || assets.windows || assets.macos;
  if (!pattern) {
    return { id: g.id, repo: g.repo, ok: false, reason: "no releaseAssets declared" };
  }
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${g.repo}/releases?per_page=20`, {
      headers: authHeaders,
    });
  } catch (e) {
    return { id: g.id, repo: g.repo, ok: false, reason: `network: ${e}` };
  }
  if (res.status === 404) {
    return { id: g.id, repo: g.repo, ok: false, reason: "repo 404 (moved/deleted)" };
  }
  if (!res.ok) {
    return { id: g.id, repo: g.repo, ok: false, reason: `GitHub API ${res.status}` };
  }
  const releases = (await res.json()) as Array<{
    prerelease: boolean;
    assets: Array<{ name: string }>;
  }>;
  const rel = releases.find((r) => !r.prerelease) ?? releases[0];
  if (!rel) {
    return { id: g.id, repo: g.repo, ok: false, reason: "no releases published" };
  }
  // Check linux first, then windows, then macos — whichever is declared.
  for (const plat of ["linux", "windows", "macos"] as const) {
    const pat = assets[plat];
    if (!pat) continue;
    if (rel.assets.some((a) => globToRe(pat).test(a.name))) {
      return { id: g.id, repo: g.repo, ok: true, reason: `matched ${plat}` };
    }
  }
  return {
    id: g.id,
    repo: g.repo,
    ok: false,
    reason: `no asset matches '${pattern}' in latest release`,
  };
}

// Bounded concurrency so we don't hammer the API.
const CONCURRENCY = 8;
const results: Result[] = [];
for (let i = 0; i < targets.length; i += CONCURRENCY) {
  const batch = targets.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(check))));
  if (!asJson) process.stderr.write(`\r  audited ${results.length}/${targets.length}…`);
}
if (!asJson) process.stderr.write("\n");

const fails = results.filter((r) => !r.ok);
const passes = results.filter((r) => r.ok);

if (asJson) {
  console.log(JSON.stringify({ total: results.length, pass: passes.length, fail: fails.length, fails }, null, 2));
} else {
  if (showAll) for (const r of passes) console.log(`PASS  ${r.id}  (${r.repo})  — ${r.reason}`);
  console.log("\n── FAILURES ──");
  // Group by reason for readability.
  const byReason = new Map<string, Result[]>();
  for (const r of fails) {
    const key = r.reason.replace(/'[^']*'/, "'…'");
    (byReason.get(key) ?? byReason.set(key, []).get(key)!).push(r);
  }
  for (const [reason, rs] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n[${rs.length}] ${reason}`);
    for (const r of rs.slice(0, 12)) console.log(`    ${r.id}  (${r.repo})`);
    if (rs.length > 12) console.log(`    … +${rs.length - 12} more`);
  }
  console.log(`\n── SUMMARY ──  ${passes.length} installable / ${results.length} prebuilt+rom_extract  (${fails.length} broken)`);
}
