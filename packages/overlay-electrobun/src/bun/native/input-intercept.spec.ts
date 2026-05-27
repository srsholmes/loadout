import { describe, expect, it } from "bun:test";
import { warnIfHotplugDisabled } from "./input-intercept";

/**
 * Audit B-024: when inotify is unavailable, `startDeviceHotplug`
 * returns null and the input-intercept layer falls back to its 2 s
 * reconcile poll. The original code silently no-op'd; the fix logs a
 * one-liner so a journalctl scan turns the degraded mode up.
 */
describe("warnIfHotplugDisabled (B-024)", () => {
  it("logs a warning when the hotplug handle is null", () => {
    const calls: string[] = [];
    const log = (msg: string) => {
      calls.push(msg);
    };
    warnIfHotplugDisabled(null, log);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("inotify unavailable");
    expect(calls[0]).toContain("2s reconcile poll");
  });

  it("stays quiet when the hotplug handle is present", () => {
    const calls: string[] = [];
    const log = (msg: string) => {
      calls.push(msg);
    };
    const fakeHandle = { poll: () => {}, shutdown: () => {} };
    warnIfHotplugDisabled(fakeHandle, log);
    expect(calls).toHaveLength(0);
  });
});
