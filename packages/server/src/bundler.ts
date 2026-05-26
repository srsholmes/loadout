import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { vendorGlobalsPlugin } from "./vendor-globals";
import { log } from "./logger";

export interface CompileResult {
  ok: boolean;
  code: string;
}

/**
 * Compile a plugin's `app.tsx` (or other browser entrypoint) to ESM with
 * vendor globals injected. Result is cached in-memory by the caller.
 */
export async function compileBrowserBundle(entrypoint: string): Promise<CompileResult> {
  try {
    const result = await Bun.build({
      entrypoints: [entrypoint],
      plugins: [vendorGlobalsPlugin()],
      target: "browser",
      format: "esm",
      minify: false,
      define: { "process.env.NODE_ENV": '"production"' },
    });
    if (result.success && result.outputs.length > 0) {
      return { ok: true, code: await result.outputs[0].text() };
    }
    const logs = result.logs.map(String).join("\n");
    log.error(`Browser build failed: ${entrypoint}\n${logs}`);
    return { ok: false, code: `// Build failed:\n// ${logs.replace(/\*\//g, "*\\/")}` };
  } catch (err) {
    log.error(`Browser build error: ${entrypoint} — ${err}`);
    return { ok: false, code: `// Build error: ${err}` };
  }
}

/**
 * Bundle a plugin's `backend.ts` into a self-contained ESM file the loader
 * can dynamic-import. Required because compiled Bun binaries can't resolve
 * node_modules from arbitrary directories.
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
      `Backend bundle failed for ${pluginId}:\n${result.logs.map(String).join("\n")}`,
    );
  }
  return bundlePath;
}
