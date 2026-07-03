#!/usr/bin/env bun
/**
 * Set the product-level package.json versions to an exact version.
 *
 * "Product" = the repo root + the two shipped apps. Internal `packages/*` and
 * `plugins/*` are deliberately left at their own versions (private, unpublished,
 * not user-visible) — see docs/releasing.md.
 *
 * Called by scripts/release.sh; runnable directly:
 *   bun scripts/bump-version.ts <X.Y.Z>
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`usage: bun scripts/bump-version.ts <X.Y.Z> (got: ${version ?? "nothing"})`);
  process.exit(1);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["package.json", "apps/loadout/package.json", "apps/loadout-overlay/package.json"];

for (const rel of TARGETS) {
  const path = resolve(ROOT, rel);
  const pkg = JSON.parse(await Bun.file(path).text()) as {
    version?: string;
    [k: string]: unknown;
  };
  const prev = pkg.version ?? "(none)";
  pkg.version = version;
  // 2-space indent + trailing newline to match the repo's existing package.json
  // formatting (and Prettier).
  await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  ${rel}: ${prev} -> ${version}`);
}
