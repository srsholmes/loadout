import { describe, it, expect } from "bun:test";
import { decideInputStrategy } from "./input-strategy";

const base = {
  isDeck: false,
  ipAvailable: false,
  deckHidrawOpened: false,
  suspendEnv: undefined,
  deckCaptureEnv: undefined,
};

describe("decideInputStrategy", () => {
  it("IP host (APEX): identical to pre-Deck behavior", () => {
    expect(decideInputStrategy({ ...base, ipAvailable: true })).toEqual({
      deckNavActive: false,
      readVirtualPadsForNav: false,
      grabDeckBuiltinNodes: false,
      suspendSteamEnabled: true,
    });
  });

  it("Deck with working hidraw watcher: full Deck strategy", () => {
    expect(
      decideInputStrategy({ ...base, isDeck: true, deckHidrawOpened: true }),
    ).toEqual({
      deckNavActive: true,
      readVirtualPadsForNav: false,
      grabDeckBuiltinNodes: true,
      suspendSteamEnabled: true,
    });
  });

  it("Deck with FAILED hidraw watcher: exact legacy fallback (no freeze, virtual-pad nav)", () => {
    // Freezing Steam with no hidraw nav source would strand the user with
    // zero nav — must fall back to today's behavior wholesale.
    expect(
      decideInputStrategy({ ...base, isDeck: true, deckHidrawOpened: false }),
    ).toEqual({
      deckNavActive: false,
      readVirtualPadsForNav: true,
      grabDeckBuiltinNodes: false,
      suspendSteamEnabled: false,
    });
  });

  it("DECK_OVERLAY_DECK_CAPTURE=0 kill switch restores legacy Deck behavior", () => {
    expect(
      decideInputStrategy({
        ...base,
        isDeck: true,
        deckHidrawOpened: true,
        deckCaptureEnv: "0",
      }),
    ).toEqual({
      deckNavActive: false,
      readVirtualPadsForNav: true,
      grabDeckBuiltinNodes: false,
      suspendSteamEnabled: false,
    });
  });

  it("Deck WITH IP composites: IP wins, Deck strategy stays off", () => {
    expect(
      decideInputStrategy({
        ...base,
        isDeck: true,
        ipAvailable: true,
        deckHidrawOpened: true,
      }),
    ).toEqual({
      deckNavActive: false,
      readVirtualPadsForNav: false,
      grabDeckBuiltinNodes: false,
      suspendSteamEnabled: true,
    });
  });

  it("non-Deck, non-IP host (Bazzite desktop): legacy evdev path", () => {
    expect(decideInputStrategy({ ...base })).toEqual({
      deckNavActive: false,
      readVirtualPadsForNav: true,
      grabDeckBuiltinNodes: false,
      suspendSteamEnabled: false,
    });
  });

  it("DECK_OVERLAY_SUSPEND_STEAM=1 forces the freeze on regardless of strategy", () => {
    expect(decideInputStrategy({ ...base, suspendEnv: "1" }).suspendSteamEnabled).toBe(true);
    expect(
      decideInputStrategy({
        ...base,
        isDeck: true,
        deckHidrawOpened: false,
        suspendEnv: "1",
      }).suspendSteamEnabled,
    ).toBe(true);
  });

  it("DECK_OVERLAY_SUSPEND_STEAM=0 forces the freeze off but keeps deck nav", () => {
    const s = decideInputStrategy({
      ...base,
      isDeck: true,
      deckHidrawOpened: true,
      suspendEnv: "0",
    });
    expect(s.suspendSteamEnabled).toBe(false);
    expect(s.deckNavActive).toBe(true); // nav-without-freeze debug mode
    expect(s.grabDeckBuiltinNodes).toBe(true);
  });

  it("hidraw watcher open on a NON-Deck host does not enable the Deck strategy", () => {
    // findDeckHidrawPath is VID/PID-gated so this shouldn't happen, but the
    // strategy must not rely on it.
    expect(
      decideInputStrategy({ ...base, deckHidrawOpened: true }).deckNavActive,
    ).toBe(false);
  });
});
