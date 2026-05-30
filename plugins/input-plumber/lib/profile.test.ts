import { describe, it, expect } from "bun:test";
import {
  parseCapability,
  labelFor,
  buttonOptions,
  pickDefaultButton,
  ensureKeyboard,
  renderProfile,
  WAKE_KEY,
} from "./profile";

describe("parseCapability", () => {
  it("splits a colon-delimited capability into category + leaf name", () => {
    expect(parseCapability("Gamepad:Button:RightPaddle1")).toEqual({
      raw: "Gamepad:Button:RightPaddle1",
      category: "gamepad",
      name: "RightPaddle1",
    });
  });

  it("handles keyboard keys", () => {
    expect(parseCapability("Keyboard:KeyRecord")).toEqual({
      raw: "Keyboard:KeyRecord",
      category: "keyboard",
      name: "KeyRecord",
    });
  });

  it("tolerates a bare token", () => {
    const c = parseCapability("Weird");
    expect(c.name).toBe("Weird");
    expect(c.category).toBe("weird");
  });
});

describe("labelFor", () => {
  it("uses known labels for Steam Deck paddles", () => {
    expect(labelFor(parseCapability("Gamepad:Button:RightPaddle2"))).toBe("Right Back Paddle (R5)");
  });
  it("spaces out unknown gamepad names", () => {
    expect(labelFor(parseCapability("Gamepad:Button:LeftGrip"))).toBe("Left Grip");
  });
  it("humanises keyboard keys", () => {
    expect(labelFor(parseCapability("Keyboard:KeyRecord"))).toBe("Key Record");
  });
});

describe("buttonOptions", () => {
  const caps = [
    "Gamepad:Button:South",
    "Gamepad:Button:RightPaddle1",
    "Gamepad:Axis:LeftStick", // axis-like → dropped
    "Gamepad:Button:LeftStick", // stick button → dropped (axis-like name)
    "Keyboard:KeyRecord",
    "Mouse:Button:Left", // non-button category → dropped
    "Gamepad:Button:RightPaddle1", // duplicate → deduped
  ];

  it("drops axes, sticks, and non-button categories, and dedupes", () => {
    const opts = buttonOptions(caps);
    const names = opts.map((o) => o.name).sort();
    expect(names).toEqual(["KeyRecord", "RightPaddle1", "South"]);
  });

  it("flags gameplay buttons as not recommended, extras as recommended", () => {
    const opts = buttonOptions(caps);
    const south = opts.find((o) => o.name === "South")!;
    const paddle = opts.find((o) => o.name === "RightPaddle1")!;
    const kbd = opts.find((o) => o.name === "KeyRecord")!;
    expect(south.recommended).toBe(false);
    expect(paddle.recommended).toBe(true);
    expect(kbd.recommended).toBe(true);
  });

  it("orders recommended buttons before gameplay ones", () => {
    const opts = buttonOptions(caps);
    expect(opts[opts.length - 1].name).toBe("South");
  });
});

describe("pickDefaultButton", () => {
  it("prefers a right back paddle", () => {
    const d = pickDefaultButton([
      "Gamepad:Button:LeftPaddle1",
      "Gamepad:Button:RightPaddle2",
      "Keyboard:KeyRecord",
    ]);
    expect(d?.name).toBe("RightPaddle2");
  });

  it("falls back to a keyboard extra when no paddles exist", () => {
    const d = pickDefaultButton(["Gamepad:Button:South", "Keyboard:KeyRecord"]);
    expect(d?.name).toBe("KeyRecord");
  });

  it("returns null when there are no usable buttons", () => {
    expect(pickDefaultButton(["Gamepad:Axis:LeftStick"])).toBeNull();
  });
});

describe("ensureKeyboard", () => {
  it("appends keyboard, preserving existing controller targets", () => {
    expect(ensureKeyboard(["deck-uhid"])).toEqual(["deck-uhid", "keyboard"]);
  });
  it("drops null sinks and seeds a gamepad when empty", () => {
    expect(ensureKeyboard(["null"])).toEqual(["gamepad", "keyboard"]);
    expect(ensureKeyboard([])).toEqual(["gamepad", "keyboard"]);
  });
  it("does not duplicate an existing keyboard target", () => {
    expect(ensureKeyboard(["xb360", "mouse", "keyboard"])).toEqual(["xb360", "mouse", "keyboard"]);
  });
});

describe("renderProfile", () => {
  it("renders a gamepad-button → F16 mapping with preserved targets", () => {
    const yaml = renderProfile(parseCapability("Gamepad:Button:RightPaddle1"), ["deck-uhid"]);
    expect(yaml).toContain("kind: DefaultProfile");
    expect(yaml).toContain("- deck-uhid");
    expect(yaml).toContain("- keyboard");
    expect(yaml).toContain("gamepad:");
    expect(yaml).toContain("button: RightPaddle1");
    expect(yaml).toContain(`- keyboard: ${WAKE_KEY}`);
  });

  it("renders a keyboard source when the chosen button is a key", () => {
    const yaml = renderProfile(parseCapability("Keyboard:KeyRecord"), ["xb360", "mouse"]);
    expect(yaml).toContain("keyboard: KeyRecord");
    expect(yaml).not.toContain("button: KeyRecord");
    expect(yaml).toContain(`- keyboard: ${WAKE_KEY}`);
  });
});
