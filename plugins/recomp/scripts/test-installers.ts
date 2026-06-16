#!/usr/bin/env bun
/**
 * Smoke-test every one-click installer in the catalog WITHOUT
 * actually downloading or building.
 *
 * Catches the bugs we kept rediscovering by clicking around: stale
 * manifests, null `releaseAssets` / `launchCommand` pairs, recipes
 * with syntax errors, recipes that throw on `globalThis.__recomp_runtime`
 * before declaring a binary, missing setup.ts for build_from_source.
 *
 * What it validates (in order):
 *   1. CATALOG SHAPE — every entry has `id`, `name`, `installType`,
 *      and the install-type-specific fields (releaseAssets for
 *      prebuilt, setup.ts for build_from_source, romInfo for
 *      rom_extract).
 *   2. PLATFORM REACHABILITY — at least one of {linux, windows,
 *      macos} declares a launchCommand AND a releaseAsset. Pure-null
 *      entries that can't be installed on any platform are flagged
 *      so they don't pollute the catalog.
 *   3. RECIPE LOAD — `build_from_source` setup.ts files import +
 *      run their top-level synchronous code without throwing.
 *      (Recipes await `sdk.ready` first, so they DON'T execute
 *      install steps when no runtime is bound — they just import.)
 *   4. ROM-MATCH — manifests declaring `romInfo.extensions` are
 *      consistent with their declared id pattern.
 *
 * Doesn't test:
 *   - Actual downloads (too slow + flaky)
 *   - Actual builds (5–30 min per game)
 *   - Steam shortcut registration (needs running Steam)
 * That stuff lives in manual end-to-end tests; CI runs just this
 * lightweight pass to keep the manifest+recipe surface honest.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { loadBundledRegistry, setupScriptPathFor } from "../lib/registry";
import { getEffectivePlatformValue, currentPlatform } from "../lib/platform";
import { suggestRomsForTitle } from "../lib/rom-suggest";
import { extractArchive } from "../lib/pipeline-archive";
import { githubToken } from "../lib/github";
import type { GameEntry } from "../lib/types";

/**
 * Set `RECOMP_TEST_DEEP=1` to enable the deep validation step:
 * actually download each prebuilt's release asset and verify the
 * launchCommand path exists inside the extracted contents. Without
 * the flag, we skip download — just parsing + reachability checks
 * (fast, no network).
 *
 * Caches downloads under `/tmp/recomp-tests/cache` keyed by asset
 * URL so re-runs are cheap. Cap per-asset at 200 MB to avoid
 * destroying disk on the heavier games.
 */
const DEEP = process.env.RECOMP_TEST_DEEP === "1";
const CACHE_DIR = "/tmp/recomp-tests/cache";
const EXTRACT_DIR = "/tmp/recomp-tests/extract";
// 400 MB so the largest legit recomps (e.g. TRX's 334 MB Linux zip)
// still get deep-verified rather than silently skipped.
const MAX_ASSET_BYTES = 400 * 1024 * 1024;

interface Result {
  id: string;
  name: string;
  installType: string;
  pass: boolean;
  /**
   * Catalog entry that intentionally isn't installable yet — a
   * prebuilt/rom_extract with no `releaseAssets` on any platform. These
   * surface upstream decomp/recomp projects for visibility; they are NOT
   * download targets, so they're reported as informational rather than
   * counted as failures (mirrors `audit-urls.ts`'s target filter).
   */
  inProgress: boolean;
  failures: string[];
}

/**
 * True for a prebuilt/rom_extract entry that declares no installable
 * `releaseAssets` on any platform. `build_from_source` (clones, no
 * download) and `toolchain` are never "in progress" in this sense.
 */
function isInProgress(g: GameEntry): boolean {
  if (g.installType === "build_from_source" || g.installType === "toolchain") {
    return false;
  }
  const ra = g.releaseAssets;
  const hasInstallableAsset =
    !!ra && Object.values(ra).some((v) => typeof v === "string" && v);
  return !hasInstallableAsset;
}

function checkCatalogShape(g: GameEntry): string[] {
  const fails: string[] = [];
  if (!g.id) fails.push("missing id");
  if (!g.name) fails.push("missing name");
  if (!g.installType) fails.push("missing installType");
  return fails;
}

