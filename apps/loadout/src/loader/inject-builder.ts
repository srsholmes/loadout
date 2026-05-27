/**
 * Builds SDK and plugin bundles for CEF injection context.
 *
 * In the injection context, we can't use ES module imports because
 * import maps can't be added dynamically after page load. Instead,
 * we build as IIFE-style bundles that resolve react/react-dom from
 * globalThis.__VENDOR_* and register exports on globalThis.
 */
import { join } from "node:path";
import type { BunPlugin } from "bun";

/**
 * Bun plugin that resolves react/react-dom imports to read from
 * the __VENDOR_* globals set by vendor-all.js. Exported so the
 * on-demand plugin-bundle compiler (`compileTsx` for the overlay's
 * /plugins/<id>/app-bundle.js route) can reuse the exact same
 * resolve+load mapping — both surfaces need the same rewrites for
 * plugin bundles to share React with the overlay shell.
 */
export function vendorGlobalsPlugin(): BunPlugin {
  return {
    name: "vendor-globals",
    setup(build) {
      const mappings: Record<string, string> = {
        react: "globalThis.__VENDOR_REACT",
        "react/jsx-runtime": "globalThis.__VENDOR_REACT_JSX_RUNTIME",
        "react/jsx-dev-runtime": "globalThis.__VENDOR_REACT_JSX_DEV_RUNTIME",
        "react-dom": "globalThis.__VENDOR_REACT_DOM",
        "react-dom/client": "globalThis.__VENDOR_REACT_DOM_CLIENT",
      };

      for (const [pkg, globalVar] of Object.entries(mappings)) {
        const escaped = pkg.replace(/[/]/g, "\\/");
        build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
          path: pkg,
          namespace: "vendor-global",
        }));
        build.onLoad({ filter: new RegExp(`^${escaped}$`), namespace: "vendor-global" }, () => ({
          contents: `module.exports = ${globalVar};`,
          loader: "js",
        }));
      }
    },
  };
}

/** Bun plugin that resolves `@loadout/ui` to the shell's
 *  `__LOADOUT_SDK` global. Same dedup rationale as
 *  `vendorGlobalsPlugin`. */
export function sdkGlobalPlugin(): BunPlugin {
  return {
    name: "sdk-global",
    setup(build) {
      build.onResolve({ filter: /^@loadout\/ui$/ }, () => ({
        path: "@loadout/ui",
        namespace: "sdk-global",
      }));
      build.onLoad({ filter: /^@loadout\/ui$/, namespace: "sdk-global" }, () => ({
        contents: `module.exports = globalThis.__LOADOUT_SDK;`,
        loader: "js",
      }));
    },
  };
}

export interface InjectBundles {
  vendor: string;
  sdk: string;
  plugins: Map<string, string>;
}

/**
 * Build all bundles needed for injection.
 * Uses IIFE format so they work as regular <script> tags.
 *
 * Works at runtime from installed plugin directories — no source tree needed.
 * The UI SDK is found via any plugin's node_modules/@loadout/ui.
 */
