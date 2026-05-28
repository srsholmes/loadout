import { describe, it, expect } from "bun:test";

// Bypass Bun's mock.module contamination. See vdf.spec.ts for context —
// other suites mock-replace `@loadout/vdf`, which would also stub out
// these helpers if we imported them via the package barrel.
const _path = import.meta.dir + "/launch-options.ts";
const { appendLaunchToken, removeLaunchToken, hasLaunchToken } = await import(
  _path + "?real"
);

// ─── appendLaunchToken ───────────────────────────────────────────────

describe("appendLaunchToken", () => {
  type Case = {
    name: string;
    existing: string;
    token: string;
    opts?: { key?: string; position?: "before" | "after"; ensureCommand?: boolean };
    expected: string;
  };

  const cases: Case[] = [
    {
      name: "empty input gets `<token> %command%`",
      existing: "",
      token: "~/lsfg",
      expected: "~/lsfg %command%",
    },
    {
      name: "lone %command% gets the wrapper before it",
      existing: "%command%",
      token: "~/lsfg",
      expected: "~/lsfg %command%",
    },
    {
      name: "single existing wrapper stacks new wrapper closer to %command%",
      existing: "mangohud %command%",
      token: "~/lsfg",
      expected: "mangohud ~/lsfg %command%",
    },
    {
      name: "multiple existing wrappers preserved in order",
      existing: "gamemoderun mangohud %command%",
      token: "~/lsfg",
      expected: "gamemoderun mangohud ~/lsfg %command%",
    },
    {
      name: "trailing args after %command% are preserved",
      existing: "mangohud %command% --fullscreen",
      token: "~/lsfg",
      expected: "mangohud ~/lsfg %command% --fullscreen",
    },
    {
      name: "idempotent — re-append same wrapper is a no-op",
      existing: "mangohud ~/lsfg %command%",
      token: "~/lsfg",
      expected: "mangohud ~/lsfg %command%",
    },
    {
      name: "env-var prefix without %command% canonicalises to explicit form",
      existing: "PROTON_USE_WINED3D=1",
      token: "~/lsfg",
      expected: "PROTON_USE_WINED3D=1 ~/lsfg %command%",
    },
    {
      name: "env-var prefix with explicit %command% inserts before",
      existing: "PROTON_USE_WINED3D=1 %command%",
      token: "~/lsfg",
      expected: "PROTON_USE_WINED3D=1 ~/lsfg %command%",
    },
    {
      name: "env-var idempotency by KEY (no value) — already present",
      existing: "PROTON_LOG=1 %command%",
      token: "PROTON_LOG=2",
      opts: { key: "PROTON_LOG" },
      expected: "PROTON_LOG=1 %command%",
    },
    {
      name: "position: 'after' puts the token after %command%",
      existing: "mangohud %command% --foo",
      token: "--bar",
      opts: { position: "after" },
      expected: "mangohud %command% --bar --foo",
    },
    {
      name: "ensureCommand: false keeps absent %command% absent",
      existing: "PROTON_LOG=1",
      token: "PROTON_DEBUG=1",
      opts: { ensureCommand: false },
      expected: "PROTON_LOG=1 PROTON_DEBUG=1",
    },
    {
      name: "double-quoted args stay intact across the merge",
      existing: '"some quoted arg" %command%',
      token: "~/lsfg",
      expected: '"some quoted arg" ~/lsfg %command%',
    },
    {
      name: "single-quoted args stay intact across the merge",
      existing: "'sh -c \"foo bar\"' %command%",
      token: "~/lsfg",
      expected: "'sh -c \"foo bar\"' ~/lsfg %command%",
    },
    {
      name: "multiple %command% markers — operate on the rightmost",
      existing: "%command% mid %command% tail",
      token: "~/lsfg",
      expected: "%command% mid ~/lsfg %command% tail",
    },
    {
      name: "empty token would be useless — but still idempotent",
      existing: "mangohud %command%",
      token: "mangohud",
      expected: "mangohud %command%",
    },
    {
      name: "explicit key overrides token-based idempotency",
      existing: "MY_FLAG_a %command%",
      token: "MY_FLAG_b",
      opts: { key: "MY_FLAG_a" },
      expected: "MY_FLAG_a %command%",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(appendLaunchToken(c.existing, c.token, c.opts)).toBe(c.expected);
    });
  }
});

