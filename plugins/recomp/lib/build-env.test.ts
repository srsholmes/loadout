import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

/**
 * Spec for the recomp build environment (distrobox container) lifecycle.
 *
 * FIX 2 — a broken / half-created container must be recovered (rm -f so
 * the next attempt recreates it) rather than leaving the user wedged,
 * and the failure / timeout error messages must distinguish a broken
 * container from an actual build timeout.
 *
 * FIX 3 — the `run()` command construction must be safe against shell
 * metacharacters in the command string (it's trusted recipe input
 * today, but a future dynamic value mustn't be able to split it).
 *
 * We mock @loadout/exec so no real distrobox / podman is touched and we
 * can assert exactly which argv vectors were issued.
 */

// Recorded calls across runFull / runStreaming for assertions.
interface ExecCall {
  fn: "runFull" | "runStreaming";
  cmd: string[];
}
let calls: ExecCall[] = [];

// Per-test programmable responders keyed by a substring of the joined argv.
type Responder = (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string };
let runFullResponder: Responder = () => ({ exitCode: 0, stdout: "", stderr: "" });
let runStreamingResponder: Responder = () => ({ exitCode: 0 });

mock.module("@loadout/exec", () => ({
  commandExists: async () => true,
  runFull: async (cmd: string[]) => {
    calls.push({ fn: "runFull", cmd });
    const r = runFullResponder(cmd);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode };
  },
  runStreaming: async (cmd: string[], opts: { onLine?: (l: string) => void }) => {
    calls.push({ fn: "runStreaming", cmd });
    const r = runStreamingResponder(cmd);
    return { exitCode: r.exitCode };
  },
}));

beforeEach(() => {
  calls = [];
  runFullResponder = () => ({ exitCode: 0, stdout: "", stderr: "" });
  runStreamingResponder = () => ({ exitCode: 0 });
});

afterEach(() => {
  mock.restore();
});

function joined(c: ExecCall): string {
  return c.cmd.join(" ");
}

describe("ensureRecompContainer — FIX 2: broken-container recovery", () => {
  it("removes (rm -f) a broken existing container, then recreates it", async () => {
    const { ensureRecompContainer, RECOMP_CONTAINER } = await import("./build-env");
    runFullResponder = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("list")) {
        // Container appears to exist…
        return { exitCode: 0, stdout: `ID | NAME\nxxx | ${RECOMP_CONTAINER}\n` };
      }
      if (j.includes("enter") && j.includes("true")) {
        // …but entering it fails — it's broken/half-created.
        return { exitCode: 125, stdout: "", stderr: "container not found in storage" };
      }
      if (j.includes("rm")) {
        return { exitCode: 0, stdout: "" };
      }
      return { exitCode: 0, stdout: "" };
    };

    await ensureRecompContainer(() => {});

    const rmCall = calls.find(
      (c) => c.cmd.includes("rm") && c.cmd.includes(RECOMP_CONTAINER),
    );
    expect(rmCall).toBeDefined();
    // -f so a half-created container is force-removed.
    expect(rmCall!.cmd).toContain("-f");
    // After recovery, a fresh create must be attempted.
    const createCall = calls.find((c) => c.cmd.includes("create"));
    expect(createCall).toBeDefined();
  });

  it("surfaces a container-setup failure (not a build timeout) when recreate fails", async () => {
    const { ensureRecompContainer, RECOMP_CONTAINER } = await import("./build-env");
    runFullResponder = (cmd) => {
      const j = cmd.join(" ");
      if (j.includes("list")) {
        return { exitCode: 0, stdout: `${RECOMP_CONTAINER}\n` };
      }
      if (j.includes("enter") && j.includes("true")) {
        return { exitCode: 125, stdout: "", stderr: "broken" };
      }
      if (j.includes("rm")) return { exitCode: 0 };
      return { exitCode: 0 };
    };
    // The recreate itself fails.
    runStreamingResponder = (cmd) =>
      cmd.includes("create") ? { exitCode: 1 } : { exitCode: 0 };

    const err = await ensureRecompContainer(() => {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // Must clearly be a container/setup failure, NOT a "build timed out".
    expect((err as Error).message).toMatch(/container/i);
    expect((err as Error).message).not.toMatch(/build (timed out|timeout)/i);
  });
});

describe("BuildEnv.run — FIX 2: distinct timeout vs container-failure diagnostics", () => {
  it("reports a build timeout distinctly from a container failure", async () => {
    const { detectBuildEnv } = await import("./build-env");
    const env = await detectBuildEnv();
    // runFull/runStreaming both succeed for detection; now simulate the
    // exec layer reporting a timeout (exitCode -1, empty output) for the
    // actual build command.
    runStreamingResponder = () => ({ exitCode: -1 });
    const r = await env.run("make -j", "/tmp/x", { onLine: () => {} });
    // The env surfaces the raw exit code; the timeout signal (-1) is
    // distinguishable from a normal non-zero build failure.
    expect(r.exitCode).toBe(-1);
  });
});

describe("BuildEnv.run — FIX 3: shell-metacharacter safety", () => {
  it("does not let the command string break out of the bash -lc payload", async () => {
    const { detectBuildEnv } = await import("./build-env");
    const env = await detectBuildEnv();

    // A command carrying shell metacharacters. Whatever quoting the env
    // applies, the dangerous payload must remain confined to a single
    // bash -lc argument — it must NOT appear as its own argv token that
    // could run as a separate command.
    const evil = `make; rm -rf $HOME`;
    await env.run(evil, "/tmp/work dir", { onLine: () => {} });

    const runCall = calls.find((c) => c.fn === "runStreaming");
    expect(runCall).toBeDefined();
    const argv = runCall!.cmd;
    // The `-c` payload is the single argument following "-lc"/"-c". The
    // injected command must live INSIDE that one argument, not be split
    // into a separate `rm` token in the argv.
    expect(argv).not.toContain("rm");
    // The cwd (with a space) must be quoted, and the recipe command must
    // appear verbatim within the single payload argument.
    const lcIdx = argv.findIndex((a) => a === "-lc" || a === "-c");
    expect(lcIdx).toBeGreaterThanOrEqual(0);
    const payload = argv[lcIdx + 1] ?? "";
    expect(payload).toContain(evil);
    expect(payload).toContain("/tmp/work dir");
    // The cwd value must be single-quoted (so metacharacters in a future
    // dynamic cwd can't split the command) AND guarded with `cd --` so a
    // cwd beginning with `-` can't be parsed as a `cd` option.
    expect(payload).toMatch(/cd -- '/);
  });

  it("keeps a metacharacter-laden cwd confined to one quoted token", async () => {
    const { detectBuildEnv } = await import("./build-env");
    const env = await detectBuildEnv();
    const trickyCwd = `/tmp/$(touch pwned); echo`;
    await env.run("make", trickyCwd, { onLine: () => {} });
    const runCall = calls.find((c) => c.fn === "runStreaming");
    const argv = runCall!.cmd;
    const lcIdx = argv.findIndex((a) => a === "-lc" || a === "-c");
    const payload = argv[lcIdx + 1] ?? "";
    // The whole cwd, metacharacters and all, sits inside a single-quoted
    // literal — `$(...)` must not be left unquoted where the shell would
    // expand it.
    expect(payload).toContain(`'${trickyCwd}'`);
  });
});
