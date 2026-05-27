/**
 * Steam Component Discovery — builds a JavaScript snippet that runs inside
 * Steam's CEF context to discover Valve's internal React components from
 * the webpack bundle and report their metadata back to the loader.
 *
 * Strategy: Component names are fully minified in production builds, but
 * CSS module class names retain readable keys (e.g. "DialogButton" → "_21DkRjmS_...").
 * We discover CSS class mappings for known component names and use code-pattern
 * matching (unique prop destructuring patterns) to locate actual React functions.
 */

export interface SteamComponentPropMeta {
  name: string;
  inferredType?: "boolean" | "number" | "string" | "function" | "array" | "ReactNode" | "object" | "unknown";
  defaultValue?: string;
  source?: "destructuring" | "codeFinder" | "bodyAccess" | "propTypes" | "defaultProps";
}

export interface SteamComponentMeta {
  name: string;
  displayName?: string;
  type: "function" | "class" | "forwardRef" | "memo" | "object" | "unknown";
  props: SteamComponentPropMeta[];
  source: string;
  finderUsed: string;
  /** CSS class name hash (if discovered from CSS module) */
  cssClass?: string;
}

/** Known component names we want to discover */
const KNOWN_COMPONENTS = [
  "DialogButton",
  "DialogButtonPrimary",
  "DialogButtonSecondary",
  "Focusable",
  "SliderField",
  "ToggleField",
  "TextField",
  "DropdownField",
  "Dialog",
  "ConfirmDialog",
  "ModalRoot",
  "Menu",
  "MenuItem",
  "MenuGroup",
  "Tabs",
  "ProgressBar",
  "SteamSpinner",
  "ScrollPanel",
  "GamepadUI",
  "Navigation",
];

/**
 * Code-based finder patterns — unique prop/code combinations that reliably
 * identify specific React components even in minified builds.
 * Props survive minification because they're part of the public API.
 */
const CODE_FINDERS: Record<string, string[][]> = {
  // Each entry is an array of pattern arrays (tried in order, first match wins)
  Focusable: [["onActivate", "onCancel", "focusClassName", "focusWithinClassName"]],
  DialogButton: [["DialogButton", "createElement"], ["DialogButton", "jsx"]],
  DialogButtonPrimary: [["DialogButtonPrimary", "createElement"], ["DialogButtonPrimary", "jsx"]],
  DialogButtonSecondary: [["DialogButtonSecondary", "createElement"], ["DialogButtonSecondary", "jsx"]],
  DropdownField: [["rgOptions", "selectedOption", "strDefaultLabel"]],
  Navigation: [["Navigate", "NavigateBack", "NavigationManager"]],
  ConfirmDialog: [["strOKButtonText", "strCancelButtonText", "onOK", "onCancel"]],
  ModalRoot: [["closeModal", "bHideMainWindowForPopouts"]],
  SliderField: [["nMin", "nMax", "nStep"]],
  ToggleField: [["bChecked", "onChange"]],
  TextField: [["TextField", "createElement", "onChange"], ["TextField", "jsx", "onChange"]],
  ProgressBar: [["nProgress", "nTransitionSec"]],
  SteamSpinner: [["size", "string", "medium"]],
  ScrollPanel: [["focusable", "scrollable"]],
  Tabs: [["activeTab", "onShowTab"]],
  Menu: [["label", "onCancel", "cancelText"]],
  MenuItem: [["onSelected", "bInteractableItem"]],
  MenuGroup: [["label", "children"]],
  GamepadUI: [["GamepadUIDesktop"]],
};

