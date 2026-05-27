// Command-policy enforcement (withCommandPolicy) — the per-plugin
// capability gate that mirrors the network sandbox. Run as a backend
// *.test.ts (bun's native env, real subprocesses).
//
// Imports come from "./index" (not "@loadout/exec") on purpose: another
// backend spec (gamescope-atoms.test.ts) does mock.module("@loadout/exec"),
// and bun keys that mock by the literal specifier — so the relative import
// here resolves to the REAL module, exactly as the sibling exec.test.ts
// relies on for runStreaming. We need the real run/spawn so the policy
// actually fires.
import { describe, it, expect } from "bun:test";
import {
  withCommandPolicy,
  run,
  runFull,
  runCode,
  runStreaming,
  spawn,
  type CommandPolicy,
} from "./index";

// Absolute path to a real binary, to prove the gate matches on basename
// (a plugin allowed "true" can run "/usr/bin/true").
const TRUE_PATH = Bun.which("true") ?? "/usr/bin/true";

describe("withCommandPolicy — no active policy (core/overlay)", () => {
  it("runs any command unrestricted when no policy is scoped", async () => {
    const result = await run(["echo", "hello"]);
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(await runCode(["true"])).toBe(0);
  });
});

describe("withCommandPolicy — declared command", () => {
  it("allows a command whose basename is in the allow-list", async () => {
    const result = await withCommandPolicy(
      { pluginId: "p", allowed: ["echo"] },
      () => run(["echo", "ok"]),
    );
    expect(result.stdout).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  it("matches on basename, so an absolute path to an allowed binary works", async () => {
    const result = await withCommandPolicy(
      { pluginId: "p", allowed: ["true"] },
      () => runFull([TRUE_PATH]),
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("withCommandPolicy — undeclared command is denied", () => {
  it("throws with a remediation message naming the binary + manifest edit", async () => {
    await expect(
      withCommandPolicy({ pluginId: "tdp-control", allowed: ["ryzenadj"] }, () =>
        run(["systemctl", "status"]),
      ),
    ).rejects.toThrow(
      /Plugin "tdp-control" attempted to run "systemctl".*not in its allowed commands \[ryzenadj\].*permissions\.commands/s,
    );
  });

  it("denies everything when the allow-list is empty (deny-by-default)", async () => {
    await expect(
      withCommandPolicy({ pluginId: "p", allowed: [] }, () => run(["true"])),
    ).rejects.toThrow(/no command permissions declared.*"commands": \["true"\]/s);
  });

  it("denies before the subprocess is ever spawned (runCode)", async () => {
    await expect(
      withCommandPolicy({ pluginId: "p", allowed: [] }, () =>
        runCode(["true"]),
      ),
    ).rejects.toThrow(/permissions/);
  });

  it("denies runStreaming on an undeclared command", async () => {
    await expect(
      withCommandPolicy({ pluginId: "p", allowed: ["echo"] }, () =>
        runStreaming(["cat", "/etc/hostname"], { onLine: () => {} }),
      ),
    ).rejects.toThrow(/permissions/);
  });

  it("denies the long-lived spawn() wrapper too (sync throw)", async () => {
    await expect(
      withCommandPolicy({ pluginId: "p", allowed: [] }, () => {
        spawn(["true"]);
      }),
    ).rejects.toThrow(/permissions/);
  });
});

describe("withCommandPolicy — audit log", () => {
  it("logs every attempt (allowed) through the policy's log sink", async () => {
    const lines: string[] = [];
    const policy: CommandPolicy = {
      pluginId: "p",
      allowed: ["echo"],
      log: (m) => lines.push(m),
    };
    await withCommandPolicy(policy, () => run(["echo", "hi"]));
    expect(lines.some((l) => l.includes('[exec] plugin "p" runs: echo hi'))).toBe(
      true,
    );
  });

  it("logs the denial line as well as throwing", async () => {
    const lines: string[] = [];
    const policy: CommandPolicy = {
      pluginId: "p",
      allowed: [],
      log: (m) => lines.push(m),
    };
    await expect(
      withCommandPolicy(policy, () => run(["systemctl"])),
    ).rejects.toThrow();
    expect(lines.some((l) => l.includes("[permissions]"))).toBe(true);
  });
});

describe("withCommandPolicy — isolation between scopes", () => {
  it("keeps concurrent policies from leaking into each other", async () => {
    const a = withCommandPolicy({ pluginId: "a", allowed: ["echo"] }, async () => {
      const ok = await run(["echo", "a"]);
      // "true" is NOT allowed for plugin a
      await expect(run(["true"])).rejects.toThrow(/Plugin "a"/);
      return ok.stdout;
    });
    const b = withCommandPolicy({ pluginId: "b", allowed: ["true"] }, async () => {
      const ok = await runFull([TRUE_PATH]);
      // "echo" is NOT allowed for plugin b
      await expect(run(["echo", "b"])).rejects.toThrow(/Plugin "b"/);
      return ok.exitCode;
    });
    const [aOut, bCode] = await Promise.all([a, b]);
    expect(aOut).toBe("a");
    expect(bCode).toBe(0);
  });
});
