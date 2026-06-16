# Quick Links — Close Overlay On Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the Loadout overlay when a Quick Links link successfully opens.

**Architecture:** Add a runtime-guarded `hideOverlay()` to the plugin SDK (`@loadout/ui`) that calls the Electrobun host's `hide` RPC via `globalThis.__electroview`. Call it from quick-links' `useLinkLauncher` on the `{ launched: true }` path only.

**Tech Stack:** React 18, `@loadout/ui`, `bun:test` (+happy-dom for `*.spec.tsx`).

**Spec:** `docs/superpowers/specs/2026-06-04-quick-links-close-overlay-on-launch-design.md`

**Working dir:** `/var/home/srsholmes/Work/loadout-worktrees/quick-links` (branch `plugin/quick-links`). Prefix bun commands with `export PATH="$HOME/.bun/bin:$PATH"`.

**Test commands:**
- UI specs (happy-dom): `bun test <file>.spec.tsx --preload ./test/bun-test-setup.ts --isolate`
- Typecheck: `bun run typecheck`
- Lint: `bunx eslint packages/ui/ plugins/quick-links/`

---

## File Structure

- **Create:** `packages/ui/src/host.ts` — `hideOverlay()` + the `__electroview` global type.
- **Create:** `packages/ui/src/host.spec.tsx` — unit tests for `hideOverlay()`.
- **Modify:** `packages/ui/src/index.ts` — export `hideOverlay`.
- **Modify:** `plugins/quick-links/app.tsx` — import `hideOverlay`; call it in `useLinkLauncher` on success.
- **Modify:** `plugins/quick-links/app.spec.tsx` — spy on `hideOverlay`; assert called on success, not on failure.

No backend / RPC / storage changes.

---

## Task 1: Add `hideOverlay()` to `@loadout/ui` (test-first)

**Files:**
- Create: `packages/ui/src/host.ts`
- Create: `packages/ui/src/host.spec.tsx`
- Modify: `packages/ui/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/ui/src/host.spec.tsx`:

```tsx
import { describe, it, expect, mock, afterEach } from "bun:test";
import { hideOverlay } from "./host";

afterEach(() => {
  delete (globalThis as { __electroview?: unknown }).__electroview;
});

describe("hideOverlay", () => {
  it("calls the host hide RPC when __electroview is present", async () => {
    const hide = mock(() => Promise.resolve(undefined));
    (globalThis as { __electroview?: unknown }).__electroview = {
      rpc: { request: { hide } },
    };
    await hideOverlay();
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("no-ops (no throw) when __electroview is absent", async () => {
    delete (globalThis as { __electroview?: unknown }).__electroview;
    await expect(hideOverlay()).resolves.toBeUndefined();
  });

  it("no-ops when the rpc bridge is partially present", async () => {
    (globalThis as { __electroview?: unknown }).__electroview = { rpc: {} };
    await expect(hideOverlay()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test packages/ui/src/host.spec.tsx --preload ./test/bun-test-setup.ts --isolate`
