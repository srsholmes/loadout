# Quick Links Browser Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the "Open links in" dropdown and the browser installer into one radio-based `BrowserPicker`, and surface it inline on the landing page when no browser shortcut is registered (hidden once one is).

**Architecture:** Presentation-only refactor of `plugins/quick-links/app.tsx`. A new self-contained `BrowserPicker` component drives the existing RPCs (`detectBrowsers`, `isSteamReachable`, `setSelectedBrowserId`, `installBrowserShortcut`, `uninstallBrowserShortcut`) directly via `useBackend`. It replaces `BrowserShortcutCard` in settings and renders on the landing page when `installedBrowsers` is empty. The old `BrowserShortcutCard`, `NoBrowserBanner`, the `Select` dropdown, and the Gaming-Mode banner gating are removed.

**Tech Stack:** React 18, `@loadout/ui`, `bun:test` + happy-dom (`*.spec.tsx`). No backend changes.

**Spec:** `docs/superpowers/specs/2026-06-04-quick-links-browser-picker-design.md`

**Working dir:** `/var/home/srsholmes/Work/loadout-worktrees/quick-links` (branch `plugin/quick-links`). Run all `bun` commands with `export PATH="$HOME/.bun/bin:$PATH"`.

**Test commands:**
- UI spec: `bun test plugins/quick-links/app.spec.tsx --preload ./test/bun-test-setup.ts --isolate`
- Full plugin: `bun test plugins/quick-links/ --preload ./test/bun-test-setup.ts --isolate`
- Typecheck: `bun run typecheck`
- Lint (plugin only): `bunx eslint plugins/quick-links/`

---

## File Structure

- **Modify:** `plugins/quick-links/app.tsx` — add `installed` prop to `BrowserRadio`; add `BrowserPicker`; rewire settings + landing; delete `BrowserShortcutCard`, `NoBrowserBanner`, `showBanner` gating; drop the `Select` import.
- **Modify:** `plugins/quick-links/app.spec.tsx` — add radio/install/landing tests.

No other files change. No backend/RPC/storage changes.

---

## Task 1: Add an `installed` marker to `BrowserRadio`

`BrowserRadio` (app.tsx:675-714) renders one detected browser as a radio. The new picker needs each radio to show whether that browser already has a registered shortcut.

**Files:**
- Modify: `plugins/quick-links/app.tsx:675-714`

- [ ] **Step 1: Replace the `BrowserRadio` function**

Replace the entire existing `BrowserRadio` function (app.tsx:675-714) with:

```tsx
function BrowserRadio({
  candidate,
  checked,
  installed,
  onSelect,
}: {
  candidate: BrowserCandidate;
  checked: boolean;
  installed: boolean;
  onSelect: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onSelect });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onSelect}
      className={
        "flex items-center justify-between gap-3 px-3 py-2 rounded-lg w-full text-left " +
        (checked ? "bg-primary/15 ring-1 ring-primary/40 " : "bg-base-200 ") +
        (focused ? "ring-2 ring-primary/60" : "")
      }
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {installed && (
            <FaCheck className="w-3 h-3 shrink-0 text-success" />
          )}
          <div className="text-sm font-medium truncate">{candidate.name}</div>
        </div>
        <div className="text-[11px] text-base-content/55 mono truncate">
          {candidate.kind === "flatpak"
            ? `flatpak · ${candidate.flatpakAppId}`
            : candidate.exe}
        </div>
      </div>
      <span
        className={
          "w-4 h-4 rounded-full border-2 shrink-0 " +
          (checked
            ? "border-primary bg-primary"
            : "border-base-content/40 bg-transparent")
        }
      />
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck`
Expected: a type error at the existing `BrowserShortcutCard` call site (`BrowserRadio` now requires `installed`). That is expected — Task 3 deletes that caller. Proceed; do not "fix" the old card.

- [ ] **Step 3: Commit**

```bash
git add plugins/quick-links/app.tsx
git commit -m "feat(quick-links): add installed marker to BrowserRadio"
```

---

## Task 2: Create the `BrowserPicker` component (test-first)

`BrowserPicker` is the merged radio picker + installer. It is self-contained: it reads `installedBrowsers`/`selectedBrowserId` from the `storage` prop and drives all mutations via `useBackend`'s `call`. It will be wired into the UI in Tasks 3-4; this task creates it and its tests.

**Files:**
- Modify: `plugins/quick-links/app.tsx` (add `BrowserPicker` immediately after the `BrowserRadio` function)
- Test: `plugins/quick-links/app.spec.tsx`

- [ ] **Step 1: Write the failing tests**

