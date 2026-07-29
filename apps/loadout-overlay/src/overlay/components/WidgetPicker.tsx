import { useState, useEffect } from "react";
import { pushBackInterceptor, Spinner } from "@loadout/ui";
import { Focusable, useFocusable, FocusContext } from "./GamepadNav";
import type { PluginInfo } from "../hooks/usePlugins";
import { importPluginBundle } from "../lib/backend";

interface WidgetPickerProps {
  plugins: PluginInfo[];
  favorites: string[];
  onToggle: (pluginId: string) => void;
  /** Now Playing card visibility — surfaced as a built-in pseudo-widget. */
  showNowPlaying: boolean;
  onToggleNowPlaying: () => void;
  onClose: () => void;
}

/**
 * Modal overlay listing plugins that provide a homepage widget.
 * Users can add/remove plugins from their homepage favorites.
 */
export function WidgetPicker({
  plugins,
  favorites,
  onToggle,
  showNowPlaying,
  onToggleNowPlaying,
  onClose,
}: WidgetPickerProps) {
  const [widgetAvailability, setWidgetAvailability] = useState<Record<string, boolean>>({});
  const [probing, setProbing] = useState(true);

  const { ref: rootRef, focusKey, focusSelf } = useFocusable({
    focusKey: "widget-picker",
    trackChildren: true,
    saveLastFocusedChild: true,
    isFocusBoundary: true,
  });

  // Register back interceptor so B button closes the picker
  useEffect(() => {
    const remove = pushBackInterceptor(() => {
      onClose();
      return true;
    });
    return remove;
  }, [onClose]);

  // Auto-focus when mounted
  useEffect(() => {
    focusSelf();
  }, [focusSelf]);

  // Probe each plugin to detect if it exports mountHomeWidget
  useEffect(() => {
    let cancelled = false;

    async function probe() {
      const results: Record<string, boolean> = {};
      await Promise.all(
        plugins.map(async (p) => {
          try {
            const mod = await importPluginBundle(p.id);
            results[p.id] = typeof mod.mountHomeWidget === "function" || typeof mod.mountWidget === "function";
          } catch {
            results[p.id] = false;
          }
        }),
      );
      if (!cancelled) {
        setWidgetAvailability(results);
        setProbing(false);
      }
    }

    probe();
    return () => { cancelled = true; };
  }, [plugins]);

  const availablePlugins = plugins.filter((p) => widgetAvailability[p.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <FocusContext.Provider value={focusKey}>
        <div
          ref={rootRef}
          className="bg-base-100 rounded-2xl border border-base-300 shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col overflow-hidden animate-[viewEnter_180ms_ease-out]"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-base-300 shrink-0">
            <h3 className="text-lg font-bold text-base-content">Add Widgets</h3>
            <Focusable onActivate={onClose}>
              <button
                className="btn btn-ghost btn-sm text-base-content/50 min-w-11 min-h-11"
                onClick={onClose}
              >
                &#x2715;
              </button>
            </Focusable>
          </div>

          {/* Plugin list */}
          <div className="flex-1 overflow-y-auto p-3">
            {/* Built-in: Now Playing card. Lives above the plugin list
                so users find it before scrolling through plugins. */}
            <Focusable onActivate={onToggleNowPlaying}>
              <button
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors hover:bg-base-200 min-h-[52px]"
                onClick={onToggleNowPlaying}
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                    showNowPlaying
                      ? "bg-primary text-primary-content"
                      : "bg-base-300/70 text-base-content/50"
                  }`}
                >
                  ▶
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-base-content truncate">
                    Now Playing card
                  </div>
                  <div className="text-xs text-base-content/40 truncate">
                    Hero artwork + game title at the top of the home page.
                  </div>
                </div>
                <div
                  className={`text-xs font-semibold px-3 py-1 rounded-lg ${
                    showNowPlaying
                      ? "bg-error/15 text-error"
                      : "bg-primary/15 text-primary"
                  }`}
                >
                  {showNowPlaying ? "Remove" : "Add"}
                </div>
              </button>
            </Focusable>
            <div className="border-t border-base-300/50 my-2" />
            {probing && (
              <div className="flex items-center justify-center py-8">
                <Spinner variant="dots" size="md" />
              </div>
            )}
            {!probing && availablePlugins.length === 0 && (
              <div className="text-center py-8 text-base-content/40 text-sm">
                No plugins with widgets available.
              </div>
            )}
            {!probing &&
              availablePlugins.map((plugin) => {
                const isAdded = favorites.includes(plugin.id);
                const initial = (plugin.icon ?? plugin.name).charAt(0).toUpperCase();
                return (
                  <Focusable
                    key={plugin.id}
                    onActivate={() => onToggle(plugin.id)}
                  >
                    <button
                      className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-colors hover:bg-base-200 min-h-[52px]"
                      onClick={() => onToggle(plugin.id)}
                    >
                      <div
                        className={`w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                          isAdded
                            ? "bg-primary text-primary-content"
                            : "bg-base-300/70 text-base-content/50"
                        }`}
                      >
                        {initial}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-base-content truncate">
                          {plugin.name}
                        </div>
                        <div className="text-xs text-base-content/40 truncate">
                          {plugin.description}
                        </div>
                      </div>
                      <div
                        className={`text-xs font-semibold px-3 py-1 rounded-lg ${
                          isAdded
                            ? "bg-error/15 text-error"
                            : "bg-primary/15 text-primary"
                        }`}
                      >
                        {isAdded ? "Remove" : "Add"}
                      </div>
                    </button>
                  </Focusable>
                );
              })}
          </div>
        </div>
      </FocusContext.Provider>
    </div>
  );
}
