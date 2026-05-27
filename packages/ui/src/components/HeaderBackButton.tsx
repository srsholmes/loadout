/**
 * Reusable back button for plugin headers. Two things in one:
 *
 *   1. Renders an `<IconButton>` with a left-arrow glyph so the user can
 *      click/tap it to go back.
 *   2. Pushes `onBack` onto the shell's back-interceptor stack for the
 *      lifetime of the component, so a B-button (or Escape) press while
 *      the back arrow is visible runs `onBack` instead of falling
 *      through to the shell-level back (which would otherwise close the
 *      plugin and drop focus into the sidebar).
 *
 * Plugins typically render this in their portaled `<PluginHeader>` slot
 * when they're on a nested view that has somewhere to back-out to (a
 * settings card opened via the gear icon, a SGDB picker after selecting
 * a game, etc.). When this component is NOT mounted, the shell's
 * default back behaviour resumes — closing the overlay or returning
 * focus to the sidebar.
 *
 * Example:
 *
 *     {nested ? (
 *       <HeaderBackButton onBack={() => setNested(false)} />
 *     ) : (
 *       <IconButton onClick={...}><FaGear /></IconButton>
 *     )}
 */
import { useEffect, useRef } from "react";
import { FaArrowLeft } from "react-icons/fa6";
import { IconButton } from "./IconButton";
import { pushBackInterceptor } from "../spatial-nav";

export interface HeaderBackButtonProps {
  /** Fired on click, B-button press, or Escape. */
  onBack: () => void;
  /** Tooltip / accessible label. Defaults match the common "Back to library"
   *  copy used across plugins. */
  title?: string;
  ariaLabel?: string;
  /** Optional icon-size override. Matches the existing inline pattern
   *  (`<FaArrowLeft size={11} />`) by default. */
  iconSize?: number;
}

/**
 * Hook variant — use this when you need to render the back button
 * yourself (different styling, embedded inside a larger control) but
 * still want the interceptor wiring. Push/pop on mount/unmount.
 */
export function useHeaderBack(onBack: () => void): void {
  // Keep the latest `onBack` in a ref so the interceptor closure
  // never goes stale — the closure is set up once at mount time but
  // the component's `onBack` may change every render.
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    return pushBackInterceptor(() => {
      onBackRef.current();
      // Returning `true` tells the shell's back chain that this
      // interceptor handled the event — don't fall through to the
      // shell-level back (which would close the plugin entirely).
      return true;
    });
  }, []);
}

export function HeaderBackButton({
  onBack,
  title = "Back",
  ariaLabel,
  iconSize = 11,
}: HeaderBackButtonProps) {
  useHeaderBack(onBack);
  return (
    <IconButton
      onClick={onBack}
      title={title}
      ariaLabel={ariaLabel ?? title}
    >
      <FaArrowLeft size={iconSize} />
    </IconButton>
  );
}
