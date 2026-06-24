import { describe, it, expect } from "bun:test";
import {
  getHidOxpStatus,
  setHidOxpBlacklist,
  HID_OXP_CONF,
  BLACKLIST_LINE,
  type HidOxpDeps,
} from "./hid-oxp";

/**
 * hid-oxp blacklist tests. IO is injected via a fake /etc + /proc map, so
 * these are pure unit tests of the status read-back and the enable/disable
 * write logic — no root, no real filesystem.
 */

const PROC_MODULES = "/proc/modules";

/** Build a deps double over an in-memory file map. Records writes/removes. */
function makeDeps(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const deps: HidOxpDeps = {
    readFile: async (p) => (files.has(p) ? files.get(p)! : null),
    writeFile: async (p, c) => void files.set(p, c),
    removeFile: async (p) => void files.delete(p),
  };
  return { deps, files };
}

const loadedModules = `hid_generic 16384 0\nhid_oxp 45056 0\noxpec 32768 0\n`;
const unloadedModules = `hid_generic 16384 0\noxpec 32768 0\n`;

describe("getHidOxpStatus", () => {
  it("reports not-blacklisted, loaded on a fresh system", async () => {
    const { deps } = makeDeps({ [PROC_MODULES]: loadedModules });
    const s = await getHidOxpStatus(deps);
    expect(s).toEqual({ blacklisted: false, moduleLoaded: true, rebootRequired: false });
  });

  it("flags rebootRequired when blacklisted but still loaded", async () => {
    const { deps } = makeDeps({
      [PROC_MODULES]: loadedModules,
      [HID_OXP_CONF]: `${BLACKLIST_LINE}\n`,
    });
    const s = await getHidOxpStatus(deps);
    expect(s).toEqual({ blacklisted: true, moduleLoaded: true, rebootRequired: true });
  });

  it("reports fully-applied once blacklisted and unloaded", async () => {
    const { deps } = makeDeps({
      [PROC_MODULES]: unloadedModules,
      [HID_OXP_CONF]: `${BLACKLIST_LINE}\n`,
    });
    const s = await getHidOxpStatus(deps);
    expect(s).toEqual({ blacklisted: true, moduleLoaded: false, rebootRequired: false });
  });

  it("ignores a conf file that doesn't actually carry the directive", async () => {
    const { deps } = makeDeps({
      [PROC_MODULES]: loadedModules,
      [HID_OXP_CONF]: "# some unrelated comment\n",
    });
    const s = await getHidOxpStatus(deps);
    expect(s.blacklisted).toBe(false);
  });

  it("does not false-match a module whose name merely contains hid_oxp", async () => {
    const { deps } = makeDeps({ [PROC_MODULES]: "hid_oxp_extra 16384 0\n" });
    const s = await getHidOxpStatus(deps);
    expect(s.moduleLoaded).toBe(false);
  });
});

describe("setHidOxpBlacklist", () => {
  it("writes the drop-in when enabling", async () => {
    const { deps, files } = makeDeps({ [PROC_MODULES]: loadedModules });
    const s = await setHidOxpBlacklist(deps, true);
    expect(files.get(HID_OXP_CONF)).toBe(`${BLACKLIST_LINE}\n`);
    expect(s).toEqual({ blacklisted: true, moduleLoaded: true, rebootRequired: true });
  });

  it("removes the drop-in when disabling", async () => {
    const { deps, files } = makeDeps({
      [PROC_MODULES]: loadedModules,
      [HID_OXP_CONF]: `${BLACKLIST_LINE}\n`,
    });
    const s = await setHidOxpBlacklist(deps, false);
    expect(files.has(HID_OXP_CONF)).toBe(false);
    expect(s.blacklisted).toBe(false);
  });

  it("disabling when already absent is a no-op (idempotent)", async () => {
    const { deps, files } = makeDeps({ [PROC_MODULES]: loadedModules });
    const s = await setHidOxpBlacklist(deps, false);
    expect(files.has(HID_OXP_CONF)).toBe(false);
    expect(s.blacklisted).toBe(false);
  });
});
