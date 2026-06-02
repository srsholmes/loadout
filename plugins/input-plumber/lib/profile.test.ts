import { describe, it, expect } from "bun:test";
import {
  parseCapability,
  labelFor,
  buttonOptions,
  ensureKeyboard,
  renderProfile,
  renderCaptureProfile,
  SENTINEL_KEYS,
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

describe("buttonOptions — gamepad before keyboard within recommended", () => {
  // The catch-all capture profile has only ~11 sentinel slots. With the
  // OXP Apex's 150+ keyboard capabilities + a handful of gamepad extras,
  // we MUST sort gamepad-recommended above keyboard-recommended so the
  // user's physical handheld extras (paddles, QAM) win sentinel slots over
  // KeyF13/F14/... — otherwise the catch-all maps only F-keys and the
  // user's button never emits a sentinel.
  it("sorts gamepad extras before keyboard extras", () => {
    const opts = buttonOptions([
      "Keyboard:KeyF13",
      "Keyboard:KeyF14",
      "Gamepad:Button:RightPaddle1",
      "Gamepad:Button:Keyboard",
      "Keyboard:KeyRecord",
    ]);
    const recommended = opts.filter((o) => o.recommended);
    const firstKeyboardIdx = recommended.findIndex((o) => o.category === "keyboard");
    const lastGamepadIdx = recommended.map((o, i) => ({ o, i }))
      .filter(({ o }) => o.category === "gamepad")
      .pop()?.i ?? -1;
    expect(lastGamepadIdx).toBeGreaterThanOrEqual(0);
    expect(firstKeyboardIdx).toBeGreaterThan(lastGamepadIdx);
  });
});

describe("renderCaptureProfile", () => {
  it("maps each recommended button to a unique sentinel key", () => {
    const opts = buttonOptions([
      "Gamepad:Button:RightPaddle1",
      "Gamepad:Button:LeftPaddle1",
      "Gamepad:Button:Keyboard",
      "Keyboard:KeyRecord",
    ]);
    const { yaml, sentinelToRaw } = renderCaptureProfile(opts, ["deck-uhid"]);
    // The sentinelToRaw map keys are Linux keycodes (numbers).
    const codes = Array.from(sentinelToRaw.keys());
    expect(codes.length).toBe(4);
    // All codes come from the SENTINEL_KEYS table.
    const sentinelCodes = new Set(SENTINEL_KEYS.map((s) => s.code));
    for (const c of codes) expect(sentinelCodes.has(c)).toBe(true);
    // All four button raws are represented in the map values.
    const raws = new Set(sentinelToRaw.values());
    expect(raws.has("Gamepad:Button:RightPaddle1")).toBe(true);
    expect(raws.has("Gamepad:Button:LeftPaddle1")).toBe(true);
    expect(raws.has("Gamepad:Button:Keyboard")).toBe(true);
    expect(raws.has("Keyboard:KeyRecord")).toBe(true);
    // YAML has one mapping per button.
    const mappingCount = (yaml.match(/^\s*- name:/gm) || []).length;
    expect(mappingCount).toBe(4);
    expect(yaml).toContain("kind: DefaultProfile");
    expect(yaml).toContain("- deck-uhid");
    expect(yaml).toContain("- keyboard");
  });

  it("silently drops buttons past the SENTINEL_KEYS limit", () => {
    // Synthesize more recommended buttons than sentinel slots.
    const caps: string[] = [];
    for (let i = 1; i <= SENTINEL_KEYS.length + 3; i++) {
      caps.push(`Gamepad:Button:Paddle${i}`);
    }
    // Mark them all recommended by including some real extras + paddles.
    // (Paddle1-N aren't in our allowlist except for LeftPaddle1/RightPaddle1
    // etc., so use the real ones plus padding gameplay-style extras.)
    const realCaps = [
      "Gamepad:Button:LeftPaddle1",
      "Gamepad:Button:LeftPaddle2",
      "Gamepad:Button:RightPaddle1",
      "Gamepad:Button:RightPaddle2",
      "Gamepad:Button:Keyboard",
      "Gamepad:Button:QuickAccess",
      "Gamepad:Button:QuickAccess2",
      "Gamepad:Button:LeftTop",
      "Gamepad:Button:RightTop",
      "Gamepad:Button:Mute",
      "Gamepad:Button:Screenshot",
      "Gamepad:Button:Share",
      "Keyboard:KeyRecord",
    ];
    const opts = buttonOptions(realCaps);
    const { sentinelToRaw } = renderCaptureProfile(opts, ["gamepad"]);
    expect(sentinelToRaw.size).toBeLessThanOrEqual(SENTINEL_KEYS.length);
    expect(sentinelToRaw.size).toBe(SENTINEL_KEYS.length);
  });

  it("emits a gamepad source for gamepad buttons and a keyboard source for keys", () => {
    const opts = buttonOptions([
      "Gamepad:Button:RightPaddle1",
      "Keyboard:KeyRecord",
    ]);
    const { yaml } = renderCaptureProfile(opts, ["xb360"]);
    expect(yaml).toContain("button: RightPaddle1");
    expect(yaml).toContain("keyboard: KeyRecord");
    expect(yaml).not.toContain("button: KeyRecord");
  });

  it("returns an empty mapping when there are no recommended buttons", () => {
    const opts = buttonOptions(["Gamepad:Button:South"]); // gameplay only
    const { yaml, sentinelToRaw } = renderCaptureProfile(opts, ["gamepad"]);
    expect(sentinelToRaw.size).toBe(0);
    // YAML still well-formed (no mapping entries, but header + target_devices).
    expect(yaml).toContain("kind: DefaultProfile");
  });
});
