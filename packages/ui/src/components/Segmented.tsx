import { type CSSProperties, type ReactNode } from "react";
import { useFocusable } from "../spatial-nav";

const sounds = () => window.__SL_SOUNDS__;

/**
 * One button inside a `.segmented` control. Wraps a plain `<button>` with
 * `useFocusable` so the d-pad can reach it — the global `.segmented >
 * button` CSS still applies because the rendered element IS a
 * `<button>`. Use alongside the existing `<div className="segmented">`
 * wrapper in plugins:
 *
 *   <div className="segmented w-full">
 *     {options.map((opt) => (
 *       <SegmentedItem
 *         key={opt.value}
 *         active={value === opt.value}
 *         onSelect={() => setValue(opt.value)}
 *         style={{ flex: 1 }}
 *       >
 *         {opt.label}
 *       </SegmentedItem>
 *     ))}
 *   </div>
 */
export function SegmentedItem({
  children,
  active,
  onSelect,
  disabled,
  style,
  className,
}: {
  children: ReactNode;
  active: boolean;
  onSelect: () => void;
  disabled?: boolean;
  style?: CSSProperties;
  /** Extra classes in addition to the automatic `active` class. */
  className?: string;
}) {
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (disabled) return;
      sounds()?.playSelect?.();
      onSelect();
    },
    focusable: !disabled,
  });

  // Focus was reachable by d-pad but invisible: this took `ref` and dropped
  // `focused`, and there is no :focus rule for `.segmented > button` in the
  // shell CSS. So a controller user could move through a segmented control
  // with nothing on screen changing — indistinguishable from it not being
  // navigable at all. Same pulse-and-scale Button/Slider/Toggle already use.
  //
  // (The transition class is inert here: the shell's unlayered
  // `.segmented > button { transition: all 120ms }` beats a Tailwind utility
  // in @layer utilities, so the scale animates at 120ms. Kept for
  // consistency with the other controls, and it applies if that rule goes.)
  const classes = [
    active ? "active" : "",
    "transition-transform duration-100",
    focused ? "scale-[1.02]" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const focusStyle: CSSProperties = focused
    ? { ...style, animation: "focusPulse 2s ease-in-out infinite" }
    : style ?? {};

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={classes}
      style={focusStyle}
    >
      {children}
    </button>
  );
}
