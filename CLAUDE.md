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

## Triaging user reports

When a user reports Loadout not working, get `scripts/loadout-doctor.sh`
output before theorising. It is read-only — no sudo, no installs, no
restarts — so it is always safe to ask for:

```
curl -fsSL https://raw.githubusercontent.com/srsholmes/loadout/main/scripts/loadout-doctor.sh | sh
```

It covers distro/kernel, the required tools + dlopen'd sonames, the
install layout with the on-disk `--version`, both units, a `/up` probe,
session/gamescope detection, both journals, and a "smoking guns" section
grepping for the strings each known failure mode emits.

Two habits that pay off, learned from the v0.8.2 CachyOS report:

- **Don't assume the newest release caused it.** Diff the tags first.
  That report was blamed on v0.8.2, but `apps/loadout/` was byte-identical
  between v0.8.1 and v0.8.2 apart from the version string, so downgrading
  could never have helped. The actual cause was a system library CachyOS
  had dropped in an unrelated rolling update.
- **"Can't access it" is ambiguous** — backend down, overlay crash-looping,
  and UI-not-appearing are different bugs with the same description. The
  doctor output distinguishes them; a follow-up question rarely does.

Note `LOADOUT_VERSION=v0.8.1 curl … | sh` does **not** work — the
assignment applies to `curl`, not the piped `sh`, so it silently installs
latest. The variable has to go on `sh`:

```
curl -fsSL …/install.sh | LOADOUT_VERSION=v0.8.1 sh
```

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
