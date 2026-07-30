/**
 * Webpack Module Patcher — Vencord-style module interception for Steam's
 * webpack bundles.
 *
 * Generates a JavaScript snippet that hooks into webpackChunksteamui.push()
 * to intercept module factory functions before they execute. Plugin patches
 * declare find/replace patterns that modify component source at load time,
 * which is more stable than post-render fiber tree manipulation.
 *
 * Architecture:
 * - Must be injected BEFORE Steam's webpack bundles load (or re-processes
 *   already-loaded modules)
 * - Wraps the chunk array's push method to intercept new chunks
 * - For each module factory, converts to string and checks against patches
 * - Matching factories get their source modified and rebuilt as new Functions
 * - Logs all applied patches for debugging
 */

import type { PluginPatch } from "@loadout/types";

/**
 * Largest module source we will stringify and scan, in characters.
 *
 * Sized from the real client rather than guessed: Steam's library module is
 * ~646 KB and is the one every UI patch cares about, so anything under about
 * 1 MB excludes the whole point of having a patcher.
 */
export const MAX_MODULE_SOURCE = 2_000_000;

export interface WebpackPatchEntry {
  /** Plugin ID that owns this patch */
  pluginId: string;
  /** The patch definition from the plugin manifest */
  patch: PluginPatch;
}

/**
 * Build a JS snippet that installs the webpack module interceptor.
 * Must be evaluated in Steam's CEF context BEFORE other injection scripts.
 */
