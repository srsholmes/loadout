/**
 * Input-strategy decision — pure, so every row of the host matrix is
 * unit-testable (pattern: wake-routing.ts).
 *
 * Three host shapes exist:
 *
 *  1. IP-managed handheld (OXP APEX …): InputPlumber composites exist. Nav
 *     arrives over IP's DBus stream, the Steam virtual pad is a grab-only
 *     mirror, and Steam is frozen (SIGSTOP) while the overlay is open so its
 *     direct hidraw reads can't drive BPM behind us. UNCHANGED by the Deck
 *     work — this path is working in the field.
 *
 *  2. Steam Deck, no IP composites: Steam Input owns the built-in controller
 *     via hidraw, which EVIOCGRAB can never intercept, and the virtual X360
 *     pad only exists while a game runs — in BPM home there is NO evdev nav
 *     source at all. The Deck strategy reads nav from our own hidraw stream
 *     (deck-hidraw-watcher), makes every built-in evdev node grab-only, and
 *     freezes Steam in game mode for capture. Freezing is only safe when the
 *     hidraw watcher actually opened — a Deck where it failed (EACCES) must
 *     keep today's behavior or the user is stranded with zero nav.
 *
 *  3. Everything else (Bazzite desktop, dev boxes): plain evdev grab+read,
 *     virtual pads read for nav, no freeze.
 *
 * Kill switches:
 *   DECK_OVERLAY_DECK_CAPTURE=0    — disable the Deck strategy entirely
 *                                    (falls back to shape 3 behavior).
 *   DECK_OVERLAY_SUSPEND_STEAM=1/0 — force the Steam freeze on/off
 *                                    independent of strategy (pre-existing).
 */

export interface InputStrategyInputs {
  /** DMI says this is a Steam Deck (Jupiter/Galileo/Valve). */
  isDeck: boolean;
  /** InputPlumber has ≥1 CompositeDevice (ipHandle.available). */
  ipAvailable: boolean;
  /** startDeckHidrawWatcher returned a live handle. */
  deckHidrawOpened: boolean;
  /** process.env.DECK_OVERLAY_SUSPEND_STEAM — "1" force on, "0" force off. */
  suspendEnv: string | undefined;
  /** process.env.DECK_OVERLAY_DECK_CAPTURE — "0" disables the Deck strategy. */
  deckCaptureEnv: string | undefined;
}

export interface InputStrategy {
  /** Drive overlay nav from the Deck hidraw stream while open. */
  deckNavActive: boolean;
  /** Read Steam virtual pads (28de:11ff) for nav vs grab-only. */
  readVirtualPadsForNav: boolean;
  /** EVIOCGRAB all Deck built-in evdev nodes while intercepting. */
  grabDeckBuiltinNodes: boolean;
  /** SIGSTOP Steam while the overlay is open (game mode only; the
   *  toggleOverlay call site additionally gates on isGameModeActive()). */
  suspendSteamEnabled: boolean;
}

export function decideInputStrategy(i: InputStrategyInputs): InputStrategy {
  // IP composites present → IP owns nav + intercept, even on a Deck the
  // user pointed IP at. The Deck strategy only covers the IP-less Deck.
  const deckCaptureWanted =
    i.deckCaptureEnv !== "0" && i.isDeck && !i.ipAvailable;
  const deckNavActive = deckCaptureWanted && i.deckHidrawOpened;

  const readVirtualPadsForNav = !i.ipAvailable && !deckNavActive;

  // Auto: freeze wherever nav does NOT depend on a live Steam process —
  // IP DBus nav, or our own hidraw nav. The evdev-virtual-pad fallback
  // (readVirtualPadsForNav) needs Steam alive to emit, so no freeze there.
  const suspendAuto = i.ipAvailable || deckNavActive;
  const suspendSteamEnabled =
    i.suspendEnv === "1" ? true : i.suspendEnv === "0" ? false : suspendAuto;

  return {
    deckNavActive,
    readVirtualPadsForNav,
    grabDeckBuiltinNodes: deckNavActive,
    suspendSteamEnabled,
  };
}