Expected: FAIL — `Cannot find module './host'` (the module doesn't exist yet).

- [ ] **Step 3: Create the implementation**

Create `packages/ui/src/host.ts`:

```ts
// Overlay host bridge for plugins. The Electrobun webview host installs
// its RPC requester at globalThis.__electroview.rpc.request.* — the same
// global the overlay's own @overlay/lib/host shim uses. Plugins run in
// that webview document, so this reaches the host at runtime. Outside the
// overlay (standalone dev, unit tests) it is a safe no-op.

declare global {
  // eslint-disable-next-line no-var
  var __electroview:
    | {
        rpc?: {
          request?: Record<string, (args?: unknown) => Promise<unknown>>;
        };
      }
    | undefined;
}

/** Ask the Electrobun overlay host to hide the overlay window. Resolves
 *  immediately (no-op) when there is no host transport. */
export async function hideOverlay(): Promise<void> {
  const hide = globalThis.__electroview?.rpc?.request?.hide;
  if (typeof hide === "function") await hide();
}
```

- [ ] **Step 4: Export it from the package index**

In `packages/ui/src/index.ts`, add this line (next to the other top-level exports, e.g. right after the `colors` export on line 1):

```ts
export { hideOverlay } from "./host";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test packages/ui/src/host.spec.tsx --preload ./test/bun-test-setup.ts --isolate`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/src/host.ts packages/ui/src/host.spec.tsx packages/ui/src/index.ts
git commit -m "feat(ui): add hideOverlay() SDK helper for plugins"
```

---

## Task 2: Call `hideOverlay()` from `useLinkLauncher` on success (test-first)

`useLinkLauncher` (plugins/quick-links/app.tsx, ~lines 153-200) is the single launch chokepoint for both the landing chips and the home widget. Close the overlay only on the `{ launched: true }` path.

**Files:**
- Modify: `plugins/quick-links/app.tsx`
- Modify: `plugins/quick-links/app.spec.tsx`

- [ ] **Step 1: Add a `hideOverlay` spy to the `@loadout/ui` test mock**

In `plugins/quick-links/app.spec.tsx`, near the other top-level mock declarations (after `callMock`, around line 19), add:

```tsx
const hideOverlayMock = mock(() => Promise.resolve());
```

Then, inside the `mock.module("@loadout/ui", () => ({ ... }))` object (the block starting ~line 25), add this property (e.g. right after the `notify: () => {},` line):

```tsx
  hideOverlay: hideOverlayMock,
```

- [ ] **Step 2: Write the failing tests**

Append to `plugins/quick-links/app.spec.tsx`:

```tsx
describe("closes the overlay on successful link launch", () => {
  const ONE_BROWSER = [
    { browserId: "firefox-native", name: "Firefox", kind: "native", appId: 1, gameId64: "1", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
  ];

  beforeEach(() => {
    callMock.mockReset();
    hideOverlayMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = { appId: 620, gameName: "Portal 2", startTime: Date.now() };
  });

  function mountWith(launchResult: unknown) {
    callMock.mockImplementation((method: string) => {
      if (method === "getState")
        return Promise.resolve({ ...baseState, installedBrowsers: ONE_BROWSER });
      if (method === "isGamingMode") return Promise.resolve(false);
      if (method === "launchUrl") return Promise.resolve(launchResult);
      if (method === "detectBrowsers") return Promise.resolve([]);
      if (method === "isSteamReachable") return Promise.resolve(true);
      return Promise.resolve({ ...baseState, installedBrowsers: ONE_BROWSER });
    });
  }

  async function clickFirstOpen(container: HTMLElement) {
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const open = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Open"),
      );
      expect(open).toBeTruthy();
    });
    const open = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Open"),
    ) as HTMLButtonElement;
    fireEvent.click(open);
  }

  it("hides the overlay after a launch returns launched:true", async () => {
    mountWith({ launched: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await clickFirstOpen(container);
    await waitFor(() => expect(hideOverlayMock).toHaveBeenCalledTimes(1));
  });

  it("does NOT hide the overlay when a launch fails", async () => {
    mountWith({ launched: false, reason: "not-installed", message: "no browser" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await clickFirstOpen(container);
    // Give the launch promise a tick to settle.
    await new Promise((r) => setTimeout(r, 30));
    expect(hideOverlayMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test plugins/quick-links/app.spec.tsx --preload ./test/bun-test-setup.ts --isolate -t "closes the overlay"`
Expected: the "hides the overlay after a launch returns launched:true" test FAILS (`hideOverlayMock` never called — the call site doesn't exist yet). The "does NOT hide" test passes already.

- [ ] **Step 4: Add the import**

In `plugins/quick-links/app.tsx`, add `hideOverlay` to the existing `@loadout/ui` import block (the one that already imports `Spinner`, `useFocusable`, etc.). For example add a line:

```tsx
  hideOverlay,
```

- [ ] **Step 5: Call it on the success path**

In `useLinkLauncher`, find the success branch:

```tsx
        if (result.launched) {
          return;
        }
```

Replace it with:

```tsx
        if (result.launched) {
          // Link is on its way to the browser — get the overlay out of
          // the way. Fire-and-forget; a missing host transport no-ops.
          void hideOverlay().catch(() => {});
          return;
        }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test plugins/quick-links/app.spec.tsx --preload ./test/bun-test-setup.ts --isolate -t "closes the overlay"`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add plugins/quick-links/app.tsx plugins/quick-links/app.spec.tsx
git commit -m "feat(quick-links): hide the overlay when a link opens"
```

---

## Task 3: Full verification + build + install

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test plugins/quick-links/ --preload ./test/bun-test-setup.ts --isolate
bun test packages/ui/src/host.spec.tsx --preload ./test/bun-test-setup.ts --isolate
bun run typecheck
bunx eslint packages/ui/ plugins/quick-links/
bun run check:specs
```
Expected: all tests pass; typecheck exit 0; eslint exit 0; check:specs OK.

- [ ] **Step 2: Build**

Run: `export PATH="$HOME/.bun/bin:$PATH" && sh scripts/build.sh`
Expected: `[OK] Electrobun overlay built`, exit 0.

- [ ] **Step 3: Install**

Run: `export PATH="$HOME/.bun/bin:$PATH" && sh scripts/install-local.sh`
Expected: `Services restarted.`, exit 0.

- [ ] **Step 4: Confirm clean reload**

Run: `journalctl -u loadout.service --no-pager --since "1 minute ago" | grep -i quick-links`
Expected: `onLoad completed for quick-links` and `Loaded plugin: Quick Links [backend=yes, frontend=yes]`, no errors.

---

## Self-Review Notes (author)

- **Spec coverage:** `hideOverlay()` SDK helper (Task 1), called only on `{launched:true}` (Task 2 Step 5), wherever links open (useLinkLauncher is the shared chokepoint), tests for both success-closes and failure-does-not (Task 2) plus SDK present/absent (Task 1), build+install (Task 3). All covered.
- **Type consistency:** `hideOverlay(): Promise<void>` defined in Task 1, imported and called in Task 2; mocked as `hideOverlayMock` in the spec.
- **No placeholders.**
