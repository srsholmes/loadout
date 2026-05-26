import { useFocusable } from "../spatial-nav";
import { applyFocusPulse, focusScaleClass } from "../focus-style";

export function Toggle({
  checked,
  onChange,
  disabled,
  size = "default",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: "small" | "default";
}) {
  const { ref, focused } = useFocusable<HTMLInputElement>({
    focusable: !disabled,
    onEnterPress: () => {
      if (!disabled) onChange(!checked);
    },
  });

  return (
    <input
      ref={ref}
      type="checkbox"
      className={`toggle toggle-primary ${size === "small" ? "toggle-xs" : "toggle-sm"} transition-transform duration-150 ${focusScaleClass(focused)}`}
      style={applyFocusPulse(focused)}
      checked={checked}
      onChange={() => !disabled && onChange(!checked)}
      disabled={disabled}
    />
  );
}
