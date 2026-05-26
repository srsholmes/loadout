import type { BunPlugin } from "bun";

/**
 * Resolves `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
 * and `@loadout/ui` to globals set up by the overlay shell. Plugins bundled
 * with these plugins share React with the shell — without this, each plugin
 * gets its own React copy and hooks break.
 */
const MAPPINGS: Record<string, string> = {
  react: "globalThis.__LOADOUT_REACT",
  "react/jsx-runtime": "globalThis.__LOADOUT_REACT_JSX_RUNTIME",
  "react/jsx-dev-runtime": "globalThis.__LOADOUT_REACT_JSX_DEV_RUNTIME",
  "react-dom": "globalThis.__LOADOUT_REACT_DOM",
  "react-dom/client": "globalThis.__LOADOUT_REACT_DOM_CLIENT",
  "@loadout/ui": "globalThis.__LOADOUT_UI",
};

export function vendorGlobalsPlugin(): BunPlugin {
  return {
    name: "loadout-vendor-globals",
    setup(build) {
      for (const [pkg, globalVar] of Object.entries(MAPPINGS)) {
        const escaped = pkg.replace(/\//g, "\\/");
        const filter = new RegExp(`^${escaped}$`);
        build.onResolve({ filter }, () => ({ path: pkg, namespace: "loadout-global" }));
        build.onLoad({ filter, namespace: "loadout-global" }, () => ({
          contents: `module.exports = ${globalVar};`,
          loader: "js",
        }));
      }
    },
  };
}

export const VENDOR_GLOBAL_KEYS = Object.values(MAPPINGS);
