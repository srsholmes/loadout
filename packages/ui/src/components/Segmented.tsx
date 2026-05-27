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
  const { ref } = useFocusable({
    onEnterPress: () => {
      if (disabled) return;
      sounds()?.playSelect?.();
      onSelect();
    },
    focusable: !disabled,
  });

  const classes = [active ? "active" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={classes}
      style={style}
    >
      {children}
    </button>
  );
}
