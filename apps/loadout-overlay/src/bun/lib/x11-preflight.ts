/**
 * X11 CLI tool preflight — pure decision + message formatting, so the
 * "we can't become visible, don't strand the user" rule is unit-testable
 * without booting the main process (pattern: wake-routing.ts,
 * input-strategy.ts).
 *
 * Background. The overlay's gamescope integration shells out for two
 * things it can't do over libxcb today:
 *
 *   - `xdotool` resolves our own X window id (searched by title —
 *     Electrobun can't set a stable WM_CLASS) and Steam's BPM window.
 *     x11.ts has no xcb_query_tree binding, so there is no fallback.
 *   - `xprop` is the atom read/write path whenever libxcb isn't usable
 *     (OVERLAY_FORCE_XPROP=1, or xcb_connect failing at startup).
 *
 * When xdotool is absent, `GamescopeAtoms.prepare()` and `.show()` both
 * return on their `if (!this.windowId) return` guard, so STEAM_OVERLAY /
 * _NET_WM_WINDOW_OPACITY are never written and gamescope never learns our
 * window exists. Before this module existed that produced one
 * `console.warn` at boot and then silent no-ops forever — while
 * toggleOverlay() went on to grab input and SIGSTOP Steam, leaving the
 * user with a frozen device, no UI, and nothing in the log to explain it.
 * That's the failure this file exists to prevent.
 *
 * Desktop mode is deliberately NOT covered: there the window is mapped by
 * the WM like any other, the atoms are a no-op anyway, and Steam is never
 * frozen — so a missing xdotool costs only `raiseAboveDesktop()`.
 */

/** Tools whose absence makes the overlay impossible to show under gamescope. */
export interface X11ToolStatus {
  /** `xdotool` is on PATH — required to resolve any window id at all. */
  xdotool: boolean;
  /** `xprop` is on PATH — the atom fallback when libxcb is unavailable. */
  xprop: boolean;
  /** A live libxcb connection exists, so atom writes don't need xprop. */
  xcbConnected: boolean;
}

/**
 * Which required tools are missing, given what's on PATH and whether
 * libxcb came up. Returns the tool names, in the order we'd tell a user
 * to install them; empty means we can drive gamescope.
 *
 * xprop only counts as missing when libxcb ISN'T connected — with a live
 * xcb connection the xprop path is never taken, so demanding it would
 * produce a false alarm on a perfectly working install.
 */
export function missingRequiredTools(status: X11ToolStatus): string[] {
  const missing: string[] = [];
  if (!status.xdotool) missing.push("xdotool");
  if (!status.xprop && !status.xcbConnected) missing.push("xprop");
  return missing;
}

/**
 * Should an overlay OPEN be refused outright?
 *
 * Only under gamescope, and only when a required tool is missing. Opening
 * anyway is strictly worse than refusing: the show is guaranteed to fail,
 * but the input grab and the Steam SIGSTOP still happen, so the user ends
 * up with a device that looks hung. Refusing keeps Steam usable and
 * leaves an explanation in the journal.
 */
export function shouldBlockOverlayOpen(input: {
  missingTools: string[];
  gameModeActive: boolean;
}): boolean {
  return input.gameModeActive && input.missingTools.length > 0;
}

/** Install command for the detected distro family, best-effort. */
function installHint(osRelease: string): string {
  const id = osRelease.toLowerCase();
  if (id.includes("steamos")) {
    return "sudo steamos-readonly disable && sudo pacman -S --needed xdotool xorg-xprop";
  }
  if (id.includes("bazzite")) {
    return "rpm-ostree install xdotool xorg-x11-utils   # then reboot";
  }
  if (id.includes("arch") || id.includes("cachyos")) {
    return "sudo pacman -S --needed xdotool xorg-xprop";
  }
  if (id.includes("fedora")) {
    return "sudo dnf install xdotool xorg-x11-utils";
  }
  if (id.includes("debian") || id.includes("ubuntu")) {
    return "sudo apt install xdotool x11-utils";
  }
  return "install them with your package manager";
}

/**
 * The banner logged at startup and on every blocked open. Multi-line and
 * deliberately shouty: the whole point is that the previous single
 * `console.warn` was impossible to spot in a journal, and this failure
 * mode is otherwise indistinguishable from "the overlay is just broken".
 *
 * `osRelease` is the raw /etc/os-release contents (or "" when unreadable)
 * — passed in rather than read here so this stays pure.
 */
export function formatMissingToolsBanner(
  missingTools: string[],
  osRelease: string,
): string {
  const list = missingTools.join(", ");
  return [
    "",
    "========================================================================",
    `  MISSING REQUIRED TOOL${missingTools.length > 1 ? "S" : ""}: ${list}`,
    "",
    "  The overlay CANNOT be shown in Gaming Mode without these. It resolves",
    "  its own X window id with xdotool, and every gamescope atom write needs",
    "  that id — so the overlay would take your controller and freeze Steam",
    "  without ever appearing. Opens are refused until this is fixed.",
    "",
    `  Fix:  ${installHint(osRelease)}`,
    "        systemctl --user restart loadout-overlay",
    "",
    "  Details: https://github.com/srsholmes/loadout/blob/main/docs/dependencies.md",
    "========================================================================",
    "",
  ].join("\n");
}
