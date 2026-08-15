/**
 * The obscured-gate runs as a string inside Steam's CEF, so it can't be
 * imported and called. These tests evaluate the generated source against a
 * hand-rolled fake window/document — small enough to keep honest, and it
 * pins the behaviour that matters: a focus *burst* must not strobe the badge.
 */
import { describe, it, expect } from "bun:test";
import { buildObscuredGateScript, OBSCURED_SETTLE_MS } from "./injector";

const CLASS = "loadout-badges-obscured";

type Listener = () => void;

/** Fake DOM + a controllable clock; only the surface the gate touches. */
function harness(opts: { focused?: boolean; visible?: boolean } = {}) {
  let focused = opts.focused ?? true;
  let visible = opts.visible ?? true;
  const classes = new Set<string>();
  const winListeners = new Map<string, Listener[]>();
  const docListeners = new Map<string, Listener[]>();

  let now = 0;
  const timers = new Map<number, { at: number; fn: Listener }>();
  let nextTimer = 1;

  const on = (m: Map<string, Listener[]>) => (evt: string, fn: Listener) => {
    const list = m.get(evt) ?? [];
    list.push(fn);
    m.set(evt, list);
  };
  const off = (m: Map<string, Listener[]>) => (evt: string, fn: Listener) => {
    m.set(evt, (m.get(evt) ?? []).filter((f) => f !== fn));
  };

  const win: Record<string, unknown> = {
    addEventListener: on(winListeners),
    removeEventListener: off(winListeners),
  };
  const doc = {
    addEventListener: on(docListeners),
    removeEventListener: off(docListeners),
    hasFocus: () => focused,
    get visibilityState() {
      return visible ? "visible" : "hidden";
    },
    documentElement: {
      classList: {
        toggle: (c: string, on_: boolean) => {
          if (on_) classes.add(c);
          else classes.delete(c);
        },
        remove: (c: string) => classes.delete(c),
      },
    },
  };

  const setTimeoutFn = (fn: Listener, ms: number) => {
    const id = nextTimer++;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  const clearTimeoutFn = (id: number) => void timers.delete(id);

  return {
    win,
    /** Total class toggles applied — the strobe counter. */
    toggles: 0,
    run(src: string) {
      new Function("window", "document", "setTimeout", "clearTimeout", src)(
        win,
        doc,
        setTimeoutFn,
        clearTimeoutFn,
      );
    },
    fire(evt: "focus" | "blur", state: boolean) {
      focused = state;
      for (const fn of winListeners.get(evt) ?? []) fn();
    },
    setVisible(v: boolean) {
      visible = v;
      for (const fn of docListeners.get("visibilitychange") ?? []) fn();
    },
    /** Advance the clock, firing anything due. */
    tick(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    obscured: () => classes.has(CLASS),
    pendingTimers: () => timers.size,
  };
}

describe("obscured gate", () => {
  const src = buildObscuredGateScript("protondb-badges");

  it("shows the badge while the window is focused and visible", () => {
    const h = harness();
    h.run(src);
    expect(h.obscured()).toBe(false);
  });

  it("hides once a blur has held for the settle delay", () => {
    const h = harness();
    h.run(src);

    h.fire("blur", false);
    // Not yet — the edge has to settle first.
    expect(h.obscured()).toBe(false);
    h.tick(OBSCURED_SETTLE_MS);
    expect(h.obscured()).toBe(true);
  });

  it("swallows a focus burst instead of strobing", () => {
    const h = harness();
    h.run(src);

    // The measured SteamOS pattern: 5 transitions inside one frame budget,
    // settling back on focus. Nothing should ever be applied.
    for (const state of [false, true, false, true, false]) {
      h.fire(state ? "focus" : "blur", state);
      h.tick(10);
    }
    h.fire("focus", true);
    expect(h.obscured()).toBe(false);

    h.tick(OBSCURED_SETTLE_MS);
    expect(h.obscured()).toBe(false);
  });

  it("restores the badge once focus comes back and settles", () => {
    const h = harness();
    h.run(src);

    h.fire("blur", false);
    h.tick(OBSCURED_SETTLE_MS);
    expect(h.obscured()).toBe(true);

    h.fire("focus", true);
    h.tick(OBSCURED_SETTLE_MS);
    expect(h.obscured()).toBe(false);
  });

  it("hides on visibilitychange even without a blur", () => {
    const h = harness();
    h.run(src);

    h.setVisible(false);
    h.tick(OBSCURED_SETTLE_MS);
    expect(h.obscured()).toBe(true);
  });

  it("fails open: never-focused documents keep their badge", () => {
    // A build where Steam doesn't route focus to this document at all.
    const h = harness({ focused: false });
    h.run(src);
    h.fire("blur", false);
    h.tick(OBSCURED_SETTLE_MS * 4);
    expect(h.obscured()).toBe(false);
  });

  it("cleanup removes the class, the listeners and any pending timer", () => {
    const h = harness();
    h.run(src);

    h.fire("blur", false);
    h.tick(OBSCURED_SETTLE_MS);
    expect(h.obscured()).toBe(true);

    const gate = h.win["__loadout_badge_gate_protondb_badges"] as {
      cleanup: () => void;
    };
    gate.cleanup();
    expect(h.obscured()).toBe(false);
    expect(h.pendingTimers()).toBe(0);

    // Listeners are gone: further edges do nothing.
    h.fire("blur", false);
    h.tick(OBSCURED_SETTLE_MS * 4);
    expect(h.obscured()).toBe(false);
  });

  it("re-running the script re-arms rather than double-binding", () => {
    const h = harness();
    h.run(src);
    h.run(src);

    h.fire("blur", false);
    h.tick(OBSCURED_SETTLE_MS);
    expect(h.obscured()).toBe(true);
    expect(h.pendingTimers()).toBe(0);
  });
});
