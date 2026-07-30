/**
 * The horizontal tab strip.
 *
 * Built in-plugin rather than on `@loadout/ui`'s `TabBar` for two reasons.
 * The practical one: `TabBar` takes `{id, label}[]` and has no room for match
 * counts, overflow scrolling, or a per-tab menu. The structural one: adding a
 * new `@loadout/ui` export forces a full overlay rebuild and reinstall, while
 * an in-plugin component does not — so anything only this plugin needs belongs
 * here.
 *
 * The count on each tab is not decoration. It is the difference between
 * "my Deck Verified tab is empty, is it broken?" and seeing `0` before you
 * click, and it costs nothing because evaluation happens locally.
 */

import { useEffect, useRef } from "react";
import { Badge, useFocusable } from "@loadout/ui";

export interface TabStripEntry {
  id: string;
  label: string;
  /** Match count, or `undefined` while the library is still loading. */
  count?: number;
  /** Rendered dimmed with a tooltip — a tab whose data source is missing. */
  unavailable?: boolean;
}

export interface TabStripProps {
  tabs: TabStripEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Opens the per-tab menu (Y on a controller, ⋯ button with a pointer). */
  onOpenMenu?: (id: string) => void;
  showCounts?: boolean;
  /**
   * Horizontal padding *inside* the scroll area, in px.
   *
   * The caller bleeds this strip out past the page's padding so it can scroll
   * edge to edge; the inset has to live on the scrolling element itself or the
   * first and last tab sit flush against the screen. Putting it on a wrapper
   * instead just cancels the bleed.
   */
  edgePadding?: number;
}

interface TabButtonProps {
  entry: TabStripEntry;
  active: boolean;
  showCount: boolean;
  onSelect: () => void;
  onOpenMenu?: () => void;
}

function TabButton({
  entry,
  active,
  showCount,
  onSelect,
  onOpenMenu,
}: TabButtonProps) {
  const { ref, focused } = useFocusable({
    onEnterPress: onSelect,
    // Y opens the tab's menu. Returning true lets the arrow keep
    // propagating so left/right still move between tabs.
    onArrowPress: () => true,
  });

  // Keep the active tab in view when the strip overflows. A library with
  // fifteen tabs scrolls, and a gamepad user moving right must not lose
  // sight of where they are.
  //
  // Scrolls the strip itself rather than calling `scrollIntoView`, which walks
  // up and scrolls *every* scrollable ancestor. The plugin's page container is
  // one — `overflow-y: auto` makes the x axis compute to `auto` too — so
  // selecting a tab near the right end dragged the whole page sideways and
  // clipped its left edge. `overflow-x: hidden` does not help: a hidden
  // overflow container is still programmatically scrollable.
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!(active || focused)) return;
    const button = buttonRef.current;
    const strip = button?.parentElement;
    if (!button || !strip) return;

    const left = button.offsetLeft;
    const right = left + button.offsetWidth;
    if (left < strip.scrollLeft) {
      strip.scrollLeft = left;
    } else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, [active, focused]);

  return (
    <button
      ref={(node) => {
        buttonRef.current = node;
        (ref as { current: HTMLElement | null }).current = node;
      }}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onContextMenu={
        onOpenMenu
          ? (event) => {
              event.preventDefault();
              onOpenMenu();
            }
          : undefined
      }
      // 44px minimum touch target per DESIGN.md.
      className={[
        "flex shrink-0 items-center gap-2 rounded-lg px-4 min-h-[44px]",
        "border transition-colors",
        active
          ? "bg-base-300 border-primary text-base-content"
          : "bg-base-200 border-transparent text-base-content/70 hover:text-base-content",
        focused ? "ring-2 ring-primary ring-offset-1 ring-offset-base-100" : "",
        entry.unavailable ? "opacity-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      title={
        entry.unavailable
          ? "Some of this tab's rules need data that isn't available yet"
          : undefined
      }
    >
      <span className="truncate max-w-[14rem]">{entry.label}</span>
      {showCount && entry.count !== undefined ? (
        <Badge variant={entry.count === 0 ? "neutral" : "primary"}>
          {entry.count}
        </Badge>
      ) : null}
    </button>
  );
}

export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onOpenMenu,
  showCounts = true,
  edgePadding = 0,
}: TabStripProps) {
  if (tabs.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Library tabs"
      // Horizontal scroll rather than wrapping: a wrapped strip reflows the
      // grid below it every time a count changes, which reads as jitter.
      className="flex gap-2 overflow-x-auto pb-1"
      style={edgePadding ? { paddingInline: edgePadding } : undefined}
    >
      {tabs.map((entry) => (
        <TabButton
          key={entry.id}
          entry={entry}
          active={entry.id === activeId}
          showCount={showCounts}
          onSelect={() => onSelect(entry.id)}
          onOpenMenu={onOpenMenu ? () => onOpenMenu(entry.id) : undefined}
        />
      ))}
    </div>
  );
}
