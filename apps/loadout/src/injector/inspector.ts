/**
 * Element Inspector — a lightweight overlay that runs inside Steam's CEF
 * to help plugin developers inspect UI elements.
 *
 * Toggle with F12 (when dev mode is active).
 *
 * Features:
 * - Hover highlight with colored border
 * - Info popup showing React component name, props, CSS classes
 * - Fiber path (parent chain of component names)
 * - Click to copy a find pattern for use in plugin patches
 */

/**
 * Build a JS snippet that installs the element inspector in Steam's CEF.
 * Evaluated via CDP when dev mode is active.
 */
export function buildInspectorScript(): string {
  return `
(function() {
  "use strict";

  if (window.__LOADOUT_INSPECTOR) return;
  window.__LOADOUT_INSPECTOR = {};

  var active = false;
  var highlightEl = null;
  var infoEl = null;
  var lastTarget = null;

  // Create highlight overlay
  function createHighlight() {
    var el = document.createElement("div");
    el.id = "loadout-inspector-highlight";
    el.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:2147483646",
      "border:2px solid #00d4ff",
      "background:rgba(0,212,255,0.1)",
      "display:none",
      "transition:all 0.05s ease-out",
    ].join(";");
    document.body.appendChild(el);
    return el;
  }

  // Create info popup
  function createInfoPanel() {
    var el = document.createElement("div");
    el.id = "loadout-inspector-info";
    el.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "background:rgba(20,20,30,0.95)",
      "color:#e0e0e0",
      "border:1px solid #00d4ff",
      "border-radius:8px",
      "padding:12px",
      "font-family:monospace",
      "font-size:12px",
      "max-width:450px",
      "max-height:400px",
      "overflow-y:auto",
      "display:none",
      "pointer-events:none",
      "box-shadow:0 4px 20px rgba(0,0,0,0.5)",
      "line-height:1.5",
    ].join(";");
    document.body.appendChild(el);
    return el;
  }

  // Get React fiber from a DOM element
  function getFiber(el) {
    if (!el) return null;
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].startsWith("__reactFiber") || keys[i].startsWith("__reactInternalInstance")) {
        return el[keys[i]];
      }
    }
    return null;
  }

  // Get the component name from a fiber
  function getComponentName(fiber) {
    if (!fiber || !fiber.type) return null;
    if (typeof fiber.type === "string") return fiber.type; // HTML element
    return fiber.type.displayName || fiber.type.name || null;
  }

  // Walk up the fiber tree to build a component path
  function getFiberPath(fiber, maxDepth) {
    maxDepth = maxDepth || 8;
    var path = [];
    var current = fiber;
    var depth = 0;
    while (current && depth < maxDepth) {
      var name = getComponentName(current);
      if (name && typeof current.type !== "string") {
        path.unshift(name);
      }
      current = current.return;
      depth++;
    }
    return path;
  }

  // Get meaningful props (skip internal React ones)
  function getDisplayProps(fiber) {
    if (!fiber || !fiber.memoizedProps) return {};
    var props = fiber.memoizedProps;
    var result = {};
    var skip = ["children", "ref", "key", "$$typeof"];
    var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (skip.indexOf(k) !== -1) continue;
      var val = props[k];
      if (typeof val === "function") {
        result[k] = "[function]";
      } else if (typeof val === "object" && val !== null) {
        try {
          result[k] = JSON.stringify(val).substring(0, 60);
        } catch(e) {
          result[k] = "[object]";
        }
      } else {
        result[k] = val;
      }
    }
    return result;
  }

  // Find the nearest React component fiber (skip DOM fibers)
  function findComponentFiber(fiber) {
    var current = fiber;
    while (current) {
      if (current.type && typeof current.type !== "string") {
        return current;
      }
      current = current.return;
    }
    return fiber;
  }

  // Get component source snippet for the find pattern
  function getSourceSnippet(fiber) {
    if (!fiber || !fiber.type) return null;
    var fn = typeof fiber.type === "function" ? fiber.type : null;
    if (!fn && fiber.type.render) fn = fiber.type.render;
    if (!fn && fiber.type.type) fn = fiber.type.type;
    if (!fn || typeof fn !== "function") return null;
    try {
      var src = Function.prototype.toString.call(fn);
      // Extract a good find pattern: first unique prop destructuring or function call
      var match = src.match(/\\{([^}]{10,80})\\}/);
      if (match) return match[1].trim().substring(0, 60);
      return src.substring(0, 80);
    } catch(e) { return null; }
  }

  // Generate the info HTML for an element
  function buildInfoHTML(el) {
    var fiber = getFiber(el);
    var componentFiber = fiber ? findComponentFiber(fiber) : null;
    var name = componentFiber ? getComponentName(componentFiber) : null;
    var path = componentFiber ? getFiberPath(componentFiber) : [];
    var props = componentFiber ? getDisplayProps(componentFiber) : {};
    var cssClasses = el.className ? String(el.className).split(/\\s+/) : [];
    var sourceSnippet = componentFiber ? getSourceSnippet(componentFiber) : null;

    var html = '<div style="margin-bottom:6px;font-size:14px;font-weight:bold;color:#00d4ff">';
    html += name || el.tagName.toLowerCase();
    html += "</div>";

    // Component path
    if (path.length > 0) {
      html += '<div style="color:#888;margin-bottom:6px">' + path.join(" > ") + "</div>";
    }

    // Tag and CSS classes
    html += '<div style="margin-bottom:4px"><span style="color:#ffa500">tag:</span> ' + el.tagName.toLowerCase() + "</div>";
    if (cssClasses.length > 0 && cssClasses[0] !== "") {
      html += '<div style="margin-bottom:4px"><span style="color:#ffa500">classes:</span> ';
      html += cssClasses.map(function(c) { return '<span style="color:#98c379">' + c + "</span>"; }).join(" ");
      html += "</div>";
    }

    // Props
    var propKeys = Object.keys(props);
    if (propKeys.length > 0) {
      html += '<div style="margin-bottom:4px"><span style="color:#ffa500">props:</span></div>';
      html += '<div style="padding-left:8px">';
      for (var i = 0; i < Math.min(propKeys.length, 10); i++) {
        var k = propKeys[i];
        html += '<div><span style="color:#c678dd">' + k + '</span>: <span style="color:#e5c07b">' + String(props[k]).substring(0, 50) + "</span></div>";
      }
      if (propKeys.length > 10) html += "<div>... +" + (propKeys.length - 10) + " more</div>";
      html += "</div>";
    }

    // Find pattern
    if (sourceSnippet) {
      html += '<div style="margin-top:8px;padding:6px;background:rgba(0,0,0,0.3);border-radius:4px">';
      html += '<div style="color:#ffa500;margin-bottom:2px">find pattern (click to copy):</div>';
      html += '<div style="color:#98c379;word-break:break-all" data-copy="' + sourceSnippet.replace(/"/g, "&quot;") + '">"' + sourceSnippet + '"</div>';
      html += "</div>";
    }

    // CSS selector
    if (cssClasses.length > 0 && cssClasses[0] !== "") {
      html += '<div style="margin-top:4px;padding:6px;background:rgba(0,0,0,0.3);border-radius:4px">';
      html += '<div style="color:#ffa500;margin-bottom:2px">CSS selector:</div>';
      html += '<div style="color:#98c379">.' + cssClasses[0] + "</div>";
      html += "</div>";
    }

    return html;
  }

  function onMouseMove(e) {
    if (!active) return;
    var target = e.target;
    if (!target || target === highlightEl || target === infoEl) return;
    if (target.id && target.id.startsWith("loadout-inspector")) return;

    lastTarget = target;
    var rect = target.getBoundingClientRect();

    highlightEl.style.display = "block";
    highlightEl.style.top = rect.top + "px";
    highlightEl.style.left = rect.left + "px";
    highlightEl.style.width = rect.width + "px";
    highlightEl.style.height = rect.height + "px";

    infoEl.innerHTML = buildInfoHTML(target);
    infoEl.style.display = "block";

    // Position info panel near the element but avoid going off-screen
    var infoTop = rect.bottom + 8;
    var infoLeft = rect.left;
    if (infoTop + 300 > window.innerHeight) {
      infoTop = Math.max(0, rect.top - 300);
    }
    if (infoLeft + 450 > window.innerWidth) {
      infoLeft = Math.max(0, window.innerWidth - 460);
    }
    infoEl.style.top = infoTop + "px";
    infoEl.style.left = infoLeft + "px";
  }

  function onClick(e) {
    if (!active) return;
    var target = e.target;
    // Walk up to check if click is on the toggle button
    var node = target;
    while (node) {
      if (node.id === "loadout-inspector-toggle") return;
      node = node.parentElement;
    }
    e.preventDefault();
    e.stopPropagation();

    // Copy the find pattern or CSS selector to clipboard
    var copyText = target.dataset && target.dataset.copy;
    if (!copyText && lastTarget) {
      var fiber = getFiber(lastTarget);
      var componentFiber = fiber ? findComponentFiber(fiber) : null;
      copyText = componentFiber ? getSourceSnippet(componentFiber) : null;
    }
    if (copyText) {
      navigator.clipboard.writeText(copyText).then(function() {
        console.log("[loadout:inspector] Copied: " + copyText);
        // Flash the highlight green briefly
        highlightEl.style.borderColor = "#00ff88";
        highlightEl.style.background = "rgba(0,255,136,0.15)";
        setTimeout(function() {
          highlightEl.style.borderColor = "#00d4ff";
          highlightEl.style.background = "rgba(0,212,255,0.1)";
        }, 300);
      });
    }
  }

  function toggle() {
    active = !active;
    if (active) {
      if (!highlightEl) highlightEl = createHighlight();
      if (!infoEl) infoEl = createInfoPanel();
      document.addEventListener("mousemove", onMouseMove, true);
      document.addEventListener("click", onClick, true);
      console.log("[loadout:inspector] Inspector ON");
    } else {
      if (highlightEl) highlightEl.style.display = "none";
      if (infoEl) infoEl.style.display = "none";
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      lastTarget = null;
      console.log("[loadout:inspector] Inspector OFF");
    }
  }

  // Floating toggle button
  var toggleBtn = document.createElement("div");
  toggleBtn.id = "loadout-inspector-toggle";
  toggleBtn.textContent = "Inspect";
  toggleBtn.style.cssText = [
    "position:fixed",
    "bottom:12px",
    "left:12px",
    "z-index:2147483647",
    "background:#00d4ff",
    "color:#000",
    "font-family:monospace",
    "font-size:12px",
    "font-weight:bold",
    "padding:6px 14px",
    "border-radius:6px",
    "cursor:pointer",
    "user-select:none",
    "pointer-events:auto",
    "box-shadow:0 2px 8px rgba(0,0,0,0.4)",
    "transition:background 0.15s",
  ].join(";");
  toggleBtn.addEventListener("mouseenter", function() {
    toggleBtn.style.background = active ? "#ff4444" : "#00aadd";
  });
  toggleBtn.addEventListener("mouseleave", function() {
    toggleBtn.style.background = active ? "#ff6666" : "#00d4ff";
  });
  toggleBtn.addEventListener("click", function(e) {
    e.stopPropagation();
    toggle();
    toggleBtn.textContent = active ? "Stop" : "Inspect";
    toggleBtn.style.background = active ? "#ff6666" : "#00d4ff";
  });
  document.body.appendChild(toggleBtn);

  // Keyboard shortcut still available: F12
  document.addEventListener("keydown", function(e) {
    if (e.key === "F12") {
      e.preventDefault();
      e.stopPropagation();
      toggle();
      toggleBtn.textContent = active ? "Stop" : "Inspect";
      toggleBtn.style.background = active ? "#ff6666" : "#00d4ff";
    }
  }, true);

  window.__LOADOUT_INSPECTOR.toggle = toggle;
  window.__LOADOUT_INSPECTOR.isActive = function() { return active; };

  console.log("[loadout:inspector] Element inspector installed (button + F12)");
})();
  `.trim();
}
