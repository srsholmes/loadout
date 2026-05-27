// App-wide on-screen keyboard, rendered at the bottom of the overlay
// shell. Backed by `react-simple-keyboard` for the rendering layer; we
// own keystroke routing (default → DOM dispatcher; plugins can register
// custom handlers via the singleton store).
//
// Layouts: `default` is QWERTY-with-digits, `shift` is its uppercase /
// shifted-symbol twin, `symbols` is the punctuation-heavy layout, and
// `symbolsShift` is the shifted version of that. Modifier buttons —
// `{shift}`, `{symbols}`, `{close}` — are intercepted internally and
// never reach the dispatcher.
//
// Hold-to-repeat: react-simple-keyboard fires `onKeyPress` once on press
// and `onKeyReleased` once on release. We arm a 500 ms delay timer on
// press, then a 40 ms repeat interval after the delay. Toggle keys skip
// the timer entirely (holding shift would just thrash the layout state).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import KeyboardReact from "react-simple-keyboard";
// IMPORTANT: do NOT import react-simple-keyboard/build/css here. It's
// imported once at the top of packages/overlay/src/index.css BEFORE our
// theme overrides. Importing it again from the component bundle injects
// the default CSS *after* our overrides, undoing them and producing
// white-on-white keys.
import {
  dispatchKey as dispatchKeyToStore,
  pushBackInterceptor,
  setKeyboardDefaultHandler,
  setKeyboardVisible,
  useOverlayKeyboard,
  type ResolvedKey,
} from "@loadout/ui";
import { defaultDomDispatch } from "../lib/keystrokeDispatcher";

// X11-default-style timings; matched exact existing OSK behavior.
const REPEAT_DELAY_MS = 500;
const REPEAT_INTERVAL_MS = 40;

// Layouts use react-simple-keyboard's space-separated-row schema. Each
// row is one string. `{name}` syntax marks special keys whose label
// comes from the `display` map below. Char keys carry the literal
// character.
const LAYOUTS = {
  default: [
    "1 2 3 4 5 6 7 8 9 0 {bksp}",
    "q w e r t y u i o p",
    "a s d f g h j k l {enter}",
    "{shift} z x c v b n m , . ?",
    "{symbols} / {space} - {close}",
  ],
  shift: [
    "! @ # $ % ^ & * ( ) {bksp}",
    "Q W E R T Y U I O P",
    "A S D F G H J K L {enter}",
    "{shift} Z X C V B N M < > ?",
    "{symbols} / {space} _ {close}",
  ],
  symbols: [
    "1 2 3 4 5 6 7 8 9 0 {bksp}",
    "- _ = + / \\ : ;",
    "( ) [ ] { } < > {enter}",
    "{shift} @ # $ & | ~ ^ * ! ? %",
    "{layout} , {space} . {close}",
  ],
  symbolsShift: [
    "1 2 3 4 5 6 7 8 9 0 {bksp}",
    "- _ = + / \\ : ;",
    "( ) [ ] { } < > {enter}",
    "{shift} @ # $ & | ~ ^ * ! ? %",
    "{layout} , {space} . {close}",
  ],
};

const DISPLAY = {
  "{bksp}": "⌫",
  "{enter}": "Go",
  "{shift}": "⇧",
  "{symbols}": "123",
  "{layout}": "abc",
  "{close}": "✕",
  "{space}": " ",
};

/** Buttons that should NOT auto-repeat when held — toggling them
 *  rapidly via key-repeat is a UX trap. */
const TOGGLE_KEYS = new Set([
  "{shift}",
  "{symbols}",
  "{layout}",
  "{close}",
]);

type LayoutName = keyof typeof LAYOUTS;

function resolveButton(button: string): ResolvedKey | null {
  if (button === "{bksp}") return { type: "backspace" };
  if (button === "{enter}") return { type: "enter" };
  if (button === "{space}") return { type: "space" };
  // Single character (printable) — emit as char.
  if (button.length === 1) return { type: "char", value: button };
  // Modifier / unknown — handled internally.
  return null;
}

