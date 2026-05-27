import { type ReactNode, createContext, useContext } from "react";
import { createPortal } from "react-dom";

/**
 * The DOM element the overlay shell reserves for the active plugin's
 * topbar. The shell passes it down to each plugin's `mount()` via
 * `opts.headerSlot`; `PluginProvider` stashes it in this context so
 * `<PluginHeader>` (and any deeper consumer) can portal into it.
 *
 * `null` means "no header slot available" — either the shell didn't
 * reserve one (rare), or the plugin opted out by not exporting
 * `mountHeader`.
 */
const PluginHeaderSlotContext = createContext<HTMLElement | null>(null);

/**
 * Internal: set the header-slot element so descendants can portal
 * into it. Used by `PluginProvider`. Plugin authors normally don't
 * touch this directly.
 */
export function PluginHeaderSlotProvider({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PluginHeaderSlotContext.Provider value={slot}>
      {children}
    </PluginHeaderSlotContext.Provider>
  );
}

/**
 * Render the wrapped JSX into the overlay shell's topbar slot via a
 * React portal. Lives inside the same React tree as the plugin body
 * — read state, share callbacks, all colocated.
 *
 * If no slot is wired (e.g. plugin opted out of having a header, or
 * the host can't reserve one), nothing is rendered.
 *
 * Usage:
 *   ```tsx
 *   <PluginHeader>
 *     <h1>SteamGridDB</h1>
 *     <p>{game ? game.name : "Custom artwork for your library"}</p>
 *   </PluginHeader>
 *   ```
 */
export function PluginHeader({ children }: { children: ReactNode }) {
  const slot = useContext(PluginHeaderSlotContext);
  if (!slot) return null;
  return createPortal(<>{children}</>, slot);
}
