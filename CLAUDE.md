## Overlay architecture

The overlay is an Electrobun (CEF) app at `apps/loadout-overlay/`:

- `src/bun/` — the main process (Bun + libc FFI). Owns the evdev read
  loop, EVIOCGRAB / EVIOCSMASK, Gamescope atoms, NavController, the
  X11 window, and the RPC surface the webview talks to.
- `src/webview/` — the CEF-rendered UI boot shim. Pulls the shared
  React tree in via the `@overlay/*` path alias and wires
  `rpc.send("overlay-action", …)` → synthetic KeyboardEvents for
  norigin-spatial-navigation.

The shared React tree lives at `apps/loadout-overlay/src/overlay/`. The
host-RPC shim sits at `apps/loadout-overlay/src/overlay/lib/host.ts`;
every callsite imports from `@overlay/lib/host`. Its counterpart inside
the Electrobun webview is
`apps/loadout-overlay/src/webview/lib/electrobun.ts`.

CEF's DevTools live on `http://localhost:9222` in dev (baked in via
`electrobun.config.ts` → `build.linux.chromiumFlags`). Attach Chromium
or use CDP directly.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
