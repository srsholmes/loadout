/**
 * IIFE injected into Steam's SharedJSContext via Chrome DevTools Protocol
 * (`Runtime.evaluate`) to override Steam's UI sound playback.
 *
 * Strategy (verified against Steam UI build 2026-04):
 *   1. Acquire the webpack `require` function by pushing a probe chunk into
 *      `window.webpackChunksteamui`. The runtime callback hands us `req`,
 *      whose `req.m` is the factory map (source-of-truth for un-evaluated
 *      modules) and `req.c` is the cache (often empty until first require).
 *   2. Source-search `req.m` for the method definition signature
 *      `PlayAudioURL(<arg>){` co-occurring with `PlayAudioURLWithRepeats`
 *      or `m_Context|destination` to filter out call-sites.
 *   3. Force-require each candidate via `req(id)` and find the export whose
 *      `prototype.PlayAudioURL` is a function. That's the AudioPlaybackManager
 *      class. (Steam UI 2026-04: module 48042, export `.u`, class name `p`.)
 *   4. Wrap the prototype method to look up `basename(url)` in
 *      `window.__SL_AUDIO_OVERRIDES__` and rewrite if matched.
 *
 * The override map is updated separately (cheap) — no need to re-find or
 * re-patch when the active sound pack changes.
 *
 * Idempotent: re-running this script after install is a no-op (guarded by
 * `__SL_AUDIO_HOOK_INSTALLED__`).
 *
 * Failure modes (all non-throwing):
 *   - webpack absent      → `__SL_AUDIO_HOOK_ERROR__ = "webpack absent"`
 *   - require unobtainable → `__SL_AUDIO_HOOK_ERROR__ = "require not captured"`
 *   - candidate not found → `__SL_AUDIO_HOOK_ERROR__ = "AudioPlaybackManager not found"`
 *
 * The injector reads `__SL_AUDIO_HOOK_ERROR__` after evaluation to surface
 * find-heuristic failures to the UI.
 */
export const STEAM_HOOK_SCRIPT = `(function() {
  if (window.__SL_AUDIO_HOOK_INSTALLED__) return;
  window.__SL_AUDIO_HOOK_ERROR__ = null;

  var chunks = window.webpackChunksteamui;
  if (!chunks || typeof chunks.push !== "function") {
    window.__SL_AUDIO_HOOK_ERROR__ = "webpack absent";
    return;
  }

  var req = null;
  try {
    var probeId = "sl_audio_probe_" + Math.random().toString(36).slice(2);
    chunks.push([[probeId], {}, function(r) { req = r; }]);
  } catch (e) {
    window.__SL_AUDIO_HOOK_ERROR__ = "probe push failed: " + e.message;
    return;
  }
  if (!req || !req.m) {
    window.__SL_AUDIO_HOOK_ERROR__ = "require not captured";
    return;
  }

  // Source-search for the actual method definition (not call sites).
  // Method signatures look like: PlayAudioURL(e){...PlayAudioURLWithRepeats(e)...}
  var methodRe = /PlayAudioURL\\s*\\(\\s*\\w+\\s*\\)\\s*\\{/;
  var coRe = /PlayAudioURLWithRepeats|m_Context|destination/;
  var candidates = [];
  for (var k in req.m) {
    try {
      var src = req.m[k].toString();
      if (methodRe.test(src) && coRe.test(src)) candidates.push(k);
    } catch (e) {}
  }

  var protos = [];
  for (var i = 0; i < candidates.length; i++) {
    try {
      var mod = req(parseInt(candidates[i], 10));
      if (!mod || typeof mod !== "object") continue;
      for (var ek in mod) {
        var ex = mod[ek];
        if (typeof ex === "function" && ex.prototype &&
            typeof ex.prototype.PlayAudioURL === "function") {
          protos.push({ proto: ex.prototype, name: ex.name || "(anon)", moduleId: candidates[i], exportKey: ek });
        }
      }
    } catch (e) {}
  }

  if (protos.length === 0) {
    window.__SL_AUDIO_HOOK_ERROR__ = "AudioPlaybackManager not found";
    return;
  }

  if (!window.__SL_AUDIO_OVERRIDES__) window.__SL_AUDIO_OVERRIDES__ = {};

  var patched = [];
  for (var p = 0; p < protos.length; p++) {
    var info = protos[p];
    var original = info.proto.PlayAudioURL;
    info.proto.PlayAudioURL = (function(orig) {
      return function(url) {
        try {
          var map = window.__SL_AUDIO_OVERRIDES__;
          if (map && typeof url === "string") {
            // Steam passes URLs like "/sounds/deck_ui_navigation.wav" or full URLs.
            // Extract basename (after last "/", strip query/hash).
            var clean = url.split("?")[0].split("#")[0];
            var slash = clean.lastIndexOf("/");
            var name = slash >= 0 ? clean.substring(slash + 1) : clean;
            if (map[name]) {
              return orig.call(this, map[name]);
            }
          }
        } catch (e) {}
        return orig.call(this, url);
      };
    })(original);
    patched.push({ proto: info.proto, original: original, info: info });
  }

  window.__SL_AUDIO_HOOK_PATCHED__ = patched.map(function(x) {
    return { name: x.info.name, moduleId: x.info.moduleId, exportKey: x.info.exportKey };
  });

  window.__SL_AUDIO_UNPATCH__ = function() {
    for (var i = 0; i < patched.length; i++) {
      try { patched[i].proto.PlayAudioURL = patched[i].original; } catch (e) {}
    }
    delete window.__SL_AUDIO_OVERRIDES__;
    delete window.__SL_AUDIO_HOOK_INSTALLED__;
    delete window.__SL_AUDIO_HOOK_PATCHED__;
    delete window.__SL_AUDIO_UNPATCH__;
  };

  window.__SL_AUDIO_HOOK_INSTALLED__ = true;
})();`;
