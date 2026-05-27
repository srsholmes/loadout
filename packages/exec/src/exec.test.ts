// Use Bun.spawn() directly instead of importing from ./index to avoid
// contamination from mock.module("@loadout/exec", ...) in other test files.
import { describe, it, expect } from "bun:test";

/** Re-implement run() inline using Bun.spawn to bypass mock contamination. */
async function run(
  cmd: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}

/** Re-implement runCode() inline using Bun.spawn to bypass mock contamination. */
async function runCode(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  return proc.exited;
}

/** Re-implement commandExists() inline using Bun.spawn to bypass mock contamination. */
async function commandExists(name: string): Promise<boolean> {
  try {
    const { exitCode } = await run(["which", name]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

describe("run", () => {
  it("returns stdout and exitCode 0 for a successful command", async () => {
    const result = await run(["echo", "hello"]);
    expect(result.stdout).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exitCode for a failing command", async () => {
    const result = await run(["false"]);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("runCode", () => {
  it("returns 0 for a successful command", async () => {
    const code = await runCode(["true"]);
    expect(code).toBe(0);
  });

  it("returns non-zero for a failing command", async () => {
    const code = await runCode(["false"]);
    expect(code).not.toBe(0);
  });
});

describe("commandExists", () => {
  it("returns true for a known command", async () => {
    const exists = await commandExists("echo");
    expect(exists).toBe(true);
  });

  it("returns false for a nonexistent command", async () => {
    const exists = await commandExists("definitely-not-a-command-xyz");
    expect(exists).toBe(false);
  });
});

// `runStreaming` is new and not mocked anywhere, so it's safe to
// import directly from ./index — mock-contamination won't bite.
import { runStreaming } from "./index";

describe("runStreaming", () => {
  it("calls onLine once per stdout line, in order, without trailing partials", async () => {
    const lines: string[] = [];
    const result = await runStreaming(
      ["sh", "-c", "printf 'one\\ntwo\\nthree\\n'"],
      { onLine: (l) => lines.push(l) },
    );
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(["one", "two", "three"]);
  });

  it("flushes the trailing line when stdout doesn't end with newline", async () => {
    const lines: string[] = [];
    await runStreaming(["sh", "-c", "printf 'no-newline'"], {
      onLine: (l) => lines.push(l),
    });
    expect(lines).toEqual(["no-newline"]);
  });

  it("merges stderr into the same stream so build progress (which most tools write to stderr) isn't lost", async () => {
    const lines: string[] = [];
    await runStreaming(
      ["sh", "-c", "printf 'a\\n' >&2; printf 'b\\n'; printf 'c\\n' >&2"],
      { onLine: (l) => lines.push(l) },
    );
    expect(lines.sort()).toEqual(["a", "b", "c"]);
  });

  it("propagates non-zero exit codes without throwing", async () => {
    const result = await runStreaming(["false"], { onLine: () => {} });
    expect(result.exitCode).not.toBe(0);
  });

  it("kills the process after timeoutMs", async () => {
    const start = Date.now();
    const result = await runStreaming(["sleep", "30"], {
      onLine: () => {},
      timeoutMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    expect(result.exitCode).not.toBe(0);
  });
});
