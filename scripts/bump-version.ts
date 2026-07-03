#!/usr/bin/env bun
/**
 * Set the product-level package.json versions to an exact version.
 *
 * "Product" = the repo root + the two shipped apps. Internal `packages/*` and
 * `plugins/*` are deliberately left at their own versions (private, unpublished,
 * not user-visible) — see docs/releasing.md.
 *
 * Edits only the top-level `"version"` field in place (a targeted text replace),
 * leaving all other bytes untouched — so it never reformats the file or fights
 * Prettier (e.g. the root package.json's multi-line `workspaces` array).
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

// The top-level version field. package.json lists it near the top, before any
// nested object, and none of these files have another `"version"` key, so the
// first match is always the product version.
const VERSION_RE = /"version":\s*"([^"]*)"/;

for (const rel of TARGETS) {
  const path = resolve(ROOT, rel);
  const text = await Bun.file(path).text();
  const m = text.match(VERSION_RE);
  if (!m) {
    console.error(`  ${rel}: no "version" field found — aborting`);
    process.exit(1);
  }
  const prev = m[1];
  await Bun.write(path, text.replace(VERSION_RE, `"version": "${version}"`));
  console.log(`  ${rel}: ${prev} -> ${version}`);
}
