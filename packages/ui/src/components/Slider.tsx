import { useCallback, useEffect, useRef, type CSSProperties, type ChangeEvent } from "react";
import { useFocusable } from "../spatial-nav";
import { applyFocusPulse, focusScaleClass } from "../focus-style";

/**
 * Range slider with optional onCommit semantics.
 *
 * `onChange` fires every input event. `onCommit` fires on pointerup,
 * touchend, keyup, blur, or 600 ms idle after the last change. Use
 * `onCommit` for callsites that write to backend / IPC so dragging
 * doesn't thrash with every tick.
 */
export function Slider({
  value,
  onChange,
  onCommit,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  accentColor,
  style,
}: {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  accentColor?: string;
  style?: CSSProperties;
}) {
  const { ref, focused } = useFocusable<HTMLInputElement>({
    focusable: !disabled,
    onArrowPress: (direction) => {
      if (direction !== "left" && direction !== "right") return true;
      const delta = direction === "right" ? step : -step;
      const next = Math.max(min, Math.min(max, value + delta));
      if (next !== value) onChange(next);
      return false;
    },
  });

  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armIdleCommit = useCallback(() => {
    if (!onCommit) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => onCommit(latest.current), 600);
  }, [onCommit]);
  const flushNow = useCallback(() => {
    if (!onCommit) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = null;
    onCommit(latest.current);
  }, [onCommit]);
  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      onChange(Number(e.target.value));
      armIdleCommit();
    },
    [onChange, armIdleCommit],
  );

  const baseStyle: CSSProperties | undefined = accentColor
    ? { ...(style ?? {}), accentColor }
    : style;

  return (
    <input
      ref={ref}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={handleChange}
      onPointerUp={flushNow}
      onTouchEnd={flushNow}
      onKeyUp={flushNow}
      onBlur={flushNow}
      disabled={disabled}
      className={`range range-primary range-xs w-full transition-transform duration-150 ${focusScaleClass(focused)} ${focused ? "rounded-lg" : ""}`}
      style={applyFocusPulse(focused, baseStyle)}
    />
  );
}
