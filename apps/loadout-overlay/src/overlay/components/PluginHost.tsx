import { useState, useEffect, useRef, useCallback } from "react";
import type { PluginInfo } from "../hooks/usePlugins";
import { importPluginBundle } from "../lib/backend";
import {
  createErrorReport,
  copyErrorToClipboard,
  saveErrorToDownloads,
} from "../utils/error-reporter";

/**
 * Dynamically loads and renders a plugin's app.
 *
 * Each plugin bundles its own React instance and exports a `mount(container)`
 * function. PluginHost creates a div, loads the plugin bundle, and calls mount.
 * The plugin manages its own React root inside that div.
 *
 * A `parentFocusKey` is passed to mount() so the plugin can connect its
 * focusable elements into the shell's spatial-navigation tree.
 */
export function PluginHost({
  plugin,
  headerSlotRef,
}: {
  plugin: PluginInfo;
  /**
   * Ref to the shell's topbar DOM element. Plugins that render their
   * header via `<PluginHeader>` (the new portal pattern) project into
   * this element from inside their main React tree. We take a ref —
   * not the element value — because `PluginHeaderHost` and
   * `PluginHost` both run their mount effects in the same commit, and
   * a state-backed value would still be `null` here even after the
   * header host's effect set it (React batches state updates between
   * effects). The ref is mutated synchronously in the header host's
   * mount effect, so reading `.current` from this host's mount effect
   * (which fires immediately after the header's) gets the right node.
   */
  headerSlotRef?: { current: HTMLElement | null };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const unmountRef = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    console.log(`[host] mount: ${plugin.id}`);

    async function loadPlugin() {
      try {
        const mod = await importPluginBundle(plugin.id);

        if (cancelled) {
          console.log(`[host] cancelled before mount: ${plugin.id}`);
          return;
        }

        const mount = mod.mount ?? mod.default;
        if (typeof mount !== "function") {
          throw new Error(
            `Plugin "${plugin.id}" does not export a mount function.`,
          );
        }

        // Plugin mounts its own React root into this container.
        // Pass parentFocusKey so the plugin can connect its focusable
        // elements to the shell's spatial-navigation tree, and
        // headerSlot so it can portal a dynamic topbar from inside
        // its tree (see `<PluginHeader>` in @loadout/ui).
        console.log(`[host] calling mount: ${plugin.id}`);
        const unmount = mount(container, {
          parentFocusKey: "content",
          headerSlot: headerSlotRef?.current ?? null,
        });
        unmountRef.current = typeof unmount === "function" ? unmount : null;
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        console.error(`[host] load failed: ${plugin.id}`, err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    loadPlugin();

    return () => {
      console.log(`[host] unmount: ${plugin.id}`);
      cancelled = true;
      // Unmount the plugin's React root. Do NOT follow with
      // `container.innerHTML = ""` — React's unmount already detaches
      // every node it placed, and racing a raw innerHTML wipe against
      // React's internal cleanup throws
      // `NotFoundError: The node to be removed is not a child of this
      // node` when a React effect cleanup tries to remove a node that
      // the innerHTML reset already took out.
      if (unmountRef.current) {
        try {
          unmountRef.current();
        } catch (err) {
          console.error(`[host] unmount error: ${plugin.id}`, err);
        }
        unmountRef.current = null;
      }
    };
  }, [plugin.id, headerSlotRef]);

  if (error) {
    return (
      <LoadErrorPanel pluginId={plugin.id} pluginName={plugin.name} errorMessage={error} />
    );
  }

  return (
    <div className="h-full animate-[fadeIn_150ms_ease-out]">
      {loading && (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-8">
          <div className="w-6 h-6 border-3 border-[var(--line-strong)] border-t-accent rounded-full animate-spin" />
          <p className="text-sm text-base-content/60">Loading {plugin.name}...</p>
        </div>
      )}
      <div
        ref={containerRef}
        data-scroll-root="plugin"
        className={loading ? "h-0 overflow-hidden" : "h-full overflow-clip"}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Load Error Panel — shown when a plugin fails to load (import / mount error)
// ---------------------------------------------------------------------------

function LoadErrorPanel({
  pluginId,
  pluginName,
  errorMessage,
}: {
  pluginId: string;
  pluginName: string;
  errorMessage: string;
}) {
  const [copyLabel, setCopyLabel] = useState("Copy Error");
  const [saveLabel, setSaveLabel] = useState("Save to ~/Downloads");

  const report = createErrorReport(
    pluginId,
    pluginName,
    new Error(errorMessage),
  );

  const handleCopy = useCallback(async () => {
    const ok = await copyErrorToClipboard(report);
    setCopyLabel(ok ? "Copied!" : "Copy failed");
    setTimeout(() => setCopyLabel("Copy Error"), 2000);
  }, [report]);

  const handleSave = useCallback(async () => {
    const filename = await saveErrorToDownloads(report);
    if (filename) {
      setSaveLabel(`Saved ${filename}`);
    } else {
      setSaveLabel("Save failed");
    }
    setTimeout(() => setSaveLabel("Save to ~/Downloads"), 3000);
  }, [report]);

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-8">
      <div className="bg-[color-mix(in_oklab,var(--color-error)_15%,transparent)] border border-[color-mix(in_oklab,var(--color-error)_30%,transparent)] rounded-lg p-6 max-w-[400px] text-center">
        <h3 className="text-base font-semibold text-[var(--color-error)] mb-2">Plugin failed to load</h3>
        <p className="text-[13px] text-base-content mb-3 break-words">
          {errorMessage}
        </p>
        <div className="flex gap-2 justify-center flex-wrap mt-1">
          <button
            className="bg-base-300 border-none rounded-md text-base-content text-xs font-medium px-3 py-1.5 cursor-pointer transition-colors duration-[120ms]"
            onClick={handleCopy}
          >
            {copyLabel}
          </button>
          <button
            className="bg-base-300 border-none rounded-md text-base-content text-xs font-medium px-3 py-1.5 cursor-pointer transition-colors duration-[120ms]"
            onClick={handleSave}
          >
            {saveLabel}
          </button>
        </div>
        <p className="text-xs text-base-content/60 mt-2">Check the console for details.</p>
      </div>
    </div>
  );
}
