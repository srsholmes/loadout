// Default DOM-level dispatcher used when no plugin handler claims a
// keystroke. Mutates `document.activeElement` to mirror what a real
// keyboard would have done.
//
// The crux: React's controlled-input contract reads value via the
// element's installed `_valueTracker`; assigning `el.value = "..."`
// directly is silently ignored on the next render. The native
// prototype value setter bypasses the tracker, and the dispatched
// `InputEvent` triggers React's onChange path.

import type { ResolvedKey } from "@loadout/ui";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

// Last text-like element the user focused. Updated by App.tsx's
// focusin listener via `rememberLastInput` and consulted by the
// dispatcher when the user taps an OSK key. Using this instead of
// reading `document.activeElement` at dispatch time bypasses the
// "OSK button steals focus" failure mode — `react-simple-keyboard`
// can call `.focus()` programmatically on its buttons, and our
// preventDefault on the native event handlers doesn't stop those
// programmatic focus shifts.
let lastInput: HTMLElement | null = null;

export function rememberLastInput(el: Element | null | undefined): void {
  if (el && isTextLike(el)) {
    lastInput = el as HTMLElement;
  }
}

export function getLastInput(): HTMLElement | null {
  // Drop the cached element if it's been removed from the DOM (plugin
  // unmounted, modal closed, etc.) — falling back to activeElement is
  // better than typing into a detached node.
  if (lastInput && !document.body.contains(lastInput)) {
    lastInput = null;
  }
  return lastInput;
}

const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "email",
  "password",
  "tel",
  "number",
  "",
]);

export function isTextLike(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName;
  if (tag === "INPUT") {
    const t = ((el as HTMLInputElement).type || "text").toLowerCase();
    return TEXT_INPUT_TYPES.has(t);
  }
  if (tag === "TEXTAREA") return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

function nativeSet(el: EditableElement, value: string): void {
  // Walk the prototype chain — INPUT and TEXTAREA each install their
  // own `value` setter, so we have to grab the right one.
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
}

function fireInputEvent(
  el: HTMLElement,
  inputType: string,
  data: string | null,
): void {
  // beforeinput fires first (cancellable), then input (the one React
  // observes). We don't actually let beforeinput cancel anything since
  // by the time we're here the user has already pressed an OSK key —
  // honoring a cancel would be a UX trap.
  el.dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType,
      data,
    }),
  );
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: false,
      inputType,
      data,
    }),
  );
}

function insertTextInto(el: EditableElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  nativeSet(el, next);
  try {
    el.selectionStart = el.selectionEnd = start + text.length;
  } catch {
    // <input type="number"> rejects selectionStart writes — non-fatal.
  }
  fireInputEvent(el, "insertText", text);
}

function deleteBackward(el: EditableElement): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const cutFrom = start === end ? Math.max(0, start - 1) : start;
  if (cutFrom === end) return;
  const next = el.value.slice(0, cutFrom) + el.value.slice(end);
  nativeSet(el, next);
  try {
    el.selectionStart = el.selectionEnd = cutFrom;
  } catch {
    // see above
  }
  fireInputEvent(el, "deleteContentBackward", null);
}

function submitOrEnter(el: HTMLElement): void {
  // Prefer form submission so React-heavy forms run their onSubmit
  // pipelines (validation, navigation, etc.).
  const form = (el as HTMLInputElement).form;
  if (form && typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return;
  }
  if (form && typeof form.submit === "function") {
    form.submit();
    return;
  }
  // No form — dispatch a synthetic Enter keydown/keyup. Synthetic
  // events lack `isTrusted`, but most "press Enter to search" handlers
  // in our overlay UI listen on plain keydown without checking trust.
  const opts: KeyboardEventInit = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

/** Apply a resolved OSK keystroke to the user's last-focused text
 *  input. Consults `lastInput` first (set by App.tsx's focusin
 *  listener) so we type into the right element even after an OSK
 *  button click reassigns `document.activeElement`. Falls back to
 *  `document.activeElement` if no input has been remembered yet
 *  (e.g. the user clicked the footer toggle without focusing
 *  anything). No-ops silently if neither resolves to a text-like
 *  element — clicking the OSK with no input focused does nothing. */
export function defaultDomDispatch(k: ResolvedKey): void {
  let el: HTMLElement | null = getLastInput();
  if (!el || !isTextLike(el)) {
    el = (document.activeElement as HTMLElement | null) ?? null;
  }
  if (!el) return;
  const tag = el.tagName;
  const isInput = tag === "INPUT" || tag === "TEXTAREA";
  const isCE = el.isContentEditable === true;
  if (!isInput && !isCE) return;

  // Re-focus before mutating so :focus styles, focus-gated
  // listeners, and "what the user thinks is focused" all line up.
  // Idempotent — if the element is already activeElement, this is
  // a no-op.
  if (document.activeElement !== el) {
    try {
      (el as HTMLElement).focus({ preventScroll: true });
    } catch {
      // Some inputs (disabled, detached) reject focus calls — fall
      // through and try the mutation anyway.
    }
  }

  if (k.type === "char" || k.type === "space") {
    const text = k.type === "space" ? " " : k.value;
    if (isInput) {
      insertTextInto(el as EditableElement, text);
    } else {
      try {
        document.execCommand("insertText", false, text);
      } catch {
        // contentEditable in some sandboxed contexts rejects
        // execCommand — best-effort only, no good fallback exists.
      }
    }
    return;
  }

  if (k.type === "backspace") {
    if (isInput) {
      deleteBackward(el as EditableElement);
    } else {
      try {
        document.execCommand("delete");
      } catch {
        // see above
      }
    }
    return;
  }

  if (k.type === "enter") {
    submitOrEnter(el);
    return;
  }
}
