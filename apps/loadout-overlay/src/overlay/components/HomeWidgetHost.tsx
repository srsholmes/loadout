import { useState, useEffect, useRef } from "react";
import { Spinner } from "@loadout/ui";
import { useFocusable } from "./GamepadNav";
import { importPluginBundle } from "../lib/backend";

const sounds = () => window.__SL_SOUNDS__;

interface HomeWidgetHostProps {
  pluginId: string;
  pluginName: string;
  isEditing: boolean;
  onRemove: () => void;
}

/**
 * Loads and renders a plugin's homepage widget inside a card.
 *
 * The card itself is d-pad-focusable (A opens the full plugin view, or
 * removes the widget in edit mode) AND its mounted plugin's internal
 * focusables register as children of the card — so you can both select
 * the widget as a tile AND d-pad into the sliders / segmented buttons
 * inside it.
 */
export function HomeWidgetHost({
  pluginId,
  pluginName,
  isEditing,
  onRemove,
}: HomeWidgetHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const unmountRef = useRef<(() => void) | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  // Focus target lives on the widget card div itself so the
  // :focus-visible box-shadow renders around the card's outer border
  // instead of an invisible `inset-0` overlay that got clipped by the
  // card's `overflow-hidden`.
  const widgetFocusKey = `home-widget-${pluginId}`;
  // Widgets are read-only on the homepage — pressing A only does
  // something in edit mode (remove the widget). Outside edit mode
  // we don't navigate to the plugin page: home is the surface for
  // glanceable info, the sidebar is where the user picks a plugin
  // to interact with. Keeping Enter inert avoids accidental
  // route changes while focus rolls over a widget tile.
  const { ref, focused } = useFocusable({
    focusKey: widgetFocusKey,
    trackChildren: true,
    saveLastFocusedChild: true,
    onEnterPress: () => {
      if (isEditing) {
        sounds()?.playSelect?.();
        onRemove();
      }
    },
    onFocus: () => {
      sounds()?.playNav?.();
    },
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;

    async function loadWidget() {
      try {
        const mod = await importPluginBundle(pluginId);
        if (cancelled) return;

        const mount = mod.mountHomeWidget ?? mod.mountWidget;
        if (typeof mount !== "function") {
          setError(true);
          return;
        }

        // Nest plugin focusables under the widget card so d-pad can
        // navigate into sliders / segmented buttons rendered inside
        // the widget instead of jumping straight between tiles.
        const unmount = mount(container, { parentFocusKey: widgetFocusKey });
        unmountRef.current = typeof unmount === "function" ? unmount : null;
        setLoaded(true);
      } catch {
        if (!cancelled) setError(true);
      }
    }

    loadWidget();

    return () => {
      cancelled = true;
      // Unmount the plugin's React root. Do NOT follow with
      // `container.innerHTML = ""` — React's unmount already detaches
      // every node it placed, and racing a raw innerHTML wipe against
      // React's internal cleanup throws `NotFoundError: The node to be
      // removed is not a child of this node` when a React effect
      // cleanup tries to remove a node innerHTML already took out.
      if (unmountRef.current) {
        try {
          unmountRef.current();
        } catch (err) {
          console.error(`[home-widget] unmount error: ${pluginId}`, err);
        }
        unmountRef.current = null;
      }
    };
  }, [pluginId, widgetFocusKey]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={`widget h-full relative overflow-hidden group transition-transform duration-150 ease-out ${focused ? "scale-[1.02]" : ""}`}
      aria-label={`Open ${pluginName}`}
    >
      {isEditing && (
        <div className="widget-handle widget-drag-handle" title="Drag to move">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="9" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/>
            <circle cx="15" cy="6" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="15" cy="18" r="1.2"/>
          </svg>
        </div>
      )}
      {isEditing && (
        <button
          type="button"
          className="absolute top-2 right-2 z-20 w-6 h-6 rounded-md grid place-items-center text-base-content/40 bg-base-300/80 hover:text-error hover:bg-error/20 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Remove widget"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      )}

      <div ref={containerRef} className="h-full" />

      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <span className="text-sm text-base-content/40">
            {pluginName} widget unavailable
          </span>
        </div>
      )}

      {!loaded && !error && (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <Spinner variant="dots" size="sm" />
        </div>
      )}
    </div>
  );
}