export function buildWebpackPatcherScript(patches: WebpackPatchEntry[]): string {
  const patchesJson = JSON.stringify(
    patches.map((p) => ({
      pluginId: p.pluginId,
      find: p.patch.find,
      replacement: Array.isArray(p.patch.replacement)
        ? p.patch.replacement
        : [p.patch.replacement],
      optional: p.patch.optional ?? false,
    }))
  );

  return `
(function() {
  "use strict";

  var MAX_MODULE_SOURCE = ${MAX_MODULE_SOURCE};

  // Re-injection must update the patch set, not bail.
  //
  // Steam's page outlives the Loadout daemon: restart the daemon, enable a
  // plugin, or edit a patch, and this script is injected again into the same
  // page. The old guard returned early, so the running client kept the patch
  // set it booted with — and a freshly-fixed patch appeared to do nothing,
  // which is a genuinely baffling thing to debug.
  if (window.__LOADOUT_WEBPACK_PATCHER && window.__LOADOUT_WEBPACK_PATCHER.reload) {
    return window.__LOADOUT_WEBPACK_PATCHER.reload(${patchesJson});
  }

  var PATCHES = ${patchesJson};
  var appliedPatches = {};
  var patchLog = [];

  /**
   * Check if a module source matches a patch's find criteria.
   */
  function matchesFind(source, find) {
    if (typeof find === "string") {
      return source.includes(find);
    }
    if (Array.isArray(find)) {
      for (var i = 0; i < find.length; i++) {
        if (!source.includes(find[i])) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Apply replacement patterns to a module source string.
   * Returns the modified source, or null if no replacements matched.
   */
  function applyReplacements(source, replacements, pluginId) {
    var modified = source;
    var anyApplied = false;

    for (var i = 0; i < replacements.length; i++) {
      var rep = replacements[i];
      var matchPattern = rep.match;
      var replaceStr = rep.replace;

      // Support $self — reference to the plugin's global module.
      //
      // Bracket notation, not dot: plugin ids are kebab-case, so
      // \`globalThis.__LOADOUT_PLUGIN_library-tabs\` parses as a subtraction
      // and every hyphenated plugin — which is most of them — got a patch that
      // compiled and then threw at runtime. \`route-patcher.ts\` had this right.
      replaceStr = replaceStr.split("$self").join(
        '(globalThis[' + JSON.stringify("__LOADOUT_PLUGIN_" + pluginId) + '] || {})'
      );

      // Try as regex first (if it looks like /pattern/flags)
      var regexMatch = matchPattern.match(/^\\/(.+)\\/([gimsuy]*)$/);
      if (regexMatch) {
        try {
          var regex = new RegExp(regexMatch[1], regexMatch[2]);
          var before = modified;
          modified = modified.replace(regex, replaceStr);
          if (modified !== before) anyApplied = true;
        } catch (e) {
          console.warn("[loadout:wp] Invalid regex in patch from " + pluginId + ": " + matchPattern, e);
        }
      } else {
        // Plain string replacement
        var idx = modified.indexOf(matchPattern);
        if (idx !== -1) {
          modified = modified.substring(0, idx) + replaceStr + modified.substring(idx + matchPattern.length);
          anyApplied = true;
        }
      }
    }

    return anyApplied ? modified : null;
  }

  /**
   * Process a module factory function, applying any matching patches.
   * Returns the patched factory or the original if no patches matched.
   */
  function patchModuleFactory(moduleId, factory) {
    if (typeof factory !== "function") return factory;

    var source;
    try {
      source = Function.prototype.toString.call(factory);
    } catch (e) {
      return factory;
    }

    // Skip tiny modules, and ones so large that stringifying every chunk would
    // cost more than any patch is worth.
    //
    // The ceiling was 200,000, which silently skipped the module we most need:
    // Steam's library module (97220 on the 2026-07 client) holds the tab bar
    // and is 646,312 chars. A patch against it matched nothing and reported
    // nothing, because a skipped module never reaches the find check. Measured
    // on device: 2449 modules across 54 chunks, and stringifying all of them
    // is not the expensive part.
    if (source.length > MAX_MODULE_SOURCE || source.length < 10) return factory;

    var wasPatched = false;

    for (var i = 0; i < PATCHES.length; i++) {
      var patch = PATCHES[i];
      var patchKey = patch.pluginId + ":" + i;

      // Skip already-applied patches
      if (appliedPatches[patchKey]) continue;

      if (!matchesFind(source, patch.find)) continue;

      var patched = applyReplacements(source, patch.replacement, patch.pluginId);
      if (patched) {
        source = patched;
        wasPatched = true;
        appliedPatches[patchKey] = true;

        var logEntry = {
          pluginId: patch.pluginId,
          moduleId: moduleId,
          find: typeof patch.find === "string" ? patch.find.substring(0, 80) : patch.find.map(function(f) { return f.substring(0, 40); }),
          timestamp: Date.now()
        };
        patchLog.push(logEntry);
        console.log("[loadout:wp] Applied patch from '" + patch.pluginId + "' to module " + moduleId);
      }
    }

    if (!wasPatched) return factory;

    // Rebuild the factory function from the patched source
    try {
      // Extract the parameter list from the original factory
      var paramMatch = Function.prototype.toString.call(factory).match(/^function[^(]*\\(([^)]*)\\)/);
      var params = paramMatch ? paramMatch[1] : "module, exports, require";

      // Extract the body (everything between first { and last })
      var bodyStart = source.indexOf("{");
      var bodyEnd = source.lastIndexOf("}");
      if (bodyStart === -1 || bodyEnd === -1 || bodyEnd <= bodyStart) {
        console.warn("[loadout:wp] Could not extract body for module " + moduleId);
        return factory;
      }
      var body = source.substring(bodyStart + 1, bodyEnd);

      var patchedFactory = new Function(params, body);
      // Preserve any properties on the original factory
      Object.keys(factory).forEach(function(key) {
        try { patchedFactory[key] = factory[key]; } catch(e) {}
      });
      return patchedFactory;
    } catch (e) {
      console.error("[loadout:wp] Failed to rebuild module " + moduleId + " from patched source:", e);
      return factory;
    }
  }

  /**
   * Process all module factories in a webpack chunk.
   */
  function processChunkModules(modules) {
    if (!modules || typeof modules !== "object") return;

    var keys = Object.keys(modules);
    for (var i = 0; i < keys.length; i++) {
      var moduleId = keys[i];
      var factory = modules[moduleId];
      var patched = patchModuleFactory(moduleId, factory);
      if (patched !== factory) {
        modules[moduleId] = patched;
      }
    }
  }

  /**
   * Hook into webpackChunksteamui to intercept module loading.
   */
  function installHook() {
    var chunkArray = window.webpackChunksteamui;

    if (chunkArray) {
      // Process already-loaded chunks
      console.log("[loadout:wp] Processing " + chunkArray.length + " existing chunk(s)...");
      for (var i = 0; i < chunkArray.length; i++) {
        var chunk = chunkArray[i];
        if (Array.isArray(chunk) && chunk.length >= 2) {
          processChunkModules(chunk[1]);
        }
      }

      // Wrap push to intercept future chunks
      var originalPush = chunkArray.push.bind(chunkArray);
      chunkArray.push = function() {
        for (var a = 0; a < arguments.length; a++) {
          var chunk = arguments[a];
          if (Array.isArray(chunk) && chunk.length >= 2) {
            processChunkModules(chunk[1]);
          }
        }
        return originalPush.apply(null, arguments);
      };

      console.log("[loadout:wp] Webpack patcher installed (hooked push on existing array)");
    } else {
      // webpackChunksteamui doesn't exist yet — use Object.defineProperty
      // to intercept when it's first assigned
      var _chunks = undefined;
      Object.defineProperty(window, "webpackChunksteamui", {
        configurable: true,
        get: function() { return _chunks; },
        set: function(val) {
          _chunks = val;
          if (Array.isArray(val)) {
            // Process any initial chunks
            for (var i = 0; i < val.length; i++) {
              var chunk = val[i];
              if (Array.isArray(chunk) && chunk.length >= 2) {
                processChunkModules(chunk[1]);
              }
            }

            // Wrap push
            var originalPush = val.push.bind(val);
            val.push = function() {
              for (var a = 0; a < arguments.length; a++) {
                var chunk = arguments[a];
                if (Array.isArray(chunk) && chunk.length >= 2) {
                  processChunkModules(chunk[1]);
                }
              }
              return originalPush.apply(null, arguments);
            };
            console.log("[loadout:wp] Webpack patcher installed (defineProperty + push hook)");
          }
        }
      });
      console.log("[loadout:wp] Waiting for webpackChunksteamui via defineProperty...");
    }
  }

  // Warn about unmatched non-optional patches after a delay
  function checkUnmatchedPatches() {
    for (var i = 0; i < PATCHES.length; i++) {
      var patch = PATCHES[i];
      var patchKey = patch.pluginId + ":" + i;
      if (!appliedPatches[patchKey] && !patch.optional) {
        console.warn(
          "[loadout:wp] Patch from '" + patch.pluginId + "' was not applied. " +
          "Find pattern: " + JSON.stringify(patch.find).substring(0, 100)
        );
      }
    }
  }

  // Expose patch log for debugging
  window.__LOADOUT_PATCH_LOG = patchLog;
  window.__LOADOUT_APPLIED_PATCHES = appliedPatches;

  var hooked = false;

  function ensureHooked() {
    if (hooked) return;
    hooked = true;
    installHook();
    // Check for unmatched patches after Steam finishes loading
    setTimeout(checkUnmatchedPatches, 15000);
  }

  window.__LOADOUT_WEBPACK_PATCHER = {
    /**
     * Swap in a new patch set and re-scan the chunks already loaded.
     *
     * Modules webpack has already *executed* keep running their original
     * factory — replacing it only affects the next require — so a patch that
     * lands this way generally shows up after Steam restarts. Applying it
     * anyway is still right: it costs one scan, and it means the patch is in
     * place the moment anything re-requires the module.
     */
    reload: function (nextPatches) {
      PATCHES = nextPatches || [];
      // Clear the applied set: the same key may now mean a different patch.
      for (var key in appliedPatches) delete appliedPatches[key];
      patchLog.length = 0;
      if (PATCHES.length === 0) return "no-patches";
      ensureHooked();
      var chunkArray = window.webpackChunksteamui;
      if (chunkArray) {
        for (var i = 0; i < chunkArray.length; i++) {
          var chunk = chunkArray[i];
          if (Array.isArray(chunk) && chunk.length >= 2) processChunkModules(chunk[1]);
        }
      }
      return "reloaded:" + PATCHES.length;
    },
  };

  if (PATCHES.length > 0) {
    console.log("[loadout:wp] Installing webpack patcher with " + PATCHES.length + " patch(es)...");
    ensureHooked();
  } else {
    console.log("[loadout:wp] No patches registered, skipping webpack patcher");
  }
})();
  `.trim();
}
