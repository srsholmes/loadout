# bun:test module-mock conventions

## TL;DR

- `bun:test` discovers and runs every matched spec **in one process**. Without isolation, a top-level `mock.module(spec, …)` in one file replaces the module *globally* for the whole run, so it leaks into sibling specs and causes order-dependent phantom failures.
- **Bun 1.3.14+ ships `--isolate`**: each spec file gets a fresh global, mocks don't leak. Our `test:backend` and `test:ui` scripts pass `--isolate` by default — see `package.json`.
- Prefer **`spyOn(obj, "method")`** over `mock.module(…)` regardless. It's clearer about exactly which export you're faking, and it patches the live binding without going through the module-mock cache. `mock.module` is acceptable when the SUT does a destructured import that `spyOn` can't reach.

## Convention for new specs

### 1. Prefer `spyOn`

```ts
import * as fsp from "node:fs/promises";
import { spyOn, beforeEach } from "bun:test";

beforeEach(() => {
  spyOn(fsp, "readFile").mockImplementation(async () => "fake");
});
```

**Gotcha:** never call `spyOn` on the same property twice. Set up each spy once in `beforeEach`, then update its implementation via `.mockImplementation(…)` in per-test helpers — never re-`spyOn`. (Stacking spies breaks `mockRestore()`'s chain.)

### 2. `mock.module` is fine under `--isolate`

Use it when the SUT does a destructured import that `spyOn` can't patch:

```ts
import * as real from "spec"; // capture real exports BEFORE the mock
mock.module("spec", () => ({ ...real, override }));
const { SUT } = await import("./sut"); // dynamic import AFTER (mock.module isn't hoisted)
```

Both `import * as real` and the `mock.module` call should appear before the dynamic SUT import.

### 3. Ad-hoc invocations

Plain `bun test <files>` does **not** add `--isolate` automatically. If you're scoping a run that touches a file using `mock.module` on a shared module, run via `bun run test:backend` / `test:ui` (which pass `--isolate`), or add the flag explicitly:

```sh
bun test test.ts --isolate
bun test plugins/foo --isolate
```

## When upstream broke vs. fixed this

The behaviour traced back to [oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823). Resolved by `--isolate` in [oven-sh/bun#31316](https://github.com/oven-sh/bun/issues/31316), shipped in Bun 1.3.14.