function checkPlatformReachable(g: GameEntry): string[] {
  // build_from_source is reachable iff there's a recipe + repo;
  // everything else needs a releaseAsset on some platform.
  if (g.installType === "build_from_source") {
    if (!g.repo) return ["build_from_source with no repo"];
    if (setupScriptPathFor(g.id) === null) {
      return ["build_from_source with no plugins/recomp/games/<id>/setup.ts"];
    }
    return [];
  }
  const asset = getEffectivePlatformValue(g.releaseAssets ?? {});
  if (!asset) {
    return ["no releaseAsset for any platform — uninstallable on Linux"];
  }
  // Check launchCommand exists on at least one platform.
  const hasLaunch = ["linux", "windows", "macos"].some(
    (p) => !!(g.launchCommand?.[p as "linux" | "windows" | "macos"]),
  );
  if (!hasLaunch && g.installType !== "toolchain") {
    return ["no launchCommand on any platform"];
  }
  return [];
}

/**
 * Install a stub runtime on `globalThis.__recomp_runtime` before
 * importing the recipe. Every SDK call records into `calls`. After
 * the recipe's top-level await chain resolves, we assert the recipe
 * called `declareOutput()` — the absence of which would cause
 * `runSetupScript` to throw "Recipe did not call sdk.declareOutput()"
 * at install time.
 *
 * Previously this function suppressed "no recomp runtime bound" as
 * an "expected error" — which silently passed the exact class of bug
 * the test was supposed to catch (e.g. a recipe that called
 * `sdk.cloneFromGitHub(...)` at module top-level WITHOUT awaiting
 * `sdk.ready` first would import in production with a real runtime
 * and crash). The stub eliminates that hack.
 */
async function checkRecipeLoads(g: GameEntry): Promise<string[]> {
  if (g.installType !== "build_from_source") return [];
  const script = setupScriptPathFor(g.id);
  if (!script) return []; // already covered by shape check

  const calls: string[] = [];
  const noop = async () => undefined;
  const stubEnv = {
    kind: "distrobox" as const,
    label: "test-stub",
    ensurePackages: noop,
    has: async () => true,
    run: noop,
  };
  const stubSdk = {
    installDir: "/tmp/recomp-test-stub",
    romPath: "/tmp/recomp-test-stub/rom.z64",
    platform: "linux" as const,
    id: g.id,
    env: stubEnv,
    ready: Promise.resolve(),
    cloneFromGitHub: async (...a: unknown[]) => { calls.push(`cloneFromGitHub(${JSON.stringify(a)})`); },
    placeRom: async (...a: unknown[]) => { calls.push(`placeRom(${JSON.stringify(a)})`); },
    declareOutput: (p: string) => { calls.push(`declareOutput(${p})`); },
    declareLaunchCommand: (c: string) => { calls.push(`declareLaunchCommand(${c})`); },
    declarePlatform: (p: string) => { calls.push(`declarePlatform(${p})`); },
    reportVersion: (v: string) => { calls.push(`reportVersion(${v})`); },
    progress: () => undefined,
    writeLauncher: async (opts: unknown) => {
      calls.push(`writeLauncher(${JSON.stringify(opts)})`);
      return "/tmp/recomp-test-stub/launcher.sh";
    },
  };

  const slot = globalThis as unknown as { __recomp_runtime?: unknown };
  const prev = slot.__recomp_runtime;
  slot.__recomp_runtime = { sdk: stubSdk };
  try {
    await import(`${script}?test=${Date.now()}`);
  } catch (err) {
    return [
      `recipe import threw: ${err instanceof Error ? err.message : String(err)}`.slice(
        0,
        200,
      ),
    ];
  } finally {
    slot.__recomp_runtime = prev;
  }

  if (!calls.some((c) => c.startsWith("declareOutput"))) {
    return [
      `recipe completed without calling sdk.declareOutput() — install will fail. SDK calls observed: ${calls.join(", ") || "(none)"}`,
    ];
  }
  return [];
}

function checkRomInfoSanity(g: GameEntry): string[] {
  if (!g.romInfo) return [];
  const fails: string[] = [];
  const exts = g.romInfo.extensions ?? [];
  // Extensions should be lowercase and not contain leading dots; the
  // rom-suggest walker normalizes both but other code paths might not.
  for (const ext of exts) {
    if (ext.startsWith(".")) fails.push(`romInfo.extension "${ext}" has leading dot`);
    if (ext !== ext.toLowerCase()) fails.push(`romInfo.extension "${ext}" not lowercased`);
  }
  return fails;
}

async function checkRomSuggesterOnTitle(g: GameEntry): Promise<string[]> {
  // We don't have a fixture ROM directory in CI, so this is best-
  // effort: only run when a romDirectory env var is set. Locally
  // this catches "the matcher returns 0 results for a game I have
  // the ROM for" before it surfaces in the UI.
  const dir = process.env.RECOMP_TEST_ROM_DIR;
  if (!dir || !existsSync(dir)) return [];
  if (!g.romInfo?.extensions || g.romInfo.extensions.length === 0) return [];
  try {
    const hits = await suggestRomsForTitle(g.name, dir, g.romInfo.extensions);
    if (hits.length === 0) return ["rom-suggest found no matches in test dir"];
    return [];
  } catch (err) {
    return [`rom-suggest threw: ${err instanceof Error ? err.message : String(err)}`];
  }
}

