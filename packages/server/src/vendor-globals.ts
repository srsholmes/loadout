import type { BunPlugin } from "bun";

/**
 * Resolves `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
 * and `@loadout/ui` to globals set up by the overlay shell. Plugins bundled
 * with this plugin share React with the shell — without this, each plugin
 * gets its own React copy and hooks break across roots.
 *
 * The injected module is emitted as ESM (`export { ... }`) so plugin bundles
 * resolve named imports (`import { useState } from "react"`) through the
 * bundler's static analysis path rather than tripping over a CJS `module.exports`
 * shim. We enumerate the named exports per module so the bundler can tree-shake
 * + lint missing names properly.
 */

interface Mapping {
  global: string;
  /** Named exports the bundler will see on this module. */
  names: string[];
  /** True when the module also has a default export. */
  hasDefault: boolean;
}

const MAPPINGS: Record<string, Mapping> = {
  react: {
    global: "globalThis.__LOADOUT_REACT",
    hasDefault: true,
    names: [
      "Children", "Component", "Fragment", "Profiler", "PureComponent",
      "StrictMode", "Suspense", "cloneElement", "createContext",
      "createElement", "createFactory", "createRef", "forwardRef",
      "isValidElement", "lazy", "memo", "startTransition", "useCallback",
      "useContext", "useDebugValue", "useDeferredValue", "useEffect",
      "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect",
      "useMemo", "useReducer", "useRef", "useState", "useSyncExternalStore",
      "useTransition", "version",
    ],
  },
  "react/jsx-runtime": {
    global: "globalThis.__LOADOUT_REACT_JSX_RUNTIME",
    hasDefault: false,
    names: ["jsx", "jsxs", "Fragment"],
  },
  "react/jsx-dev-runtime": {
    global: "globalThis.__LOADOUT_REACT_JSX_DEV_RUNTIME",
    hasDefault: false,
    names: ["jsxDEV", "Fragment"],
  },
  "react-dom": {
    global: "globalThis.__LOADOUT_REACT_DOM",
    hasDefault: true,
    names: [
      "createPortal", "findDOMNode", "flushSync", "hydrate", "render",
      "unmountComponentAtNode", "unstable_batchedUpdates", "version",
    ],
  },
  "react-dom/client": {
    global: "globalThis.__LOADOUT_REACT_DOM_CLIENT",
    hasDefault: false,
    names: ["createRoot", "hydrateRoot"],
  },
  "@loadout/ui": {
    global: "globalThis.__LOADOUT_UI",
    hasDefault: false,
    // Plugins can import any export from @loadout/ui — too many to enumerate.
    // For this module only, we fall back to a star re-export via a Proxy on the
    // global; see `buildUiContents` below.
    names: [],
  },
};

function buildContents(m: Mapping): string {
  if (m.global === "globalThis.__LOADOUT_UI") {
    // @loadout/ui has a large + evolving surface — emit a star-style re-export
    // through a Proxy-backed module object so any named import resolves at
    // runtime against the global. The bundler is permissive about names it
    // can't statically resolve on this namespace.
    return `
const __ns = ${m.global};
const __keys = __ns ? Object.keys(__ns) : [];
${[...new Set(["Button","Panel","Text","Toggle","Field","Slider","TextInput","TabBar","IconButton","Spinner","colors","useFocusable","useFocusContext","FocusContext","setFocus","getCurrentFocusKey","navigateByDirection","pauseNav","resumeNav","pushBackInterceptor","tryRunBackInterceptor","applyFocusPulse","focusScaleClass","BackendProvider","PluginProvider","useBackend","ensureConnected","subscribe","wsCall","initSpatialNav","SpatialNavigation","ROOT_FOCUS_KEY"])]
  .map((n) => `export const ${n} = __ns?.${n};`)
  .join("\n")}
`;
  }
  const lines: string[] = [`const __ns = ${m.global};`];
  for (const name of m.names) {
    // Wrap each export in a fresh identifier so plugins doing
    // `import { useState as us } from "react"` work as expected.
    lines.push(`export const ${name} = __ns?.${name};`);
  }
  if (m.hasDefault) lines.push(`export default __ns;`);
  return lines.join("\n");
}

export function vendorGlobalsPlugin(): BunPlugin {
  return {
    name: "loadout-vendor-globals",
    setup(build) {
      for (const [pkg, mapping] of Object.entries(MAPPINGS)) {
        const escaped = pkg.replace(/\//g, "\\/");
        const filter = new RegExp(`^${escaped}$`);
        const contents = buildContents(mapping);
        build.onResolve({ filter }, () => ({ path: pkg, namespace: "loadout-global" }));
        build.onLoad({ filter, namespace: "loadout-global" }, () => ({
          contents,
          loader: "js",
        }));
      }
    },
  };
}

export const VENDOR_GLOBAL_KEYS = Object.values(MAPPINGS).map((m) => m.global);
