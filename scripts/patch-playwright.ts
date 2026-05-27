/**
 * Patches Playwright's transform.js to work with Bun.
 *
 * Playwright v1.58+ uses a custom Node.js ESM loader that intercepts ".esm.preflight"
 * imports. Bun doesn't support custom ESM loaders, so the preflight import fails and
 * crashes the test runner. This patch adds a .catch(() => {}) to make the preflight
 * failure non-fatal, which matches the Node.js behavior (the preflight is only used
 * to trigger the ESM loader registration — the actual import happens on the next line).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(import.meta.dir, "../node_modules/playwright/lib/transform/transform.js");

if (!existsSync(file)) {
  console.log("Playwright transform.js not found — skipping patch (playwright may not be installed).");
  process.exit(0);
}

const original = `.esm.preflight")})\`).finally(nextTask);`;
const patched = `.esm.preflight")})\`).catch(() => {}).finally(nextTask);`;

const content = readFileSync(file, "utf-8");

if (content.includes(patched)) {
  console.log("Playwright already patched for Bun compatibility.");
} else if (content.includes(original)) {
  writeFileSync(file, content.replace(original, patched));
  console.log("Patched Playwright transform.js for Bun compatibility.");
} else {
  console.warn("Could not find expected code in Playwright transform.js — patch may not be needed for this version.");
}