export async function buildInjectBundles(
  pluginsDir: string,
  pluginIds: string[],
): Promise<InjectBundles> {
  const { tmpdir } = await import("node:os");
  const { mkdir } = await import("node:fs/promises");
  const buildRoot = join(tmpdir(), "loadout-inject-build");
  await mkdir(buildRoot, { recursive: true });

  // Build vendor bundle (React, ReactDOM) — sets up __VENDOR_* globals.
  // The shim has to live somewhere Bun.build can resolve `react` from.
  // We prefer the hoisted node_modules at `<pluginsDir>/../node_modules`
  // (the standard layout produced by scripts/prepare-plugins.sh) and
  // fall back to scanning per-plugin node_modules for older installs
  // that haven't been re-staged yet.
  let vendorBundle = "";
  {
    let vendorBuildBase = buildRoot;
    const hoistedReact = join(pluginsDir, "..", "node_modules/react");
    if (await Bun.file(join(hoistedReact, "package.json")).exists()) {
      vendorBuildBase = join(pluginsDir, "..");
    } else {
      for (const pluginId of pluginIds) {
        const reactPath = join(pluginsDir, pluginId, "node_modules/react");
        if (await Bun.file(join(reactPath, "package.json")).exists()) {
          vendorBuildBase = join(pluginsDir, pluginId);
          break;
        }
      }
    }

    const vendorShim = join(vendorBuildBase, ".vendor-shim.ts");
    await Bun.write(vendorShim, `
import * as React from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
(globalThis as any).__VENDOR_REACT = React;
(globalThis as any).__VENDOR_REACT_JSX_RUNTIME = ReactJsxRuntime;
(globalThis as any).__VENDOR_REACT_JSX_DEV_RUNTIME = ReactJsxDevRuntime;
(globalThis as any).__VENDOR_REACT_DOM = ReactDOM;
(globalThis as any).__VENDOR_REACT_DOM_CLIENT = ReactDOMClient;
`);
    const vendorBuildDir = join(buildRoot, "vendor");
    await mkdir(vendorBuildDir, { recursive: true });
    try {
      const vendorResult = await Bun.build({
        entrypoints: [vendorShim],
        outdir: vendorBuildDir,
        format: "esm",
        target: "browser",
      });
      if (vendorResult.success && vendorResult.outputs.length > 0) {
        vendorBundle = await Bun.file(vendorResult.outputs[0].path).text();
      } else {
        console.error("Failed to build vendor bundle:", vendorResult.logs);
      }
    } finally {
      // Clean up shim file
      try { const { unlink } = await import("node:fs/promises"); await unlink(vendorShim); } catch {}
    }
  }

  // Find the UI SDK entry point. Prefer the hoisted location; fall back
  // to per-plugin scan for backwards compat with older install layouts.
  let uiEntrypoint = "";
  const hoistedUi = join(pluginsDir, "..", "node_modules/@loadout/ui/src/index.ts");
  if (await Bun.file(hoistedUi).exists()) {
    uiEntrypoint = hoistedUi;
  } else {
    for (const pluginId of pluginIds) {
      const candidate = join(pluginsDir, pluginId, "node_modules/@loadout/ui/src/index.ts");
      if (await Bun.file(candidate).exists()) {
        uiEntrypoint = candidate;
        break;
      }
    }
  }

  let sdkBundle = "";
  if (uiEntrypoint) {
    const sdkBuildDir = join(buildRoot, "sdk");
    await mkdir(sdkBuildDir, { recursive: true });

    const sdkResult = await Bun.build({
      entrypoints: [uiEntrypoint],
      outdir: sdkBuildDir,
      plugins: [vendorGlobalsPlugin()],
      format: "esm",
      target: "browser",
    });

    if (sdkResult.success && sdkResult.outputs.length > 0) {
      const sdkCode = await Bun.file(sdkResult.outputs[0].path).text();
      sdkBundle = transformToIIFE(sdkCode, "__LOADOUT_SDK");
    } else {
      console.error("Failed to build inject SDK:", sdkResult.logs);
    }
  } else {
    console.warn("Could not find @loadout/ui in any plugin's node_modules — SDK inject bundle skipped");
  }

  // Build plugin bundles
  const pluginBundles = new Map<string, string>();

  for (const pluginId of pluginIds) {
    const panelPath = join(pluginsDir, pluginId, "panel.tsx");
    const bundleDir = join(buildRoot, `plugins/${pluginId}`);

    // Skip plugins that only have app.tsx (overlay-only plugins)
    if (!(await Bun.file(panelPath).exists())) continue;

    try {
      await mkdir(bundleDir, { recursive: true });
      const result = await Bun.build({
        entrypoints: [panelPath],
        outdir: bundleDir,
        plugins: [vendorGlobalsPlugin(), sdkGlobalPlugin()],
        format: "esm",
        target: "browser",
      });

      if (result.success && result.outputs.length > 0) {
        const code = await Bun.file(result.outputs[0].path).text();
        pluginBundles.set(pluginId, transformToIIFE(code, `__LOADOUT_PLUGIN_${pluginId}`));
      } else {
        console.error(`Failed to build inject plugin ${pluginId}:`, result.logs);
      }
    } catch (err) {
      console.error(`Failed to build inject bundle for ${pluginId}:`, err);
    }
  }

  return { vendor: vendorBundle, sdk: sdkBundle, plugins: pluginBundles };
}

/**
 * Transform an ESM bundle into an IIFE that registers exports on globalThis.
 *
 * Strips `export { ... }` and `export default ...` statements from the end,
 * and wraps the code to capture the exported names onto a globalThis key.
 */
function transformToIIFE(esmCode: string, globalName: string): string {
  // Parse export statement to find exported names
  // Matches: export { name1, name2 as alias2, ... };
  const exportMatch = esmCode.match(/export\s*\{([^}]+)\}\s*;?\s*$/);
  const defaultExportMatch = esmCode.match(/export\s+default\s+(\w+)\s*;?\s*$/);

  let coreCode = esmCode;
  const exportNames: string[] = [];

  if (exportMatch) {
    // Remove the export statement
    coreCode = esmCode.slice(0, exportMatch.index).trimEnd();

    // Parse export names (handle `name as alias` syntax)
    const names = exportMatch[1].split(",").map((s) => s.trim());
    for (const name of names) {
      const parts = name.split(/\s+as\s+/);
      // Use the original name (before "as"), which is the local variable
      exportNames.push(parts[0].trim());
    }
  }

  if (defaultExportMatch && !exportMatch) {
    coreCode = esmCode.slice(0, defaultExportMatch.index).trimEnd();
    exportNames.push(defaultExportMatch[1]);
  }

  // Build the assignments
  const assignments = exportNames
    .map((name) => `  __exports.${name} = typeof ${name} !== "undefined" ? ${name} : undefined;`)
    .join("\n");

  // Also set .default if there's a default export
  const hasDefault = exportNames.includes("default");
  const defaultLine = hasDefault ? "" : "\n  if (__exports.default === undefined && __exports[Object.keys(__exports)[0]]) __exports.default = __exports[Object.keys(__exports)[0]];";

  return `(function() {
  var __exports = {};
${coreCode}
${assignments}${defaultLine}
  globalThis["${globalName}"] = __exports;
})();`;
}