// ─── removeLaunchToken ───────────────────────────────────────────────

describe("removeLaunchToken", () => {
  type Case = {
    name: string;
    existing: string;
    key: string;
    expected: string;
  };

  const cases: Case[] = [
    {
      name: "removes wrapper, preserves other wrappers",
      existing: "mangohud ~/lsfg %command%",
      key: "~/lsfg",
      expected: "mangohud %command%",
    },
    {
      name: "removing the only wrapper collapses to empty (back to default)",
      existing: "~/lsfg %command%",
      key: "~/lsfg",
      expected: "",
    },
    {
      name: "no match — input returned unchanged",
      existing: "%command%",
      key: "~/lsfg",
      expected: "%command%",
    },
    {
      name: "removes by env-var KEY when value is unknown (collapses to empty)",
      existing: "PROTON_LOG=1 %command%",
      key: "PROTON_LOG",
      expected: "",
    },
    {
      name: "preserves trailing args after %command%",
      existing: "~/lsfg %command% --fullscreen",
      key: "~/lsfg",
      expected: "%command% --fullscreen",
    },
    {
      name: "preserves quoted args during removal",
      existing: '"some quoted" ~/lsfg %command%',
      key: "~/lsfg",
      expected: '"some quoted" %command%',
    },
    {
      name: "round-trip: append then remove returns the original",
      existing: "mangohud %command%",
      key: "~/lsfg",
      // round-trip case: appendLaunchToken then removeLaunchToken
      expected: "mangohud %command%",
    },
  ];

  for (const c of cases) {
    if (c.name.startsWith("round-trip")) {
      it(c.name, () => {
        const appended = appendLaunchToken(c.existing, c.key);
        expect(removeLaunchToken(appended, c.key)).toBe(c.expected);
      });
    } else {
      it(c.name, () => {
        expect(removeLaunchToken(c.existing, c.key)).toBe(c.expected);
      });
    }
  }
});

// ─── hasLaunchToken ──────────────────────────────────────────────────

describe("hasLaunchToken", () => {
  it("true when wrapper is present", () => {
    expect(hasLaunchToken("mangohud ~/lsfg %command%", "~/lsfg")).toBe(true);
  });

  it("false when wrapper is absent", () => {
    expect(hasLaunchToken("mangohud %command%", "~/lsfg")).toBe(false);
  });

  it("matches by env-var KEY without specifying value", () => {
    expect(hasLaunchToken("PROTON_LOG=1 %command%", "PROTON_LOG")).toBe(true);
  });

  it("matches when key is the full env-var assignment", () => {
    expect(hasLaunchToken("PROTON_LOG=1 %command%", "PROTON_LOG=1")).toBe(true);
  });

  it("false on empty input", () => {
    expect(hasLaunchToken("", "~/lsfg")).toBe(false);
  });
});

// ─── round-trip integration ──────────────────────────────────────────

describe("append/remove round-trip", () => {
  it("append on empty + remove returns empty", () => {
    const appended = appendLaunchToken("", "~/lsfg");
    expect(appended).toBe("~/lsfg %command%");
    expect(removeLaunchToken(appended, "~/lsfg")).toBe("");
  });

  it("append on existing wrapper preserves outer wrapper after removal", () => {
    const appended = appendLaunchToken("mangohud %command%", "~/lsfg");
    expect(appended).toBe("mangohud ~/lsfg %command%");
    expect(removeLaunchToken(appended, "~/lsfg")).toBe("mangohud %command%");
  });

  it("double-append is idempotent (second call no-ops)", () => {
    const once = appendLaunchToken("%command%", "~/lsfg");
    const twice = appendLaunchToken(once, "~/lsfg");
    expect(twice).toBe(once);
  });
});
