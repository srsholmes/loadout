import { describe, test, expect } from "bun:test";
import { appendLaunchToken, removeLaunchToken } from "@loadout/vdf";
import {
  mangoHudLogDir,
  buildMangoHudConfig,
  mangoHudTokens,
  MANGOHUD_TOKEN_KEYS,
} from "./mangohud";

describe("MangoHud helpers", () => {
  test("log dir is per-app under loadout/mangohud-logs", () => {
    const dir = mangoHudLogDir(1091500);
    expect(dir.endsWith("loadout/mangohud-logs/1091500")).toBe(true);
  });

  test("config enables continuous per-app logging", () => {
    const cfg = buildMangoHudConfig("/tmp/logs", 200);
    expect(cfg).toContain("output_folder=/tmp/logs");
    expect(cfg).toContain("autostart_log=1");
    expect(cfg).toContain("log_interval=200");
    expect(cfg).toContain("no_display=1");
    // No spaces — must stay a single launch-options token.
    expect(cfg.includes(" ")).toBe(false);
  });

  test("emits three keyed tokens", () => {
    const tokens = mangoHudTokens(42);
    expect(tokens.map((t) => t.key)).toEqual(MANGOHUD_TOKEN_KEYS);
    expect(tokens[0].token.startsWith("MANGOHUD_CONFIG=")).toBe(true);
    expect(tokens[1].token).toBe("MANGOHUD=1");
    expect(tokens[2].token).toBe("mangohud");
  });

  test("round-trips cleanly through append/remove (no orphans)", () => {
    const tokens = mangoHudTokens(42);
    // Apply all three, preserving an existing user token.
    let opts = "PROTON_LOG=1 %command%";
    for (const { token, key } of tokens) {
      opts = appendLaunchToken(opts, token, { key, position: "before" });
    }
    expect(opts).toContain("mangohud");
    expect(opts).toContain("MANGOHUD=1");
    expect(opts).toContain("MANGOHUD_CONFIG=");
    // mangohud wrapper sits immediately before %command%.
    expect(opts.trim().endsWith("mangohud %command%")).toBe(true);

    // Idempotent re-apply is a no-op.
    let again = opts;
    for (const { token, key } of tokens) {
      again = appendLaunchToken(again, token, { key, position: "before" });
    }
    expect(again).toBe(opts);

    // Remove all three — user's token survives, nothing orphaned.
    for (const key of MANGOHUD_TOKEN_KEYS) {
      opts = removeLaunchToken(opts, key);
    }
    expect(opts).toBe("PROTON_LOG=1 %command%");
    expect(opts).not.toContain("mangohud");
    expect(opts).not.toContain("MANGOHUD");
  });
});