Add this block to `plugins/quick-links/app.spec.tsx` at the end of the file (after the last `});`). It mounts the full app, navigates to settings, and asserts the new radio behavior. The mount/`callMock`/`currentGameRef`/`baseState` helpers already exist at the top of the file.

```tsx
describe("BrowserPicker (settings)", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = null;
  });

  const TWO_CANDIDATES = [
    { id: "firefox-native", name: "Firefox", kind: "native", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
    { id: "chrome-native", name: "Chrome", kind: "native", exe: "/usr/bin/chrome", launchOptionsBase: "{url}" },
  ];

  function rpcWith(state: unknown) {
    callMock.mockImplementation((method: string) => {
      if (method === "getState") return Promise.resolve(state);
      if (method === "isGamingMode") return Promise.resolve(false);
      if (method === "detectBrowsers") return Promise.resolve(TWO_CANDIDATES);
      if (method === "isSteamReachable") return Promise.resolve(true);
      return Promise.resolve(state);
    });
  }

  async function gotoSettings(container: HTMLElement) {
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      const cog = Array.from(container.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === "Quick Links settings",
      );
      expect(cog).toBeTruthy();
    });
    const cog = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Quick Links settings",
    ) as HTMLButtonElement;
    fireEvent.click(cog);
  }

  it("renders one radio per detected browser and no <select> dropdown", async () => {
    rpcWith({ ...baseState, installedBrowsers: [] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await gotoSettings(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Firefox");
      expect(container.textContent).toContain("Chrome");
    });
    expect(container.querySelector("select")).toBeNull();
  });

  it("selecting a browser radio calls setSelectedBrowserId with its id", async () => {
    rpcWith({ ...baseState, installedBrowsers: [] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await gotoSettings(container);
    await waitFor(() => expect(container.textContent).toContain("Chrome"));
    const chromeRadio = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Chrome"),
    ) as HTMLButtonElement;
    fireEvent.click(chromeRadio);
    expect(callMock).toHaveBeenCalledWith("setSelectedBrowserId", "chrome-native");
  });

  it("shows Install button when the selected browser has no shortcut", async () => {
    rpcWith({ ...baseState, installedBrowsers: [], selectedBrowserId: "firefox-native" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await gotoSettings(container);
    await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Install as non-Steam game"),
      );
      expect(btn).toBeTruthy();
    });
  });

  it("hides Install button when the selected browser is already installed", async () => {
    rpcWith({
      ...baseState,
      selectedBrowserId: "firefox-native",
      installedBrowsers: [
        { browserId: "firefox-native", name: "Firefox", kind: "native", appId: 1, gameId64: "1", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    await gotoSettings(container);
    await waitFor(() => expect(container.textContent).toContain("Firefox"));
    const installBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Install as non-Steam game"),
    );
    expect(installBtn).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test plugins/quick-links/app.spec.tsx --preload ./test/bun-test-setup.ts --isolate -t "BrowserPicker"`
Expected: FAIL. The dropdown still renders (`<select>` present) and there is no "Install as non-Steam game" button at these spots, because `BrowserPicker` isn't wired in yet (settings still renders `BrowserShortcutCard`). This confirms the tests exercise the new behavior.

- [ ] **Step 3: Add the `BrowserPicker` component**

Insert this function in `plugins/quick-links/app.tsx` immediately AFTER the `BrowserRadio` function (which now ends around app.tsx:716) and BEFORE the `BrowserShortcutCard` function:

