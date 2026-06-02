import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkfifoSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEventNode } from "./wake-trigger";

// `findEventNode` is the bit that picks IP's *fresh* virtual keyboard out
// of /proc/bus/input/devices after a LoadProfilePath. The risk is real:
// IP destroys the old node and creates a new one on every load, so the
// /proc dump can briefly contain *both* — the old one mid-tear-down and
// the new one with the actual events. Picking the wrong one means the
// evdev read stalls until the timeout.

describe("findEventNode", () => {
  it("returns null when no block matches the name", () => {
    const proc = `I: Bus=0000 Vendor=0000 Product=0000 Version=0000
N: Name="Power Button"
H: Handlers=kbd event0
`;
    expect(findEventNode(proc, "InputPlumber Keyboard")).toBeNull();
  });

  it("picks the only match when there's just one", () => {
    const proc = `I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="Power Button"
H: Handlers=kbd event0

I: Bus=0001 Vendor=0001 Product=0001 Version=0001
N: Name="InputPlumber Keyboard"
H: Handlers=sysrq kbd event12
`;
    expect(findEventNode(proc, "InputPlumber Keyboard")).toBe("/dev/input/event12");
  });

  it("prefers the highest-numbered eventN when multiple matches exist (IP recreate race)", () => {
    // Simulating /proc dump during IP profile reload: old keyboard at event7
    // hasn't been GC'd yet, new keyboard at event11. We must pick event11.
    const proc = `I: Bus=0001 Vendor=0001 Product=0001 Version=0001
N: Name="InputPlumber Keyboard"
H: Handlers=sysrq kbd event7

I: Bus=0001 Vendor=0001 Product=0001 Version=0001
N: Name="InputPlumber Keyboard"
H: Handlers=sysrq kbd event11
`;
    expect(findEventNode(proc, "InputPlumber Keyboard")).toBe("/dev/input/event11");
  });

  it("skips blocks without a Handlers line", () => {
    const proc = `I: Bus=0001 Vendor=0001 Product=0001 Version=0001
N: Name="InputPlumber Keyboard"
P: Phys=
S: Sysfs=/devices/virtual/input/input26

I: Bus=0001 Vendor=0001 Product=0001 Version=0001
N: Name="InputPlumber Keyboard"
H: Handlers=event5
`;
    expect(findEventNode(proc, "InputPlumber Keyboard")).toBe("/dev/input/event5");
  });

  it("skips blocks where Handlers has no eventN token", () => {
    const proc = `I: Bus=0001 Vendor=0001 Product=0001 Version=0001
N: Name="InputPlumber Keyboard"
H: Handlers=mouse0 js0
`;
    expect(findEventNode(proc, "InputPlumber Keyboard")).toBeNull();
  });

  it("handles double-blank-line block separation", () => {
    const proc = `I: Bus=0019 Vendor=0000 Product=0000 Version=0000
N: Name="Power Button"
H: Handlers=kbd event0


I: Bus=0001 Vendor=0001 Product=0001 Version=0001
N: Name="InputPlumber Keyboard"
H: Handlers=sysrq kbd event14
`;
    expect(findEventNode(proc, "InputPlumber Keyboard")).toBe("/dev/input/event14");
  });

  it("requires exact name match (no substring)", () => {
    const proc = `I: Bus=0001 Vendor=0001 Product=0001 Version=0001
N: Name="InputPlumber Keyboard 2"
H: Handlers=event3
`;
    expect(findEventNode(proc, "InputPlumber Keyboard")).toBeNull();
  });
});
