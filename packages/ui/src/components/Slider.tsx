import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { useFocusable } from "../spatial-nav";

/**
 * Range slider with optional onCommit semantics.
 *
 * - `onChange` fires on every input event (controlled live updates).
 * - `onCommit` fires when the user is "done": pointerup, touchend, keyup,
 *   blur, or 600 ms after the last change (covers gamepad arrow nav,
 *   which has no natural release event).
 *
 * Use `onCommit` for callsites that write to a backend / IPC. That keeps
 * the slider visually responsive while debouncing expensive side-effects
 * (e.g. `pactl set-volume`, which would otherwise fire on every drag tick
 * and thrash both PipeWire and the renderer reacting to confirmation
 * events).
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
  const { ref, focused } = useFocusable({
    focusable: !disabled,
    onArrowPress: (direction) => {
      if (direction === "left" || direction === "right") {
        const delta = direction === "right" ? step : -step;
        const next = Math.max(min, Math.min(max, value + delta));
        if (next !== value) {
          window.__SL_SOUNDS__?.playSliderTick?.();
          onChange(next);
        }
        return false;
      }
      return true;
    },
  });

  // Track the most recent value seen during a drag so the commit-on-release
  // handlers and the idle-fallback timer always flush the latest, not a
  // stale closure.
  const latestRef = useRef(value);
  useEffect(() => {
    latestRef.current = value;
  }, [value]);

  // Idle fallback: if no pointer/keyup/blur fires within 600 ms of the
  // last change (e.g. user is still holding a controller direction), flush
  // the in-flight value so the backend doesn't lag the UI indefinitely.
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armIdleCommit = useCallback(() => {
    if (!onCommit) return;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      onCommit(latestRef.current);
    }, 600);
  }, [onCommit]);
  const cancelIdleCommit = () => {
    if (idleTimer.current) {
      clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
  };
  const flushNow = useCallback(() => {
    if (!onCommit) return;
    cancelIdleCommit();
    onCommit(latestRef.current);
  }, [onCommit]);

  // Cleanup any pending idle-commit when the slider unmounts.
  useEffect(() => () => cancelIdleCommit(), []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(Number(e.target.value));
      armIdleCommit();
    },
    [onChange, armIdleCommit],
  );

  const baseStyle: CSSProperties = accentColor ? { ...style, accentColor } : (style ?? {});
  const focusStyle: CSSProperties = focused
    ? { ...baseStyle, animation: "focusPulse 2s ease-in-out infinite" }
    : baseStyle;

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
      className={`range range-primary range-xs w-full transition-transform duration-150 ${focused ? "scale-[1.02] rounded-lg" : ""}`}
      style={focusStyle}
    />
  );
}
