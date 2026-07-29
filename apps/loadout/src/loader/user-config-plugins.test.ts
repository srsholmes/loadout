import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readUserConfig,
  writeUserConfig,
  resolveDisabledPlugins,
  disabledPluginsFrom,
  DISABLED_PLUGINS_KEY,
} from "./user-config";

/**
 * Plugin enablement is a deny-list (`disabledPlugins`). These cover the
 * one-time migration from the legacy `enabledPlugins` allow-list and the
 * new-plugin-defaults-enabled behavior the deny-list buys us.
 */

let prevXdg: string | undefined;
let testDir: string;

beforeEach(() => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  testDir = mkdtempSync(join(tmpdir(), "user-config-plugins-"));
  process.env.XDG_CONFIG_HOME = testDir;
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(testDir, { recursive: true, force: true });
});

describe("resolveDisabledPlugins", () => {
  it("migrates the legacy enabledPlugins allow-list to a disabledPlugins deny-list", async () => {
    await writeUserConfig({ enabledPlugins: ["a", "b"] });
    const disabled = await resolveDisabledPlugins(["a", "b", "c", "d"]);
    // Everything discovered that wasn't in the allow-list is now disabled.
    expect([...disabled].sort()).toEqual(["c", "d"]);

    const config = await readUserConfig();
    expect(disabledPluginsFrom(config)).toEqual(new Set(["c", "d"]));
    // Legacy key is removed so the migration runs exactly once.
    expect(config.enabledPlugins).toBeUndefined();
  });

  it("returns the persisted deny-list unchanged when already migrated", async () => {
    await writeUserConfig({ [DISABLED_PLUGINS_KEY]: ["x"] });
    const disabled = await resolveDisabledPlugins(["x", "y", "z"]);
    expect([...disabled]).toEqual(["x"]);
  });

  it("defaults to nothing disabled when no config exists", async () => {
    const disabled = await resolveDisabledPlugins(["a", "b"]);
    expect(disabled.size).toBe(0);
  });

  it("leaves a newly installed plugin enabled (absent from the deny-list)", async () => {
    await writeUserConfig({ [DISABLED_PLUGINS_KEY]: ["old"] });
    // "new" appears on disk after the list was written — must not be disabled.
    const disabled = await resolveDisabledPlugins(["old", "new"]);
    expect(disabled.has("new")).toBe(false);
  });
});
