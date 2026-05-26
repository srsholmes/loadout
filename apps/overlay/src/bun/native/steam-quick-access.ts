/**
 * Stub for M1 — Steam BPM QAM dismissal is only useful when Loadout is
 * integrating with Steam's Big Picture Mode (which it isn't yet). Returns
 * false unconditionally so gamescope-atoms.ts's call site is a no-op.
 *
 * Re-port the CDP-based dismissal logic from the original repo when
 * Steam BPM integration lands as its own milestone.
 */
export async function dismissSteamQuickAccessIfOpen(): Promise<boolean> {
  return false;
}