export function OverlayKeyboard() {
  const { visible } = useOverlayKeyboard();
  const [layoutName, setLayoutName] = useState<LayoutName>("default");

  // Register the default DOM dispatcher with the singleton at mount.
  // Plugin-registered handlers run first (LIFO); this is the fallback.
  useEffect(() => {
    setKeyboardDefaultHandler(defaultDomDispatch);
    return () => setKeyboardDefaultHandler(null);
  }, []);

  // Hide on Escape — gated on `visible` so a closed keyboard doesn't
  // swallow Escapes meant for modals / drawers / plugins.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setKeyboardVisible(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  // Push a B-button back-interceptor while visible so gamepad B closes
  // the keyboard before falling through to the plugin's back handler.
  // Mirrors how modals + dropdowns absorb back navigation.
  useEffect(() => {
    if (!visible) return;
    return pushBackInterceptor(() => {
      setKeyboardVisible(false);
      return true;
    });
  }, [visible]);

  const holdRef = useRef<{
    delay: ReturnType<typeof setTimeout> | null;
    interval: ReturnType<typeof setInterval> | null;
    watchdog: ReturnType<typeof setTimeout> | null;
  }>({ delay: null, interval: null, watchdog: null });

  const stopHold = useCallback(() => {
    if (holdRef.current.delay) {
      clearTimeout(holdRef.current.delay);
      holdRef.current.delay = null;
    }
    if (holdRef.current.interval) {
      clearInterval(holdRef.current.interval);
      holdRef.current.interval = null;
    }
    if (holdRef.current.watchdog) {
      clearTimeout(holdRef.current.watchdog);
      holdRef.current.watchdog = null;
    }
  }, []);

  // Layout swap unmounts the held button — RSK won't fire onKeyReleased
  // for a key that no longer exists. Tear down explicitly.
  useEffect(() => stopHold, [layoutName, stopHold, visible]);

  // Document-level safety net: if the user releases off the button,
  // touchcancels (e.g. swiping over the OSK), or any other release
  // event fires anywhere, stop the hold. Without this, a touch that
  // ends with `touchcancel` instead of `touchend` (very common on
  // jittery handheld touchscreens) leaves RSK's onKeyReleased
  // un-fired and the repeat interval running forever — the user
  // can't type because backspace is grinding through their input.
  useEffect(() => {
    if (!visible) return;
    const stop = () => stopHold();
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
    document.addEventListener("mouseup", stop, true);
    document.addEventListener("touchend", stop, true);
    document.addEventListener("touchcancel", stop, true);
    // Any pointer leaving the OSK area also stops repeat — prevents
    // the "press and slide off" edge case from sticking.
    document.addEventListener("pointerleave", stop, true);
    return () => {
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
      document.removeEventListener("mouseup", stop, true);
      document.removeEventListener("touchend", stop, true);
      document.removeEventListener("touchcancel", stop, true);
      document.removeEventListener("pointerleave", stop, true);
    };
  }, [visible, stopHold]);

  const handleButton = useCallback(
    (button: string) => {
      // Modifier handling — these never reach the dispatcher.
      if (button === "{shift}") {
        setLayoutName((l) =>
          l === "default" ? "shift" : l === "shift" ? "default" :
          l === "symbols" ? "symbolsShift" : "symbols",
        );
        return;
      }
      if (button === "{symbols}") {
        setLayoutName("symbols");
        return;
      }
      if (button === "{layout}") {
        setLayoutName("default");
        return;
      }
      if (button === "{close}") {
        setKeyboardVisible(false);
        return;
      }

      const resolved = resolveButton(button);
      if (!resolved) return;

      dispatchKeyToStore(resolved);

      // Auto-release shift after a single character — sticky shift is
      // confusing on a software keyboard. Same UX as the old OSK.
      if (resolved.type === "char" && layoutName === "shift") {
        setLayoutName("default");
      } else if (resolved.type === "char" && layoutName === "symbolsShift") {
        setLayoutName("symbols");
      }

      // Hide on Enter — default DOM dispatch treats Enter as the
      // natural "I'm done" for input fields. Plugins that want
      // Enter without dismissing the OSK can register their own
      // keystroke handler upstream of the default.
      if (resolved.type === "enter") {
        setKeyboardVisible(false);
      }
    },
    [layoutName],
  );

  const onKeyPress = useCallback(
    (button: string) => {
      // Defensive: clear any prior hold state. If a previous repeat
      // got stuck because the release event never fired, pressing
      // any new key cancels it — restores the user's ability to type
      // even when the document-level release listeners (above) miss
      // an event. Without this, a stuck backspace repeat would
      // ignore subsequent keys.
      stopHold();
      handleButton(button);
      if (TOGGLE_KEYS.has(button)) return;
      // Watchdog: an absolute upper bound on how long any single
      // hold can repeat. 5 s is plenty for any human-realistic hold
      // and bounds the worst-case "stuck repeat" damage if every
      // release path somehow fails.
      holdRef.current.watchdog = setTimeout(stopHold, 5000);
      // Initial press just fired — arm the delay then the interval.
      holdRef.current.delay = setTimeout(() => {
        holdRef.current.delay = null;
        holdRef.current.interval = setInterval(() => {
          handleButton(button);
        }, REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },
    [handleButton, stopHold],
  );

  const onKeyReleased = useCallback(() => {
    stopHold();
  }, [stopHold]);

  // RSK accepts a typed `layout` map but its types insist on string-key
  // string-array dictionaries. Cast at the boundary; the data shape is
  // correct.
  const layout = useMemo(
    () => LAYOUTS as unknown as Record<string, string[]>,
    [],
  );

  // Attach capture-phase native listeners that preventDefault for every
  // input start event — mouse, pointer, AND touch. React's `onMouseDown`
  // alone leaks focus on touchscreens (touchstart fires first, doesn't
  // trip the React mouse handler) and on bubble-phase only (default
  // focus action runs after react bubble already, which is fine, BUT
  // RSK's own internal listeners may shift focus before our bubble
  // handler runs). Capture phase + every event type is the only
  // bulletproof way to keep document.activeElement on the user's input.
  //
  // Without this, defaultDomDispatch reads document.activeElement on
  // each keystroke and finds the OSK's <button> instead of the
  // plugin's <input> — typing goes nowhere.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    const prevent = (e: Event) => e.preventDefault();
    node.addEventListener("mousedown", prevent, true);
    node.addEventListener("pointerdown", prevent, true);
    node.addEventListener("touchstart", prevent, { capture: true, passive: false });
    return () => {
      node.removeEventListener("mousedown", prevent, true);
      node.removeEventListener("pointerdown", prevent, true);
      node.removeEventListener("touchstart", prevent, true);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      ref={wrapperRef}
      id="overlay-osk"
      style={{ flexShrink: 0 }}
    >
      <KeyboardReact
        layout={layout}
        layoutName={layoutName}
        display={DISPLAY}
        onKeyPress={onKeyPress}
        onKeyReleased={onKeyReleased}
        physicalKeyboardHighlight={false}
        // RSK supports `mergeDisplay`; we use the full DISPLAY map so
        // pass `false` to keep the literal `{key}` names off the buttons.
        mergeDisplay={false}
      />
    </div>
  );
}
