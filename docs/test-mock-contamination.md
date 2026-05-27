# bun:test module mocks leak across files — testing conventions

Closes/supersedes audit-2026-05 finding **A-017** and GitHub issue
#90.

## TL;DR

- `mock.module(path, factory)` in `bun:test` (Bun 1.3.10) replaces the
  module globally for the entire test process. It is **not** scoped to
  the spec file that called it, and it cannot be undone with
  `mock.restore()` or by ignoring the value returned from
  `mock.module()`.
- The project's backend test runner
  ([`scripts/test-backend.sh`](../scripts/test-backend.sh)) forks one
  `bun test` process per spec file. That isolation — not the choice
  of API — is what stops a plugin spec's `mock.module("node:fs/promises",
  …)` from poisoning the loader's reads.
- Inside a single process (e.g. when a developer runs
  `bun test packages/loader/src plugins/network-info` directly), the
  contamination still applies and there is no way to scope it today.
- For any future spec that needs to mock a Node builtin or shared
  module, prefer `spyOn(module, "fn").mockImplementation(…)` +
  `spy.mockRestore()` (in `afterEach`) over `mock.module(…)`.

## What the workaround used to look like

Several files in `packages/loader/src/` used to avoid
`node:fs/promises` for fear that a plugin spec mocking
`mock.module("node:fs/promises", …)` would leak into the loader:

- `atomic-write.ts` imported `mkdirSync`/`renameSync` from `node:fs`
  and used `Bun.write` / `Bun.file().text()` for the async surface.
- `updater.ts` imported `readdirSync`, `statSync`, `unlinkSync`,
  `renameSync` from `node:fs` and used `Bun.file` for reads.

Every site carried a comment like:

```ts
// Use node:fs sync APIs instead of node:fs/promises to avoid contamination
// from mock.module("node:fs/promises", ...) in other test files.
```

That paperwork has been removed. The loader is back on
`node:fs/promises` because the per-process runner already guarantees
no plugin spec can contaminate a loader spec, and no loader-side spec
calls `mock.module("node:fs/promises", …)` itself.

## Empirical evidence (Bun 1.3.10)

Minimal repro: a module that calls `readdir`, plus two specs:

```ts
// pkg.ts
import { readdir } from "node:fs/promises";
export async function listDir(p: string): Promise<string[]> {
  try { return (await readdir(p)) as unknown as string[]; } catch { return []; }
}
```

```ts
// a.test.ts — no mocks
it("reads real dir", async () => {
  // …writes a real file, then…
  expect(await listDir(dir)).toEqual(["x"]);
});
```

```ts
// b.test.ts — mocks node:fs/promises
mock.module("node:fs/promises", () => ({
  readdir: () => Promise.resolve(["fake-entry"]),
}));
it("reads mocked dir", async () => {
  expect(await listDir("/anywhere")).toEqual(["fake-entry"]);
});
```

Running `bun test a.test.ts b.test.ts` (either order): `a.test.ts`
fails with `["fake-entry"]` instead of `["x"]`. The mock from `b`
applies to `a`.

Workarounds that **don't** help (all verified):

- Wrapping the `mock.module` call in `beforeEach` and calling
  `mock.restore()` in `afterEach`.
- Capturing the return value of `mock.module(…)` and calling it in
  `afterEach` (the function it returns is a `mock` instance, not an
  unmock).
- Anything else short of `--rerun-each` or forking the process.

What **does** work:

- `scripts/test-backend.sh` forks one `bun test` per spec, so module
  state cannot cross spec boundaries.
- `spyOn(module, "fn").mockImplementation(…)` followed by
  `spy.mockRestore()` patches the live binding without going through
  the module-mock cache, so it cleans up correctly within a process.

## How to run loader specs locally

**Always** use `scripts/test-backend.sh` or scope a `bun test` invocation
to a single package — never `bun test` at the repo root.

```sh
sh scripts/test-backend.sh                  # canonical: forks per spec
bun run test:backend                        # same thing (npm alias)
bun test packages/loader/src                # single-package scope is OK
bun test plugins/network-info/backend.spec.ts  # single-file is OK
```

```sh
bun test                                    # ❌ DON'T — single process
                                            # discovers every spec and
                                            # mocks leak across them
```

A plain `bun test` at the root will surface "test failures" that don't
exist under the canonical runner because plugin specs that mock
`@loadout/exec` / `node:fs/promises` / etc. contaminate the loader
specs that import the same modules. CI runs `test-backend.sh` so those
fake failures never reach the build, but they will mislead you locally.

## Convention for new specs

When you need to fake a Node builtin or a shared package in a spec:

1. **Prefer `spyOn`.** Example:

   ```ts
   import * as fsp from "node:fs/promises";
   import { spyOn, beforeEach, afterEach } from "bun:test";

   let readSpy: ReturnType<typeof spyOn> | null = null;

   beforeEach(() => {
     readSpy = spyOn(fsp, "readFile").mockImplementation(
       async () => "fake-content",
     );
   });

   afterEach(() => {
     readSpy?.mockRestore();
   });
   ```

2. **`mock.module` is acceptable** when (a) you cannot use `spyOn`
   because the import is destructured at the top of the consumer
   (`import { readFile } from "node:fs/promises"` — `spyOn` can't
   patch that binding), and (b) you trust that the spec is run via
   `scripts/test-backend.sh` (one process per file). If you add a new
   `mock.module(…)`, run the loader specs in the same invocation to
   prove no contamination:

   ```
   bun test packages/loader/src plugins/your-new-plugin/backend.spec.ts
   ```

3. **Never** put `mock.module("node:fs/promises", …)` (or any other
   broadly-imported builtin) at module top level in a spec that might
   ever be run alongside loader specs in a single `bun test`
   invocation. The per-process runner protects production CI/dev runs
   but doesn't protect ad-hoc combined invocations.

## When upstream fixes this

If Bun adds scoped module mocks (issue tracker:
[oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823) and
adjacent), this doc can be retired and the convention collapses to
"do whatever you want." Until then, the per-process runner is the
contract.