```tsx
/**
 * Unified browser control: pick which detected browser opens links
 * (the checked radio == selectedBrowserId) and register it as a
 * non-Steam shortcut if it isn't one yet. Self-contained — drives the
 * RPCs directly so it can be dropped into both the settings page and
 * the landing first-run state. Live storage (installedBrowsers /
 * selectedBrowserId) arrives via the parent's stateChanged
 * subscription, so install/uninstall/select reflect without a manual
 * refetch.
 */
function BrowserPicker({ storage }: { storage: QuickLinksStorage }) {
  const { call } = useBackend("quick-links");
  const [candidates, setCandidates] = useState<BrowserCandidate[] | null>(null);
  const [steamReachable, setSteamReachable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installed = storage.installedBrowsers;
  const installedIds = useMemo(
    () => new Set(installed.map((s) => s.browserId)),
    [installed],
  );

  const refresh = useCallback(async () => {
    const [list, reachable] = await Promise.all([
      call("detectBrowsers") as Promise<BrowserCandidate[]>,
      call("isSteamReachable") as Promise<boolean>,
    ]);
    setCandidates(list);
    setSteamReachable(reachable);
  }, [call]);

  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  // Effective selection: the explicit selectedBrowserId, else the
  // most-recently-installed browser (what launchUrl falls back to),
  // else nothing. Drives which radio is checked and which browser the
  // Install / Uninstall button targets.
  const effectiveSelectedId =
    storage.selectedBrowserId ??
    installed[installed.length - 1]?.browserId ??
    null;
  const selectedInstalled =
    effectiveSelectedId != null && installedIds.has(effectiveSelectedId);

  const select = useCallback(
    (id: string) => {
      void call("setSelectedBrowserId", id).catch(() => {});
    },
    [call],
  );

  const install = useCallback(async () => {
    if (!effectiveSelectedId) return;
    setBusy(true);
    setError(null);
    try {
      await call("installBrowserShortcut", effectiveSelectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [call, effectiveSelectedId]);

  const uninstall = useCallback(
    (id: string) => {
      void call("uninstallBrowserShortcut", id).catch(() => {});
    },
    [call],
  );

  return (
    <div className="card">
      <div className="card-body p-4.5">
        <div className="flex items-center gap-2 mb-2">
          <FaGlobe className="w-4 h-4 shrink-0 text-base-content/60" />
          <div className="subsection-label mb-0">Open links in</div>
        </div>
        <div className="subsection-desc mb-3">
          Quick Links opens URLs through a non-Steam game shortcut so your
          browser inherits Gaming Mode's session (Steam Input, overlay,
          library entry). Pick a browser; if it isn't registered yet,
          install it as a non-Steam game.
        </div>

        {candidates === null ? (
          <div className="flex items-center justify-center h-10">
            <Spinner size={16} />
          </div>
        ) : candidates.length === 0 ? (
          <div className="subsection-desc mt-1 italic text-base-content/60">
            No supported browsers detected. Install Firefox, Chrome, Brave,
            Chromium, Edge, or Vivaldi — either as a native package or as a
            Flatpak.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {candidates.map((c) => (
                <BrowserRadio
                  key={c.id}
                  candidate={c}
                  checked={c.id === effectiveSelectedId}
                  installed={installedIds.has(c.id)}
                  onSelect={() => select(c.id)}
                />
              ))}
            </div>

            {steamReachable === false && (
              <div
                className="subsection-desc mt-3"
                style={{ color: "var(--color-error)" }}
              >
                <FaCircleExclamation className="inline w-3 h-3 mr-1" />
                Steam isn't responding on its debug port. Start Steam (Big
                Picture or Gaming Mode), then click Refresh.
              </div>
            )}

            {error && (
              <div
                className="subsection-desc mt-3"
                style={{ color: "var(--color-error)" }}
              >
                {error}
              </div>
            )}

            <div className="flex gap-2 mt-3 flex-wrap">
              {effectiveSelectedId && !selectedInstalled && (
                <FocusButton
                  onClick={() => void install()}
                  disabled={busy || steamReachable === false}
                  className="btn btn-sm btn-primary"
                >
                  {busy ? "Working…" : "Install as non-Steam game"}
                </FocusButton>
              )}
              {effectiveSelectedId && selectedInstalled && (
                <FocusButton
                  onClick={() => uninstall(effectiveSelectedId)}
                  disabled={busy}
                  className="btn btn-sm btn-ghost"
                >
                  <FaTrash className="mr-1" /> Uninstall shortcut
                </FocusButton>
              )}
              <FocusButton
                onClick={() => void refresh().catch(() => {})}
                disabled={busy}
                className="btn btn-sm btn-ghost"
              >
                Refresh
              </FocusButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into settings so the tests can exercise it**

In `QuickLinksPanel`'s settings render, replace the `<BrowserShortcutCard ... />` element (app.tsx:1365-1373) with:

```tsx
          <BrowserPicker storage={storage} />
```

Also delete the now-unused locals just above the `return` in the settings branch (app.tsx:1357-1358):

```tsx
  const hasInstalled = storage.installedBrowsers.length > 0;
  const installerStartExpanded = !hasInstalled;
```

(Leave `BrowserShortcutCard` itself in place for now — Task 5 deletes it.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test plugins/quick-links/app.spec.tsx --preload ./test/bun-test-setup.ts --isolate -t "BrowserPicker"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/quick-links/app.tsx plugins/quick-links/app.spec.tsx
git commit -m "feat(quick-links): add BrowserPicker (radio picker + inline install)"
```

---

## Task 3: Surface `BrowserPicker` on the landing page when no browser is installed

The landing page currently shows `NoBrowserBanner` (a "go to settings" dead-end) gated by `showBanner`. Replace that with the inline `BrowserPicker`, shown only when `installedBrowsers` is empty.

