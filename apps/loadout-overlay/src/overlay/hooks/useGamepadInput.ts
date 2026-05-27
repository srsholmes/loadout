/**
 * Polls the Web Gamepad API and dispatches keyboard events for d-pad / sticks / buttons.
 *
 * @noriginmedia/norigin-spatial-navigation listens for arrow key events,
 * but gamepad d-pad inputs don't generate keyboard events in webviews.
 * This hook bridges the gap by polling navigator.getGamepads() and
 * dispatching synthetic KeyboardEvent for:
 *   - D-pad (buttons or axes) / left stick → ArrowUp, ArrowDown, ArrowLeft, ArrowRight
 *   - A button (index 0) → Enter
 *   - B button (index 1) → Escape
 */
import { useEffect, useRef } from "react";
import {
  RIGHT_STICK_DEADZONE,
  RIGHT_STICK_SPEED,
  SCROLL_FRICTION,
  SCROLL_MIN_VELOCITY,
} from "../lib/scroll-tuning";

const STICK_DEADZONE = 0.5;
const REPEAT_DELAY = 400; // ms before first repeat
const REPEAT_INTERVAL = 120; // ms between repeats

interface ButtonState {
  pressed: boolean;
  timestamp: number;
  lastRepeat: number;
}

// Button index → keyboard key (standard gamepad mapping)
const buttonKeyMap: Record<number, string> = {
  12: "ArrowUp", // d-pad up
  13: "ArrowDown", // d-pad down
  14: "ArrowLeft", // d-pad left
  15: "ArrowRight", // d-pad right
  0: "Enter", // A
  1: "Escape", // B
};

/** Walk up the DOM to find the nearest scrollable ancestor. */
function findScrollableAncestor(el: Element | null): Element | null {
  let current = el?.parentElement ?? null;
  while (current) {
    if (current.scrollHeight > current.clientHeight + 1) return current;
    current = current.parentElement;
  }
  return null;
}

export function useGamepadInput(onBack?: () => void) {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    // State is keyed by a unique ID (to allow multiple sources for the same key)
    // but fires the actual keyboard key name.
    const state = new Map<string, ButtonState>();
    let scrollVelocity = 0;

    // Gate the poller on the overlay actually being open. Under
    // gamescope, overlay.minimize() doesn't mark the page hidden —
    // rAF keeps ticking and navigator.getGamepads() keeps returning
    // live button states even while the user is back in the game.
    // Without this check we'd dispatch keyboard events into the
    // hidden UI, spatial-nav would move focus, and Steam UI select
    // sounds would play on every pad press.
    //
    // Default true so standalone dev (vite + no Bun host) keeps
    // working unchanged; in the real overlay the electrobun webview
    // boot fires an initial visibility CustomEvent before the first
    // rAF tick, so there's no "one frame of leakage" window.
    let overlayOpen = true;
    function onVisibility(e: Event): void {
      const detail = (e as CustomEvent<{ isOpen: boolean }>).detail;
      overlayOpen = detail?.isOpen ?? true;
      if (!overlayOpen) {
        state.clear();
        scrollVelocity = 0;
      }
    }
    window.addEventListener(
      "loadout:overlay-visibility",
      onVisibility as EventListener,
    );

    function fireKey(key: string, type: "keydown" | "keyup") {
      window.dispatchEvent(
        new KeyboardEvent(type, {
          key,
          code: key,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    /** stateId = unique tracker, keyName = the actual keyboard key to dispatch */
    function handlePress(stateId: string, keyName: string, pressed: boolean, now: number) {
      const prev = state.get(stateId);

      if (pressed) {
        if (!prev?.pressed) {
          // B button: call onBack directly (single fire, no repeat)
          if (keyName === "Escape" && onBackRef.current) {
            onBackRef.current();
          } else {
            fireKey(keyName, "keydown");
          }
          state.set(stateId, { pressed: true, timestamp: now, lastRepeat: now });
        } else if (now - prev.timestamp > REPEAT_DELAY && now - prev.lastRepeat > REPEAT_INTERVAL) {
          // Don't repeat B button — only arrows and A should repeat
          if (keyName !== "Escape") {
            fireKey(keyName, "keydown");
          }
          state.set(stateId, { ...prev, lastRepeat: now });
        }
      } else if (prev?.pressed) {
        if (keyName !== "Escape") {
          fireKey(keyName, "keyup");
        }
        state.set(stateId, { pressed: false, timestamp: 0, lastRepeat: 0 });
      }
    }

    let rafId: number;
    let debugLogged = false;

    function poll() {
      const gamepads = navigator.getGamepads?.();
      if (!gamepads || !overlayOpen) {
        rafId = requestAnimationFrame(poll);
        return;
      }

      const now = performance.now();

      for (const gp of gamepads) {
        if (!gp) continue;

        if (!debugLogged) {
          console.log("[gamepad] Connected:", gp.id, "buttons:", gp.buttons.length, "axes:", gp.axes.length);
          debugLogged = true;
        }

        // D-pad buttons (indices 12-15) and A/B (indices 0-1)
        for (const [index, key] of Object.entries(buttonKeyMap)) {
          const btn = gp.buttons[Number(index)];
          if (btn) {
            handlePress(`btn-${index}`, key, btn.pressed, now);
          }
        }

        // Left stick → arrow keys
        if (gp.axes.length >= 2) {
          const lx = gp.axes[0];
          const ly = gp.axes[1];
          handlePress("stick-left", "ArrowLeft", lx < -STICK_DEADZONE, now);
          handlePress("stick-right", "ArrowRight", lx > STICK_DEADZONE, now);
          handlePress("stick-up", "ArrowUp", ly < -STICK_DEADZONE, now);
          handlePress("stick-down", "ArrowDown", ly > STICK_DEADZONE, now);
        }

        // D-pad as axes — on Linux, d-pad often shows up as axes rather than
        // buttons. Typically axes 6/7 (Xbox), sometimes 4/5. Check all axis
        // pairs beyond the two sticks (axes 0-3).
        for (let ai = 4; ai < gp.axes.length; ai += 2) {
          if (ai + 1 >= gp.axes.length) break;
          const dx = gp.axes[ai];
          const dy = gp.axes[ai + 1];
          handlePress(`daxis${ai}-left`, "ArrowLeft", dx < -STICK_DEADZONE, now);
          handlePress(`daxis${ai}-right`, "ArrowRight", dx > STICK_DEADZONE, now);
          handlePress(`daxis${ai}-up`, "ArrowUp", dy < -STICK_DEADZONE, now);
          handlePress(`daxis${ai}-down`, "ArrowDown", dy > STICK_DEADZONE, now);
        }

        // Right stick → smooth analog scroll with momentum
        if (gp.axes.length >= 4) {
          const ry = gp.axes[3];
          if (Math.abs(ry) > RIGHT_STICK_DEADZONE) {
            scrollVelocity = ry * RIGHT_STICK_SPEED;
          } else {
            scrollVelocity *= SCROLL_FRICTION;
            if (Math.abs(scrollVelocity) < SCROLL_MIN_VELOCITY) scrollVelocity = 0;
          }
          if (Math.abs(scrollVelocity) > 0) {
            const focused = document.activeElement;
            const scrollable = findScrollableAncestor(focused);
            if (scrollable) {
              scrollable.scrollBy({ top: scrollVelocity });
            }
          }
        }

        // Only use the first connected gamepad
        break;
      }

      rafId = requestAnimationFrame(poll);
    }

    rafId = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener(
        "loadout:overlay-visibility",
        onVisibility as EventListener,
      );
    };
  }, []);
}
