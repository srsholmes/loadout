#!/usr/bin/env bun
/**
 * Regenerate `plugins/<id>/agent.json` for every plugin with a backend,
 * and the repo-root `AGENTS.md` discovery file.
 *
 * These artefacts are committed rather than built on the user's device:
 * the generator needs the TypeScript compiler API, and the compiled
 * loader binary doesn't ship `typescript`. `scripts/prepare-plugins.sh`
 * copies whole plugin directories to the install root, so a committed
 * `agent.json` ships with no packaging change.
 *
 * Usage:
 *   bun scripts/generate-agent-docs.ts           # write
 *   bun scripts/generate-agent-docs.ts --check   # verify only, non-zero on drift
 *
 * `--check` is what CI runs (`bun run check:agent-docs`). Regenerating
 * and diffing is the whole freshness story: docs cannot go stale without
 * failing the build.
 */

import ts from "typescript";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateForBackend, loadCompilerOptions, serializeDoc } from "./agent-doc-gen";
import { renderAgentsMd } from "./agents-md";

const ROOT = new URL("..", import.meta.url).pathname;
const PLUGINS_DIR = join(ROOT, "plugins");
const CHECK_ONLY = process.argv.includes("--check");

interface PluginEntry {
  id: string;
  dir: string;
  backendPath: string;
}

/**
 * Plugin id comes from the manifest, not the directory name — they're
 * conventionally the same but the manifest is what the loader keys on,
 * and `agent.json` has to match so the route can find it.
 */
function discover(): PluginEntry[] {
  const entries: PluginEntry[] = [];
  for (const name of readdirSync(PLUGINS_DIR)) {
    const dir = join(PLUGINS_DIR, name);
    const backendPath = join(dir, "backend.ts");
    if (!existsSync(backendPath)) continue;

    let id = name;
    const pkgPath = join(dir, "package.json");
    const pluginJsonPath = join(dir, "plugin.json");
    try {
      if (existsSync(pluginJsonPath)) {
        id = JSON.parse(readFileSync(pluginJsonPath, "utf8")).id ?? name;
      } else if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (!pkg.plugin) continue;
        id = pkg.plugin.id ?? name;
      } else {
        continue;
      }
    } catch {
      console.warn(`skip ${name}: unreadable manifest`);
      continue;
    }
    entries.push({ id, dir, backendPath });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

function main(): void {
  const plugins = discover();
  if (plugins.length === 0) {
    console.error("No plugins with a backend.ts found — is the tree intact?");
    process.exit(1);
  }

  // One program over every backend at once. Building 25 separate programs
  // would re-parse the whole @loadout/* graph each time; this takes a few
  // seconds total instead of a few minutes.
  const options = loadCompilerOptions(ROOT);
  const program = ts.createProgram(
    plugins.map((p) => p.backendPath),
    options,
  );

  const stale: string[] = [];
  const warnings: string[] = [];
  let written = 0;

  for (const plugin of plugins) {
    const result = generateForBackend(program, plugin.id, plugin.backendPath);
    if (!result) {
      warnings.push(`${plugin.id}: backend.ts not in program — skipped`);
      continue;
    }
    warnings.push(...result.warnings);

    const outPath = join(plugin.dir, "agent.json");
    const next = serializeDoc(result.doc);
    const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";

    if (current === next) continue;
    if (CHECK_ONLY) {
      stale.push(`plugins/${plugin.id}/agent.json`);
      continue;
    }
    writeFileSync(outPath, next);
    written++;
    console.log(
      `${plugin.id}: ${result.doc.methods.length} method(s)${
        result.doc.events?.length ? `, ${result.doc.events.length} event(s)` : ""
      }`,
    );
  }

  // AGENTS.md is static discovery copy, not a capability list — it tells
  // an agent that Loadout is here and to ask the running server what it
  // can actually do.
  const agentsMdPath = join(ROOT, "AGENTS.md");
  const agentsMd = renderAgentsMd();
  const currentAgentsMd = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, "utf8") : "";
  if (currentAgentsMd !== agentsMd) {
    if (CHECK_ONLY) {
      stale.push("AGENTS.md");
    } else {
      writeFileSync(agentsMdPath, agentsMd);
      written++;
      console.log("AGENTS.md");
    }
  }

  for (const w of warnings) console.warn(`warn: ${w}`);

  if (CHECK_ONLY && stale.length) {
    console.error(
      `\n${stale.length} agent doc(s) are out of date:\n${stale
        .map((s) => `  ${s}`)
        .join("\n")}\n\nRun: bun scripts/generate-agent-docs.ts`,
    );
    process.exit(1);
  }

  console.log(
    CHECK_ONLY
      ? `agent docs up to date (${plugins.length} plugins)`
      : `done — ${written} file(s) written across ${plugins.length} plugins`,
  );
}

main();
