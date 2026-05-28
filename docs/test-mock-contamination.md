# bun:test module-mock conventions

## TL;DR

- **Both `spyOn` and `mock.module` are fine.** Pick whichever fits the call site.
- The historical cross-file-leakage problem with `mock.module` is **solved by `--isolate`** (Bun 1.3.14+). Our `test:backend` and `test:ui` scripts pass it by default. Without `--isolate`, every matched spec runs in one process and `mock.module` replaces the module *globally* for the run.
- **Use `spyOn` when the SUT calls a method on a named import / namespace.** `spyOn` patches the live binding on an object you already have a reference to — clean, reversible per-spy, type-safe.
- **Use `mock.module` when the SUT does a destructured or JSX import that captures the original binding.** `spyOn` can't reach those — the import already pulled a reference to the original function before the spy patched its parent namespace.

Neither approach is "preferred." They cover different shapes of import.

## When to use each

### Use `spyOn` for namespace-shaped imports

The SUT looks like:

```ts
import * as fsp from "node:fs/promises";
await fsp.readFile(path);
```

Patch the binding on the namespace and every call site sees the spy:

```ts
import * as fsp from "node:fs/promises";
import { spyOn, beforeEach } from "bun:test";

beforeEach(() => {
  spyOn(fsp, "readFile").mockImplementation(async () => "fake");
});
```

**Gotcha:** never `spyOn` the same property twice across a test run. Set up the spy once in `beforeEach`, then update its implementation via `.mockImplementation(…)` per-test — never re-`spyOn`. (Stacking spies breaks `mockRestore()`'s chain.)

### Use `mock.module` for destructured / JSX imports

The SUT looks like:

```ts
import { readFile } from "node:fs/promises";  // destructured
await readFile(path);
```

…or for React, anything pulled in for JSX:

```tsx
import { PluginProvider, useBackend } from "@loadout/ui";
<PluginProvider>…</PluginProvider>
```

`spyOn(fsp, "readFile")` won't help here — the destructured `readFile` already captured the original function reference. Use `mock.module`:

```ts
import * as real from "spec"; // capture the real exports BEFORE the mock
mock.module("spec", () => ({ ...real, override }));
const { SUT } = await import("./sut"); // dynamic import AFTER the mock
```

Both `import * as real` and the `mock.module(...)` call must appear before the dynamic SUT import — `mock.module` is not hoisted the way vitest's `vi.mock` is.

## Ad-hoc invocations

Plain `bun test <files>` does **not** add `--isolate` automatically. If you scope a run that touches a file using `mock.module` on a shared module, either:

```sh
bun run test:backend    # passes --isolate
bun run test:ui         # passes --isolate
```

or explicit:

```sh
bun test test.ts --isolate
bun test plugins/foo --isolate
```

## History

The cross-file leakage traced back to [oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823). Resolved by `--isolate` in [oven-sh/bun#31316](https://github.com/oven-sh/bun/issues/31316), shipped in Bun 1.3.14. Pre-1.3.14 specs in this repo aggressively preferred `spyOn` because it dodged the leakage entirely; that motivation is gone. Use whichever pattern fits the import shape.
