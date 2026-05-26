import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { BunPlugin } from "bun";
import { vendorGlobalsPlugin } from "./vendor-globals";
import { log } from "./logger";

export interface CompileResult {
  ok: boolean;
  code: string;
}

/**
 * Bun plugin that blocks any local file import outside `pluginRoot`. Bun.build
 * will follow `import "/etc/passwd"` or `import "../../secrets.ts"` from a
 * plugin's app.tsx and read the contents into the bundle (or, on failure, into
 * the error logs). Constraining the resolve namespace here keeps plugins from
 * exfiltrating arbitrary files via the build pipeline.
 *
 * node_modules imports are allowed through unchanged (resolver default).
 */
function sandboxPluginPathsPlugin(pluginRoot: string): BunPlugin {
  const rootResolved = resolve(pluginRoot);
  return {
    name: "loadout-sandbox-plugin-paths",
    setup(build) {
      build.onResolve({ filter: /^[./]/ }, (args) => {
        // Relative imports are resolved relative to the importer. Absolute
        // imports start with `/`. Reject anything that escapes the plugin
        // directory by failing the resolve.
        const importerDir = args.importer ? resolve(args.importer, "..") : rootResolved;
        const resolved = resolve(importerDir, args.path);
        const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
        if (resolved !== rootResolved && !resolved.startsWith(rootWithSep)) {
          throw new Error(
            `Plugin import escapes plugin root: ${args.path} (resolved to ${resolved})`,
          );
        }
        return undefined;
      });
    },
  };
}

/**
 * Compile a plugin's `app.tsx` (or other browser entrypoint) to ESM with
 * vendor globals injected. `pluginRoot` constrains the import graph so a
 * malicious plugin can't reference files outside its own directory.
 */
export async function compileBrowserBundle(
  entrypoint: string,
  pluginRoot: string,
): Promise<CompileResult> {
  try {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      plugins: [sandboxPluginPathsPlugin(pluginRoot), vendorGlobalsPlugin()],
      target: "browser",
      format: "esm",
      minify: false,
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (result.success && result.outputs.length > 0) {
      return { ok: true, code: await result.outputs[0].text() };
    }
    // Errors might contain absolute file paths from the resolver. Surface a
    // generic message in the webview-bound response; full details go to logs.
    const logs = result.logs.map(String).join("\n");
    log.error(`Browser build failed: ${entrypoint}\n${logs}`);
    return { ok: false, code: `// Build failed (see server logs)` };
  } catch (err) {
    log.error(`Browser build error: ${entrypoint} — ${err}`);
    return { ok: false, code: `// Build error (see server logs)` };
  }
}

/**
 * Bundle a plugin's `backend.ts` into a self-contained ESM file the loader
 * can dynamic-import. The bundle inlines workspace deps (e.g. `@loadout/device`)
 * so it can run from an install path that doesn't have a `node_modules` tree.
 *
 * Build flow:
 *   - If `.cache/backend.bundle.js` exists and is mtime-newer than the source,
 *     reuse it. This is the only path that works under the installed layout
 *     (no workspace, no node_modules at the plugin dir).
 *   - Otherwise rebuild from source. This path requires the workspace to be
 *     reachable — only used during local dev or via `scripts/build.sh`'s
 *     pre-bundle step.
 */
export async function bundleBackend(
  pluginDir: string,
  backendPath: string,
  pluginId: string,
): Promise<string> {
  const cacheDir = join(pluginDir, ".cache");
  const bundlePath = join(cacheDir, "backend.bundle.js");

  const srcFile = Bun.file(backendPath);
  const cached = Bun.file(bundlePath);
  if (await cached.exists()) {
    const cachedMtime = cached.lastModified;
    const srcMtime = (await srcFile.exists()) ? srcFile.lastModified : 0;
    if (cachedMtime >= srcMtime) return bundlePath;
  }

  await mkdir(cacheDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [backendPath],
    target: "bun",
    format: "esm",
    minify: false,
    outdir: cacheDir,
    naming: "backend.bundle.js",
  });
  if (!result.success) {
    throw new Error(
      `Backend bundle failed for ${pluginId}:\n${result.logs.map(String).join("\n")}\n` +
        `If you are running an installed build, ensure scripts/build.sh has been run so ` +
        `.cache/backend.bundle.js is present alongside backend.ts.`,
    );
  }
  return bundlePath;
}
