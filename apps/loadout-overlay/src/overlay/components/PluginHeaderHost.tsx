import { useEffect, useRef, useState } from "react";
import { FaStar, FaRegStar } from "react-icons/fa6";
import { importPluginBundle } from "../lib/backend";
import type { PluginInfo } from "../hooks/usePlugins";
import { useFavorites } from "../hooks/useFavorites";
import { Focusable } from "./GamepadNav";

/**
 * Probe a plugin bundle for its `mountHeader` export. The overlay shell
 * uses this to decide whether to reserve the 60px topbar at all — if
 * the plugin declines the header, the entire bar collapses and the
 * plugin body gets the full vertical column.
 *
 * Returns:
 *   - `undefined` while the probe is in flight (initial render + switch)
 *   - `true` / `false` once the bundle has resolved
 *
 * Cheap after the first call because `importPluginBundle` is cached.
 */
export function usePluginHasHeader(
  plugin: PluginInfo | null,
): boolean | undefined {
  const [has, setHas] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    if (!plugin) {
      setHas(undefined);
      return;
    }
    let cancelled = false;
    setHas(undefined);
    importPluginBundle(plugin.id)
      .then((mod) => {
        if (cancelled) return;
        setHas(typeof mod.mountHeader === "function");
      })
      .catch(() => {
        if (!cancelled) setHas(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-run only when the plugin identity changes. `plugin` itself is a
    // fresh object on every parent render because it comes from `plugins.find`,
    // so depending on the whole object would thrash the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin?.id]);
  return has;
}

/**
 * Renders a plugin's page-header into the overlay topbar.
 *
 * Mirrors the `mountHomeWidget` pattern: the plugin exports
 * `mountHeader(container, opts)` which creates its own React root and
 * owns the rendered tree. The host gives the plugin a sized container
 * and unmounts it when the active plugin changes.
 *
 * If the plugin doesn't export `mountHeader`, this returns `null` — the
 * shell is expected to have already decided not to render the topbar
 * at all via `usePluginHasHeader`, so we don't second-guess that.
 */
export function PluginHeaderHost({
  plugin,
  onSlot,
}: {
  plugin: PluginInfo;
  /**
   * Callback fired with the topbar DOM element when it's available
   * (and `null` when the host unmounts). Used by `App.tsx` to plumb
   * the same DOM node through to `PluginHost.headerSlot` so a plugin
   * can portal a dynamic header from inside its body via
   * `<PluginHeader>`.
   */
  onSlot?: (el: HTMLElement | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const unmountRef = useRef<(() => void) | null>(null);
  const [hasHeader, setHasHeader] = useState<boolean | null>(null);

  // Expose the topbar DOM element to the lifted ref so `PluginHost`
  // can pass it down to `mount(..., { headerSlot })`. Both callers
  // see the same element. We also explicitly emit `null` on unmount
  // so the body knows the slot has gone away.
  useEffect(() => {
    onSlot?.(containerRef.current);
    return () => onSlot?.(null);
  }, [onSlot]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    console.log(`[header] mount: ${plugin.id}`);

    async function loadHeader() {
      try {
        const mod = await importPluginBundle(plugin.id);
        if (cancelled) {
          console.log(`[header] cancelled before mount: ${plugin.id}`);
          return;
        }

        const mountHeader = mod.mountHeader as
          | ((c: HTMLElement, opts?: { parentFocusKey?: string }) => (() => void) | void)
          | undefined;

        if (typeof mountHeader !== "function") {
          console.log(`[header] no mountHeader export: ${plugin.id}`);
          setHasHeader(false);
          return;
        }

        console.log(`[header] calling mountHeader: ${plugin.id}`);
        // TS loses the outer `!container` narrow across the async callback boundary
        if (!container) return;
        const unmount = mountHeader(container, { parentFocusKey: "header" });
        unmountRef.current = typeof unmount === "function" ? unmount : null;
        setHasHeader(true);
      } catch (err) {
        console.error(`[header] load failed: ${plugin.id}`, err);
        if (!cancelled) setHasHeader(false);
      }
    }

    loadHeader();

    return () => {
      console.log(`[header] unmount: ${plugin.id}`);
      cancelled = true;
      // See PluginHost for why `container.innerHTML = ""` is omitted —
      // React's root.unmount() already detaches, and racing a raw wipe
      // against React's internal effect cleanup throws NotFoundError.
      if (unmountRef.current) {
        try {
          unmountRef.current();
        } catch (err) {
          console.error(`[header] unmount error: ${plugin.id}`, err);
        }
        unmountRef.current = null;
      }
    };
  }, [plugin.id]);

  if (hasHeader === false) return null;
  // `flex-1 min-w-0` (not `w-full`): the shell renders a fixed-width
  // favorite-star sibling to the right of this slot, so we must yield
  // its space rather than reserving 100% and pushing siblings out of
  // the visible area. Plugins using the new portal pattern still get
  // a full-row container (because flex-1 grows to fill remaining width),
  // so their internal `justify-between` for title-block + right-side
  // controls keeps working — the star simply sits a `gap-4` further
  // right than those controls.
  return <div ref={containerRef} className="flex items-center flex-1 min-w-0" />;
}

/**
 * Star toggle anchored to the topbar's right edge by the shell. Mirrors
 * the Sidebar's hover-revealed star but is always visible and gamepad-
 * focusable, so users in Big Picture / handheld mode have a stable
 * target for favoriting the active plugin without hunting the sidebar.
 *
 * Lives here (not inside any plugin's `mountHeader`) so the favorite
 * concept stays a shell concern — adding new plugins doesn't require
 * remembering to wire the star into each one.
 */
export function PluginFavoriteButton({ pluginId }: { pluginId: string }) {
  const { isFavorite, toggle } = useFavorites();
  const favorited = isFavorite(pluginId);
  const label = favorited ? "Remove from favorites" : "Add to favorites";
  const Icon = favorited ? FaStar : FaRegStar;
  return (
    <Focusable
      focusKey={`header-favorite-${pluginId}`}
      onActivate={() => toggle(pluginId)}
    >
      <button
        type="button"
        onClick={() => toggle(pluginId)}
        aria-label={label}
        aria-pressed={favorited}
        title={label}
        tabIndex={-1}
        className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 transition-colors ${
          favorited
            ? "text-warning hover:text-warning"
            : "text-base-content/50 hover:text-warning hover:bg-base-300/70"
        }`}
      >
        <Icon className="w-4 h-4" aria-hidden />
      </button>
    </Focusable>
  );
}

/**
 * Stacked title-over-subtitle header. Used by the shell for Home,
 * Settings, the Loadout fallback, and (via App.tsx) plugins
 * that don't export `mountHeader` — keeps every view's topbar shape
 * aligned with the `<PluginHeader>` portal pattern.
 */
export function DefaultHeader({ title, sub }: { title: string; sub?: string }) {
  // Stacked title-over-subtitle, matching the layout every
  // `<PluginHeader>`-portal plugin renders themselves. Used by Home,
  // Settings, the Loadout fallback, and (via App.tsx) plugins
  // that don't export `mountHeader` — so every view's topbar has the
  // same shape.
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight truncate">
        {title}
      </h1>
      {sub && (
        <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
          {sub}
        </span>
      )}
    </div>
  );
}
