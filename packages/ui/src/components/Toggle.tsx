import { type CSSProperties } from "react";
import { useFocusable } from "../spatial-nav";

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
  const { ref, focused } = useFocusable({
    onEnterPress: () => {
      if (!disabled) {
        const sounds = window.__SL_SOUNDS__;
        if (!checked) sounds?.playToggleOn?.();
        else sounds?.playToggleOff?.();
        onChange(!checked);
      }
    },
    focusable: !disabled,
  });

  const focusStyle: CSSProperties | undefined = focused
    ? { animation: "focusPulse 2s ease-in-out infinite" }
    : undefined;

  return (
    <input
      ref={ref}
      type="checkbox"
      className={`toggle toggle-primary ${size === "small" ? "toggle-xs" : "toggle-sm"} transition-transform duration-150 ${focused ? "scale-[1.02]" : ""}`}
      style={focusStyle}
      checked={checked}
      onChange={() => !disabled && onChange(!checked)}
      disabled={disabled}
    />
  );
}