export function buildComponentDiscoveryScript(loaderPort: number): string {
  const knownJson = JSON.stringify(KNOWN_COMPONENTS);
  const codeFindersJson = JSON.stringify(CODE_FINDERS);

  return `
(async () => {
  try {
    // Always re-POST to loader on restart (server may have restarted)
    if (window.__steamComponentsDiscovered && window.__STEAM_COMPONENTS_META) {
      console.log("[loadout] Components already discovered, re-posting to loader...");
      try {
        await fetch("http://localhost:${loaderPort}/api/steam-components/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(window.__STEAM_COMPONENTS_META)
        });
        console.log("[loadout] Re-posted " + window.__STEAM_COMPONENTS_META.length + " components");
      } catch (e) {
        console.warn("[loadout] Failed to re-post component metadata:", e);
      }
      return;
    }
    window.__steamComponentsDiscovered = true;
    console.log("[loadout] Discovering Steam components...");

    // Step 1: Walk webpack module registry
    var allModules = [];
    try {
      if (window.webpackChunksteamui) {
        var wpRequire;
        window.webpackChunksteamui.push([
          [Symbol()],
          {},
          function(require) { wpRequire = require; }
        ]);
        if (wpRequire && wpRequire.m) {
          var ids = Object.keys(wpRequire.m);
          for (var mi = 0; mi < ids.length; mi++) {
            try {
              var mod = wpRequire(ids[mi]);
              if (mod) allModules.push(mod);
            } catch (e) {}
          }
        }
        console.log("[loadout] Found " + allModules.length + " webpack modules");
      } else {
        console.warn("[loadout] webpackChunksteamui not found");
        return;
      }
    } catch (e) {
      console.error("[loadout] Failed to walk webpack modules:", e);
      return;
    }

    // Step 2: Find CSS class modules — extract known component name → CSS hash mappings
    var knownNames = ${knownJson};
    var cssClassMap = {};

    function looksLikeCssHash(val) {
      return typeof val === "string" && val.length > 5 && val.length < 80
        && /^[_a-zA-Z0-9-]+$/.test(val);
    }

    for (var i = 0; i < allModules.length; i++) {
      var mod = allModules[i];
      if (!mod || mod === window || typeof mod !== "object") continue;
      var keys = Object.keys(mod);
      if (keys.length < 2) continue;
      var strCount = 0;
      for (var ki = 0; ki < keys.length; ki++) {
        if (looksLikeCssHash(mod[keys[ki]])) strCount++;
      }
      if (strCount < keys.length * 0.5) continue;
      for (var ni = 0; ni < knownNames.length; ni++) {
        var name = knownNames[ni];
        if (mod[name] && looksLikeCssHash(mod[name]) && !cssClassMap[name]) {
          cssClassMap[name] = mod[name];
        }
      }
    }
    console.log("[loadout] CSS classes found for: " + Object.keys(cssClassMap).join(", "));

    // Step 3: Find React components by code patterns
    var codeFinders = ${codeFindersJson};

    function getComponentType(comp) {
      if (!comp) return "unknown";
      if (comp.$$typeof) {
        var sym = String(comp.$$typeof);
        if (sym.includes("forward_ref")) return "forwardRef";
        if (sym.includes("memo")) return "memo";
      }
      if (typeof comp === "function") {
        if (comp.prototype && comp.prototype.isReactComponent) return "class";
        return "function";
      }
      if (typeof comp === "object") return "object";
      return "unknown";
    }

    // Infer prop type from Hungarian notation and common naming patterns
    function inferPropType(name) {
      if (/^on[A-Z]/.test(name)) return "function";
      if (/^b[A-Z]/.test(name)) return "boolean";
      if (/^n[A-Z]/.test(name)) return "number";
      if (/^str[A-Z]/.test(name)) return "string";
      if (/^rg[A-Z]/.test(name)) return "array";
      if (name === "children") return "ReactNode";
      if (name === "className" || name === "label" || name === "title" || name === "placeholder") return "string";
      if (/[Cc]lass[Nn]ame/.test(name) || /[Ll]abel/.test(name) || /[Tt]ext/.test(name)) return "string";
      if (name === "style") return "object";
      if (name === "disabled" || name === "checked" || name === "focusable" || name === "scrollable") return "boolean";
      if (name === "value") return "unknown";
      if (name === "ref") return "object";
      if (name === "size") return "string";
      if (/^on[A-Z]/.test(name) || name === "onChange" || name === "onClick" || name === "onCancel") return "function";
      return "unknown";
    }

    // Infer type from a default value string
    function inferTypeFromDefault(val) {
      if (val === "true" || val === "false" || val === "!0" || val === "!1") return "boolean";
      if (/^-?\\d+(\\.\\d+)?$/.test(val)) return "number";
      if (/^["']/.test(val)) return "string";
      if (val === "null" || val === "void 0") return "unknown";
      if (val.startsWith("[")) return "array";
      if (val.startsWith("{")) return "object";
      return "unknown";
    }

    function extractProps(comp) {
      var props = [];
      var seen = {};

      function addProp(name, source, defaultValue) {
        if (seen[name]) return;
        seen[name] = true;
        var type = inferPropType(name);
        if (type === "unknown" && defaultValue) {
          type = inferTypeFromDefault(defaultValue);
        }
        var entry = { name: name, inferredType: type, source: source };
        if (defaultValue) entry.defaultValue = defaultValue;
        props.push(entry);
      }

      if (comp.propTypes) {
        Object.keys(comp.propTypes).forEach(function(p) { addProp(p, "propTypes", null); });
      }
      if (comp.defaultProps) {
        Object.keys(comp.defaultProps).forEach(function(p) {
          var val = null;
          try { val = JSON.stringify(comp.defaultProps[p]); } catch(e) {}
          addProp(p, "defaultProps", val);
        });
      }

      var fn = typeof comp === "function" ? comp
        : (comp.render && typeof comp.render === "function" ? comp.render : null);
      if (fn) {
        var src = String(fn);
        // Extract destructured params with optional default values
        var match = src.match(/\\(\\s*\\{([^}]{1,500})\\}/)
          || src.match(/^function[^(]*\\(\\s*\\{([^}]{1,500})\\}/);
        if (match) {
          match[1].split(",").forEach(function(part) {
            var trimmed = part.trim();
            var eqIdx = trimmed.indexOf("=");
            var colonIdx = trimmed.indexOf(":");
            var pname, defaultVal;
            if (eqIdx > 0 && (colonIdx < 0 || eqIdx < colonIdx)) {
              pname = trimmed.substring(0, eqIdx).trim();
              defaultVal = trimmed.substring(eqIdx + 1).trim();
            } else if (colonIdx > 0) {
              pname = trimmed.substring(0, colonIdx).trim();
              defaultVal = null;
            } else {
              pname = trimmed;
              defaultVal = null;
            }
            if (pname && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(pname)) {
              addProp(pname, "destructuring", defaultVal);
            }
          });
        }
      }
      return props;
    }

    function findByCodePatterns(patterns) {
      for (var pi = 0; pi < patterns.length; pi++) {
        var pat = patterns[pi];
        for (var i = 0; i < allModules.length; i++) {
          var mod = allModules[i];
          if (!mod || mod === window || typeof mod !== "object") continue;
          var keys = Object.keys(mod);
          for (var k = 0; k < keys.length; k++) {
            var val = mod[keys[k]];
            if (!val) continue;
            var fn = null;
            if (typeof val === "function") fn = val;
            else if (typeof val === "object" && val.$$typeof) {
              fn = val.render || val.type;
              if (typeof fn !== "function") fn = null;
            }
            if (!fn) continue;
            try {
              var src = String(fn);
              if (src.length > 50000) continue;
              if (pat.every(function(s) { return src.includes(s); })) {
                return typeof val === "function" ? val : (val.$$typeof ? val : fn);
              }
            } catch(e) {}
          }
        }
      }
      return null;
    }

    // Strategy: find a React component whose source references a CSS class hash.
    // CSS modules export { ComponentName: "hashXyz" }. The React component using it
    // will reference that hash via the module import (e.g., e.DialogButton or t.DialogButton).
    // We search for functions that contain the EXPORT KEY name as a property access.
    function findByCssKeyUsage(componentName) {
      // Look for React functions that access .ComponentName on some object
      // This catches patterns like: e.DialogButton, t.DialogButton, n.DialogButton
      var accessPattern = "." + componentName;
      for (var i = 0; i < allModules.length; i++) {
        var mod = allModules[i];
        if (!mod || mod === window || typeof mod !== "object") continue;
        var keys = Object.keys(mod);
        for (var k = 0; k < keys.length; k++) {
          var val = mod[keys[k]];
          if (!val) continue;
          var fn = null;
          if (typeof val === "function") fn = val;
          else if (typeof val === "object" && val.$$typeof) {
            fn = val.render || val.type;
            if (typeof fn !== "function") fn = null;
          }
          if (!fn) continue;
          try {
            var src = String(fn);
            if (src.length > 50000 || src.length < 20) continue;
            // Must contain the CSS key access AND look like a React component
            // (returns JSX / calls createElement)
            if (src.includes(accessPattern) && (src.includes("createElement") || src.includes("jsxs") || src.includes("jsx"))) {
              // Prefer the wrapper (val) over the raw function for forwardRef/memo
              return typeof val === "function" ? val : (val.$$typeof ? val : fn);
            }
          } catch(e) {}
        }
      }
      return null;
    }

    // Step 4: Run discovery
    var discovered = {};
    var metadata = [];

    for (var ni = 0; ni < knownNames.length; ni++) {
      var name = knownNames[ni];
      var component = null;
      var strategyUsed = "";
      var cssClass = cssClassMap[name] || null;

      // Strategy 1: Code pattern matching (most reliable)
      if (codeFinders[name]) {
        component = findByCodePatterns(codeFinders[name]);
        if (component) strategyUsed = "byCode";
      }

      // Strategy 2: Find by CSS key usage (component that references .ComponentName)
      if (!component && cssClass) {
        component = findByCssKeyUsage(name);
        if (component) strategyUsed = "byCssKey";
      }

      if (component) {
        discovered[name] = component;
        var compType = getComponentType(component);
        var props = extractProps(component);
        // Merge in known props from CODE_FINDERS patterns (these survive minification)
        var seenMerge = {};
        props.forEach(function(p) { seenMerge[p.name] = true; });
        if (codeFinders[name]) {
          codeFinders[name].forEach(function(pat) {
            pat.forEach(function(propName) {
              if (!seenMerge[propName]) {
                seenMerge[propName] = true;
                props.push({ name: propName, inferredType: inferPropType(propName), source: "codeFinder" });
              }
            });
          });
        }
        var source = "";
        try {
          var srcFn = typeof component === "function" ? component : (component.render || component.type || component);
          source = String(srcFn).substring(0, 300);
        } catch(e) {}
        metadata.push({
          name: name,
          displayName: component.displayName || component.name || name,
          type: compType,
          props: props,
          source: source,
          finderUsed: strategyUsed,
          cssClass: cssClass
        });
        console.log("[loadout] Found: " + name + " (" + compType + ", " + strategyUsed + ", " + props.length + " props)");
      } else {
        // Record CSS class even without React ref — useful for CSS injection & DOM queries
        // Still include known props from CODE_FINDERS with inferred types
        var knownProps = [];
        if (codeFinders[name]) {
          codeFinders[name].forEach(function(pat) {
            pat.forEach(function(propName) {
              knownProps.push({ name: propName, inferredType: inferPropType(propName), source: "codeFinder" });
            });
          });
        }
        metadata.push({
          name: name,
          displayName: name,
          type: "unknown",
          props: knownProps,
          source: "",
          finderUsed: cssClass ? "cssClassOnly" : "notFound",
          cssClass: cssClass
        });
        if (cssClass) {
          console.log("[loadout] CSS only: " + name + " → ." + cssClass);
        } else {
          console.warn("[loadout] Not found: " + name);
        }
      }
    }

    // Step 5: Discover Navigation singleton (API object, not React component)
    // Navigation has .Navigate, .NavigateBack, .CloseSideMenus as methods on a plain object
    var navigationFound = false;
    for (var ni2 = 0; ni2 < allModules.length && !navigationFound; ni2++) {
      var navMod = allModules[ni2];
      if (!navMod || navMod === window || typeof navMod !== "object") continue;
      var navKeys = Object.keys(navMod);
      for (var nk = 0; nk < navKeys.length; nk++) {
        var navVal = navMod[navKeys[nk]];
        if (navVal && typeof navVal === "object" && !Array.isArray(navVal)
            && typeof navVal.Navigate === "function"
            && typeof navVal.NavigateBack === "function"
            && typeof navVal.CloseSideMenus === "function") {
          globalThis.__LOADOUT_NAVIGATION = navVal;
          navigationFound = true;
          console.log("[loadout] Found Navigation singleton");
          break;
        }
      }
    }
    if (!navigationFound) {
      console.warn("[loadout] Navigation singleton not found");
    }

    // Step 6: SteamClient API
    if (window.SteamClient) {
      var apiNames = Object.keys(window.SteamClient);
      metadata.push({
        name: "SteamClient",
        displayName: "SteamClient",
        type: "object",
        props: apiNames.map(function(n) { return { name: n }; }),
        source: "window.SteamClient — " + apiNames.length + " APIs: " + apiNames.join(", "),
        finderUsed: "global:window.SteamClient"
      });
      console.log("[loadout] SteamClient APIs: " + apiNames.join(", "));
    }

    // Store references and metadata
    globalThis.__STEAM_COMPONENTS = discovered;
    window.__STEAM_COMPONENTS_META = metadata;

    // Step 6: POST metadata to loader server
    try {
      await fetch("http://localhost:${loaderPort}/api/steam-components/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata)
      });
    } catch (e) {
      console.warn("[loadout] Failed to send component metadata to loader:", e);
    }

    var foundCount = Object.keys(discovered).length;
    var cssOnlyCount = metadata.filter(function(m) { return m.finderUsed === "cssClassOnly"; }).length;
    console.log("[loadout] Discovery complete: " + foundCount + " React refs, " + cssOnlyCount + " CSS-only, " + metadata.length + " total");
  } catch (err) {
    console.error("[loadout] Component discovery failed:", err);
  }
})();
  `.trim();
}