**Files:**
- Modify: `plugins/quick-links/app.tsx` (`QuickLinksLandingPage`, app.tsx:1095-1147)
- Test: `plugins/quick-links/app.spec.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `plugins/quick-links/app.spec.tsx`:

```tsx
describe("BrowserPicker on the landing page", () => {
  beforeEach(() => {
    callMock.mockReset();
    eventHandlers.clear();
    currentGameRef.value = null;
  });

  function rpcWith(state: unknown) {
    callMock.mockImplementation((method: string) => {
      if (method === "getState") return Promise.resolve(state);
      if (method === "isGamingMode") return Promise.resolve(false);
      if (method === "detectBrowsers")
        return Promise.resolve([
          { id: "firefox-native", name: "Firefox", kind: "native", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
        ]);
      if (method === "isSteamReachable") return Promise.resolve(true);
      return Promise.resolve(state);
    });
  }

  it("shows the picker on the landing page when no browser is installed", async () => {
    currentGameRef.value = { appId: 620, gameName: "Portal 2", startTime: Date.now() };
    rpcWith({ ...baseState, installedBrowsers: [] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    await waitFor(() => {
      expect(container.textContent).toContain("Open links in");
      expect(container.textContent).toContain("Firefox");
    });
  });

  it("hides the picker on the landing page once a browser is installed", async () => {
    currentGameRef.value = { appId: 620, gameName: "Portal 2", startTime: Date.now() };
    rpcWith({
      ...baseState,
      installedBrowsers: [
        { browserId: "firefox-native", name: "Firefox", kind: "native", appId: 1, gameId64: "1", exe: "/usr/bin/firefox", launchOptionsBase: "--new-tab {url}" },
      ],
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { mount } = await import("./app");
    mount(container);
    // Landing chips render (templates from baseState), but the picker does not.
    await waitFor(() => expect(container.textContent).toContain("ProtonDB"));
    expect(container.textContent).not.toContain("Open links in");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test plugins/quick-links/app.spec.tsx --preload ./test/bun-test-setup.ts --isolate -t "BrowserPicker on the landing"`
Expected: FAIL — the first test fails because the landing page does not render the picker yet (no "Open links in" on landing).

- [ ] **Step 3: Rewrite `QuickLinksLandingPage`**

Replace the entire `QuickLinksLandingPage` function (app.tsx:1095-1147) with this. It drops the `showBanner` prop and renders `BrowserPicker` at the top of both branches when `installedBrowsers` is empty:

```tsx
function QuickLinksLandingPage({
  storage,
  onOpenSettings,
}: {
  storage: QuickLinksStorage;
  onOpenSettings: () => void;
}) {
  const currentGame = useCurrentGame();
  const launch = useLinkLauncher(storage.selectedBrowserId);
  const needsBrowser = storage.installedBrowsers.length === 0;

  if (!currentGame) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content space-y-4">
          {needsBrowser && <BrowserPicker storage={storage} />}
          <div className="card">
            <div className="card-body p-6 flex flex-col items-center text-center gap-3">
              <FaLink className="w-6 h-6 text-base-content/40" />
              <div className="text-sm text-base-content/70">
                No game running — start a game to see contextual links.
              </div>
              <FocusButton
                className="btn btn-sm btn-primary"
                onClick={onOpenSettings}
                ariaLabel="Open Quick Links settings"
              >
                <FaGear className="mr-1.5" /> Open Settings
              </FocusButton>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const appId = currentGame.appId;
  const gameName = currentGame.gameName || `App ${appId}`;
  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content space-y-4">
        {needsBrowser && <BrowserPicker storage={storage} />}
        <LandingCardGrid
          storage={storage}
          appId={appId}
          gameName={gameName}
          onOpen={(url) => void launch(url)}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Update the landing-page call site in `QuickLinksPanel`**

Replace the landing render block (app.tsx:1340-1351) with (drop the `showBanner` prop):

```tsx
  if (view === "landing") {
    return (
      <>
        {header}
        <QuickLinksLandingPage
          storage={storage}
          onOpenSettings={() => setView("settings")}
        />
      </>
    );
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `export PATH="$HOME/.bun/bin:$PATH" && bun test plugins/quick-links/app.spec.tsx --preload ./test/bun-test-setup.ts --isolate -t "BrowserPicker on the landing"`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/quick-links/app.tsx plugins/quick-links/app.spec.tsx
git commit -m "feat(quick-links): inline BrowserPicker on landing when no browser installed"
```

---

## Task 4: Remove dead code and the Gaming-Mode banner gating

`BrowserShortcutCard`, `NoBrowserBanner`, the `Select` import, and the `inGamingMode`/`hasChromeOrFirefox`/`showBanner` gating are now unused.

**Files:**
- Modify: `plugins/quick-links/app.tsx`

- [ ] **Step 1: Delete `BrowserShortcutCard`**

Delete the entire `BrowserShortcutCard` function (the JSDoc block starting around app.tsx:716 and the function spanning ~app.tsx:724-962). It is no longer referenced.

- [ ] **Step 2: Delete `NoBrowserBanner`**

Delete the entire `NoBrowserBanner` function (its JSDoc block ~app.tsx:964 and the function ~app.tsx:975-1005). It is no longer referenced (the landing page no longer uses it).

- [ ] **Step 3: Remove the banner-gating state from `QuickLinksPanel`**

In `QuickLinksPanel`:
- Delete the `inGamingMode` state declaration:
  ```tsx
  const [inGamingMode, setInGamingMode] = useState(false);
  ```
- Delete the `isGamingMode` fetch inside the mount `useEffect` (leaving the `getState` fetch intact):
  ```tsx
    void call("isGamingMode")
      .then((v) => setInGamingMode(v === true))
      .catch(() => {});
  ```
- Delete the `hasChromeOrFirefox` memo and the `showBanner` const (the block app.tsx:1271-1282, from the `// Banner gating:` comment through the `showBanner = ...` statement).

- [ ] **Step 4: Drop the unused `Select` import**

In the `@loadout/ui` import block (app.tsx:34-40), remove the `Select,` line (app.tsx:38). `Select` has no remaining references.

- [ ] **Step 5: Typecheck + lint + full plugin tests**

Run each; all must pass clean:
```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run typecheck
bunx eslint plugins/quick-links/
bun test plugins/quick-links/ --preload ./test/bun-test-setup.ts --isolate
```
Expected: typecheck exit 0; eslint exit 0 (no unused-var warnings for `Select`/`inGamingMode`/`NoBrowserBanner`/`BrowserShortcutCard`); all plugin tests pass.

If eslint reports an unused import (e.g. `FaGlobe` only used by deleted code), remove that import too. Note: `FaGlobe` and `FaTrash` are still used by `BrowserPicker`; `FaPlus` is still used elsewhere (custom-link UI) — do not remove those.

- [ ] **Step 6: Commit**

```bash
git add plugins/quick-links/app.tsx
git commit -m "refactor(quick-links): remove BrowserShortcutCard, NoBrowserBanner, gaming-mode banner gating"
```

---

## Task 5: Full verification + build + install

**Files:** none (verification only).

- [ ] **Step 1: Run the complete plugin suite + repo checks**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test plugins/quick-links/ --preload ./test/bun-test-setup.ts --isolate
bun run check:specs
bun run typecheck
bunx eslint plugins/quick-links/
```
Expected: all green; `check:specs` OK; typecheck exit 0; eslint exit 0.

- [ ] **Step 2: Build**

Run: `export PATH="$HOME/.bun/bin:$PATH" && sh scripts/build.sh`
Expected: ends with `[OK] Electrobun overlay built` and exit 0.

- [ ] **Step 3: Install**

Run: `export PATH="$HOME/.bun/bin:$PATH" && sh scripts/install-local.sh`
Expected: ends with `Services restarted.` and exit 0. (`[fetch-deck-libs] … nothing to do.` is expected on this machine.)

- [ ] **Step 4: Confirm the plugin reloaded cleanly**

Run: `journalctl -u loadout.service --no-pager --since "1 minute ago" | grep -i quick-links`
Expected: `onLoad completed for quick-links` and `Loaded plugin: Quick Links [backend=yes, frontend=yes]`, no errors.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

Only if Step 1-4 required changes:
```bash
git add -A
git commit -m "fix(quick-links): verification fixups for BrowserPicker"
```

---

## Self-Review Notes (author)

- **Spec coverage:** radios replace dropdown (Task 1-2), merged install+select (Task 2), explicit-browsers-only/no "Default" (Task 2 — `effectiveSelectedId`, no default entry), landing surfacing when empty + hide once installed (Task 3), `NoBrowserBanner`/`Select`/gating removed (Task 4), tests (Tasks 2-3), build+install (Task 5). All covered.
- **Capability note:** the old settings card listed every installed browser with its own uninstall button; the new picker uninstalls via "select the browser → Uninstall shortcut." This is intentional per the merge.
- **Type consistency:** `BrowserPicker` takes only `{ storage }`; `BrowserRadio` gains a required `installed: boolean`; `QuickLinksLandingPage` drops `showBanner` and keeps `onOpenSettings`. Call sites updated in Tasks 2-4.