/**
 * Deep validation: download the prebuilt's release asset, extract
 * it, verify the launchCommand basename exists in the extracted
 * tree. Catches stale manifests (e.g. "soh.elf" expected, but the
 * release ships "soh.appimage" — the real bug that bit Ship of
 * Harkinian and 2 Ship 2 Harkinian).
 *
 * Only runs when RECOMP_TEST_DEEP=1. Skips:
 *   - build_from_source (no release asset)
 *   - games without a launchCommand on the current host platform
 *     (Windows-only via Proton — verifying would need a wineprefix)
 *   - assets > MAX_ASSET_BYTES
 *
 * Caches downloads under CACHE_DIR keyed by asset name so repeat
 * runs are cheap (the second pass for a 70 MB SoH zip is <1 s).
 */
async function checkReleaseShape(g: GameEntry): Promise<string[]> {
  if (!DEEP) return [];
  if (g.installType === "build_from_source") return [];
  // Skip entries explicitly marked work-in-progress / wip. The UI
  // already greys them out so users can't install — running the
  // deep-check would just clutter the output with "expected X,
  // found libs/" noise we already know about.
  if (g.status === "in_progress" || g.status === "wip") return [];
  const platform = currentPlatform();
  const pattern = g.releaseAssets?.[platform];
  const launchTemplate = g.launchCommand?.[platform];
  if (!pattern || !launchTemplate) return []; // covered by reachability check
  if (!g.repo) return ["deep-check: no repo to query for releases"];

  // Resolve the actual release asset list. Use the same auth token
  // the pipeline does so we get 5000 req/h instead of the
  // unauthenticated 60 (we'd 403 within seconds otherwise testing
  // every entry in the catalog).
  const apiUrl = `https://api.github.com/repos/${g.repo}/releases/latest`;
  let assets: Array<{ name: string; browser_download_url: string; size: number }>;
  try {
    const headers: Record<string, string> = {
      "User-Agent": "recomp-test-installers/0.1",
      Accept: "application/vnd.github+json",
    };
    const token = await githubToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) return [`deep-check: GitHub API ${res.status} for ${g.repo}`];
    const release = (await res.json()) as { assets?: typeof assets };
    assets = release.assets ?? [];
  } catch (err) {
    return [`deep-check: fetch failed: ${err instanceof Error ? err.message : err}`];
  }

  // Match the asset-pattern glob — same simple translation the
  // pipeline uses (* → .*), case-insensitive to match the pipeline's
  // globMatches behaviour (lib/glob.ts lowercases both sides).
  const regex = new RegExp(
    "^" +
      pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
      "$",
    "i",
  );
  const matched = assets.find((a) => regex.test(a.name));
  if (!matched) {
    return [
      `deep-check: no release asset matches pattern '${pattern}' (available: ${assets.map((a) => a.name).join(", ")})`,
    ];
  }
  if (matched.size > MAX_ASSET_BYTES) {
    return [
      `deep-check: asset ${matched.name} (${(matched.size / 1024 / 1024).toFixed(0)} MB) exceeds cap; skipping download`,
    ];
  }

  // Download (cached). Per-game subdir keeps cached files namespaced
  // (two games can release files with the same name like
  // "release.zip") without prepending an id to the filename — which
  // would otherwise corrupt the AppImage basename check below.
  const gameCacheDir = join(CACHE_DIR, g.id);
  mkdirSync(gameCacheDir, { recursive: true });
  const cachePath = join(gameCacheDir, matched.name);
  if (!existsSync(cachePath)) {
    const dl = spawnSync("curl", [
      "-fsSL",
      "-o",
      cachePath,
      matched.browser_download_url,
    ]);
    if (dl.status !== 0) {
      return [`deep-check: download failed (curl exit ${dl.status})`];
    }
  }

  // Extract + check the launchCommand basename is present
  const extractAt = join(EXTRACT_DIR, g.id);
  rmSync(extractAt, { recursive: true, force: true });
  mkdirSync(extractAt, { recursive: true });
  // Mirror pipeline.ts's extractArchive call exactly. For AppImage
  // releases, the pipeline derives an `appimageBasename` from the
  // launchCommand and renames the copied file to that — so the
  // post-install on-disk filename ALWAYS matches what launchCommand
  // expects, even when the upstream asset has a versioned name like
  // `Dusklight-v1.2.0-linux-x86_64.AppImage`. Test has to use the
  // same derivation or we'd false-positive these games.
  const appimageBasename = cachePath.toLowerCase().endsWith(".appimage")
    ? basename(
        launchTemplate.replace(/^\{installDir\}\//, "").split(/\s+/)[0]!,
      )
    : undefined;
  try {
    await extractArchive(cachePath, extractAt, appimageBasename);
  } catch (err) {
    return [
      `deep-check: extractArchive failed: ${err instanceof Error ? err.message : err}`,
    ];
  }

  // The launchCommand template looks like "{installDir}/foo.elf args".
  // Take the executable basename (post-{installDir}/, pre-whitespace)
  // and confirm it lives somewhere in the extracted tree. Doesn't
  // matter at what depth — pipeline extracts flat into installDir.
  const exeBase = basename(
    launchTemplate.replace(/^\{installDir\}\//, "").split(/\s+/)[0]!,
  );
  function walk(dir: string): string[] {
    const out: string[] = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  }
  const allFiles = walk(extractAt);
  const found = allFiles.some((f) => basename(f).toLowerCase() === exeBase.toLowerCase());
  if (!found) {
    const sample = allFiles
      .slice(0, 8)
      .map((f) => f.replace(extractAt + "/", ""))
      .join(", ");
    return [
      `deep-check: launchCommand expects '${exeBase}' but it's not in the extracted release. Files (sample): ${sample}`,
    ];
  }
  return [];
}

async function testEntry(g: GameEntry): Promise<Result> {
  const inProgress = isInProgress(g);
  // In-progress entries are intentionally not installable yet, so skip
  // the reachability / release-shape checks that would (correctly) report
  // "no asset" — that's the whole point of the entry, not a defect. Still
  // validate catalog shape + ROM-info sanity so a malformed in-progress
  // entry is caught.
  const failures: string[] = inProgress
    ? [...checkCatalogShape(g), ...checkRomInfoSanity(g)]
    : [
        ...checkCatalogShape(g),
        ...checkPlatformReachable(g),
        ...checkRomInfoSanity(g),
        ...(await checkRecipeLoads(g)),
        ...(await checkRomSuggesterOnTitle(g)),
        ...(await checkReleaseShape(g)),
      ];
  return {
    id: g.id,
    name: g.name,
    installType: g.installType,
    pass: failures.length === 0,
    inProgress,
    failures,
  };
}

async function main(): Promise<void> {
  const registry = loadBundledRegistry();

  // Argument filter: `bun run … <id-substring>` to focus.
  const filter = process.argv[2]?.toLowerCase();
  const entries = filter
    ? registry.filter(
        (g) =>
          g.id.toLowerCase().includes(filter) ||
          g.name.toLowerCase().includes(filter),
      )
    : registry;

  console.log(`Testing ${entries.length} installer(s)…\n`);
  const results: Result[] = [];
  for (const g of entries) {
    results.push(await testEntry(g));
  }

  // Three honest buckets. Only `broken` — an entry that CLAIMS to be
  // installable but fails a check — is a real defect that should fail
  // the run. In-progress entries are informational.
  const broken = results.filter((r) => !r.inProgress && !r.pass);
  const inProgress = results.filter((r) => r.inProgress);
  const installable = results.filter(
    (r) => !r.inProgress && r.installType !== "build_from_source",
  );
  const fromSource = results.filter(
    (r) => !r.inProgress && r.installType === "build_from_source",
  );

  console.log("── Summary ──");
  console.log(
    `  installable (prebuilt/rom_extract): ${installable.filter((r) => r.pass).length}/${installable.length} verified`,
  );
  console.log(
    `  build_from_source:                  ${fromSource.filter((r) => r.pass).length}/${fromSource.length} ok`,
  );
  console.log(
    `  in-progress (not installable yet):  ${inProgress.length} (informational)`,
  );
  console.log(`  BROKEN (claims installable, fails):  ${broken.length}`);

  if (broken.length === 0) {
    console.log("\n  ✓ no broken entries — every claimed installer is in good shape");
  } else {
    console.log("\n── Broken entries ──");
    for (const r of broken) {
      console.log(`\n  ✗ ${r.id} (${r.installType}) — ${r.name}`);
      for (const f of r.failures) console.log(`      • ${f}`);
    }
  }

  console.log(
    `\n${results.length} entries: ${installable.filter((r) => r.pass).length} installable verified, ${inProgress.length} in-progress, ${broken.length} broken`,
  );
  process.exit(broken.length === 0 ? 0 : 1);
}

await main();
