/**
 * Permission-coverage tests for the fast-path browser spawn.
 *
 * The fast-path in `backend.ts → launchUrl` direct-execs the resolved
 * browser binary (e.g. `/usr/bin/firefox`) via `@loadout/exec`'s
 * `spawn`, which runs inside `withCommandPolicy`. That policy is fed
 * `permissions.commands` from `package.json` and basenames the
 * binary; any basename missing from the allow-list throws a
 * `[permissions] …` error before `Bun.spawn` is even called.
 *
 * Regression coverage for the PR-#69 review blocker: every browser
 * binary basename the plugin can ever spawn — including BOTH bins of
 * a family (chrome-stable + chrome, brave-browser + brave, etc.) —
 * must appear in `permissions.commands`.
 */

import { describe, it, expect, mock } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { basename } from "path";

// ─── Stub Bun.spawn so the policy gate is the only thing executed ────
//
// `spawn` from @loadout/exec wraps Bun.spawn AFTER enforceCommandPolicy;
// if we let the real spawn run with a fake exe path the test process
// would still try to spawn it and the assertion would race the
// child-process error. Replacing Bun.spawn with a no-op turns this
// into a pure policy-allowlist test.
type SpawnRet = ReturnType<typeof Bun.spawn>;
(globalThis as { Bun: typeof Bun }).Bun.spawn = ((..._args: unknown[]) =>
  ({
    exited: Promise.resolve(0),
    kill: () => {},
    stdout: null,
    stderr: null,
    stdin: null,
  }) as unknown as SpawnRet) as typeof Bun.spawn;

const { spawn, withCommandPolicy } = await import("@loadout/exec");

// ─── Sources of truth ────────────────────────────────────────────────

interface PackageJsonPluginManifest {
  plugin: { permissions: { commands: string[] } };
}

async function loadAllowedCommands(): Promise<string[]> {
  const raw = await readFile(join(import.meta.dir, "package.json"), "utf-8");
  const pkg = JSON.parse(raw) as PackageJsonPluginManifest;
  return pkg.plugin.permissions.commands;
}

async function loadAllowedNetwork(): Promise<string[]> {
  const raw = await readFile(join(import.meta.dir, "package.json"), "utf-8");
  const pkg = JSON.parse(raw) as {
    plugin: { permissions: { network?: string[] } };
  };
  return pkg.plugin.permissions.network ?? [];
}

// The loopback aliases the loader's sandboxed fetch treats as equivalent.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * Mirrors `NATIVE_BROWSERS` from `backend.ts`. Hard-coded here (not
 * imported) so that adding a new browser to backend.ts without
 * updating package.json fails this test loudly rather than silently
 * relying on the backend's runtime check.
 */
const ALL_BROWSER_BINS = [
  "firefox",
  "google-chrome-stable",
  "google-chrome",
  "brave-browser",
  "brave",
  "chromium",
  "chromium-browser",
  "microsoft-edge-stable",
  "microsoft-edge",
  "vivaldi",
  "vivaldi-stable",
];

// ─── Tests ───────────────────────────────────────────────────────────

describe("manifest declares every browser bin the fast-path can spawn", () => {
  it("permissions.commands contains every NATIVE_BROWSERS basename", async () => {
    const allowed = await loadAllowedCommands();
    for (const bin of ALL_BROWSER_BINS) {
      expect(allowed).toContain(bin);
    }
  });

  it("permissions.commands still contains the existing detection bins", async () => {
    const allowed = await loadAllowedCommands();
    // Regression guard — adding browser bins must not displace the
    // detection-helper bins.
    for (const bin of ["which", "flatpak", "systemctl", "pgrep", "xprop"]) {
      expect(allowed).toContain(bin);
    }
  });
});

describe("withCommandPolicy permits the fast-path spawn", () => {
  it("does not throw [permissions] when spawning any resolved native browser path", async () => {
    const allowed = await loadAllowedCommands();
    const fakeLog = mock<(message: string) => void>(() => {});

    for (const bin of ALL_BROWSER_BINS) {
      const exe = `/usr/bin/${bin}`;
      // Wraps the spawn in the exact policy shape the loader builds at
      // runtime (see packages/exec/src/index.ts → withCommandPolicy).
      await withCommandPolicy(
        { pluginId: "quick-links", allowed, log: fakeLog },
        async () => {
          // Each spawn flavour the fast-path uses:
          //   native firefox: [exe, "--new-tab", url]
          //   native chromium-family: [exe, url]
          //   flatpak: [/usr/bin/flatpak, "run", appid, ...args, url]
          // Asserting the bare-binary form is sufficient — the policy
          // basenames cmd[0] regardless of trailing args. This is the
          // exact construct in backend.ts line ~1311:
          //   spawn([installed.exe, ...argv], …)
          expect(() =>
            spawn([exe, "--new-tab", "https://example.com"], {
              stdout: "ignore",
              stderr: "ignore",
              stdin: "ignore",
            }),
          ).not.toThrow();
        },
      );
    }

    // None of the audit-log lines should be the `[permissions]`
    // denial-format string.
    for (const call of fakeLog.mock.calls) {
      const msg = call[0] ?? "";
      expect(msg.startsWith("[permissions]")).toBe(false);
    }
  });

  it("flatpak fast-path is also permitted (spawn target is /usr/bin/flatpak)", async () => {
    const allowed = await loadAllowedCommands();
    const fakeLog = mock<(message: string) => void>(() => {});

    await withCommandPolicy(
      { pluginId: "quick-links", allowed, log: fakeLog },
      async () => {
        expect(() =>
          spawn(
            [
              "/usr/bin/flatpak",
              "run",
              "org.mozilla.firefox",
              "--new-tab",
              "https://example.com",
            ],
            { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
          ),
        ).not.toThrow();
      },
    );

    for (const call of fakeLog.mock.calls) {
      const msg = call[0] ?? "";
      expect(msg.startsWith("[permissions]")).toBe(false);
    }
  });

  it("a deliberately-not-allowed binary is still denied — sanity check", async () => {
    const allowed = await loadAllowedCommands();
    const fakeLog = mock<(message: string) => void>(() => {});

    await withCommandPolicy(
      { pluginId: "quick-links", allowed, log: fakeLog },
      async () => {
        // `opera` is not (and should not be) in the allow-list; the
        // policy must still deny it. Confirms the test plumbing —
        // we're really exercising the gate, not silently no-op'ing.
        expect(() =>
          spawn(["/usr/bin/opera", "https://example.com"], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          }),
        ).toThrow(/\[permissions\]/);
      },
    );

    // Use `basename` so the lint suite doesn't flag an unused import.
    expect(basename("/usr/bin/opera")).toBe("opera");
  });
});

describe("manifest declares the Steam CDP network host", () => {
  it("permissions.network includes a loopback host", async () => {
    const network = await loadAllowedNetwork();
    // @loadout/steam-cdp's listCefTabs does
    // fetch("http://localhost:8080/json"), which the loader routes
    // through the per-plugin sandboxed fetch. Without a loopback host in
    // the allow-list, EVERY Steam-driving call (launchUrl slow path,
    // isSteamReachable, AddShortcut / RemoveShortcut) is rejected and the
    // UI shows "Steam isn't responding on its debug port." Regression for
    // that PR-#69 migration miss.
    expect(network.some((h) => LOOPBACK_HOSTS.includes(h))).toBe(true);
  });
});
