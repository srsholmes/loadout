# Media capture — screenshots & video clips

Loadout's README and per-plugin pages are illustrated with media captured
straight from the **running overlay** over its CEF DevTools endpoint
(`http://localhost:9222` in dev). Two scripts drive the same overlay the same
way — they share the CDP + navigation + recipe machinery in
[`scripts/lib/overlay-cdp.ts`](../scripts/lib/overlay-cdp.ts):

| Script                           | Output                            | Written to                                            |
| -------------------------------- | --------------------------------- | ----------------------------------------------------- |
| `scripts/capture-screenshots.ts` | PNG stills (tracked)              | `plugins/<id>/assets/screenshot*.png`, `docs/assets/` |
| `scripts/capture-videos.ts`      | animated **WebP** clips (tracked) | `plugins/<id>/assets/demo.webp`, `docs/assets/*.webp` |

## Prerequisites

- The overlay running in dev with DevTools exposed: `bun run dev:overlay`
  (DevTools is baked in via `electrobun.config.ts` → `build.linux.chromiumFlags`).
- `ffmpeg` on `PATH` — used to encode the captured frames. It's the only extra
  dependency; the WebP/GIF/H.264 encoders it ships with are all we need.

## Capturing video clips

There are two capture modes, both encoding to WebP with ffmpeg:

- **Per-plugin tours** (`--tours`, the default) — captioned tours defined by
  each plugin's `tour.json`. See [Per-plugin tours](#per-plugin-tours---tours).
- **Steam Big Picture** (`--target=steam`) — theme-loader / Store Bridge as
  they appear in Steam's own UI. See
  [Steam Big Picture clips](#steam-big-picture-clips---targetsteam).

```sh
bun run capture:videos --list          # list every tour + steam clip
bun run capture:videos --format=all    # also emit GIF + MP4 alongside the WebP
bun run capture:videos --width=1024    # lighter than the 1280 default
bun run capture:videos --keep-frames   # leave the raw JPEG frames in videos/
```

### How it records

`Page.startScreencast` streams JPEG frames as the page changes; each frame is
timestamped on arrival. Frames only arrive on a **visual change**, so a
deliberate `wait` hold emits no frames — its duration is preserved as the gap
to the next frame. ffmpeg then re-encodes the frames (with their real
per-frame durations) to a constant-rate animated WebP. Raw frames land in the
gitignored `videos/<clip>/` scratch dir and are deleted unless `--keep-frames`.

## Steam Big Picture clips (`--target=steam`)

Some of the best features — theme-loader's CSS theming and Store Bridge's Epic
collection — render in **Steam's own Big Picture UI**, not the overlay. That's a
different CEF surface (port `8080`, discovered via
[`@loadout/steam-cdp`](../packages/steam-cdp)), but the same screencast → ffmpeg
pipeline applies.

**Run it from Gaming Mode with Big Picture in the foreground.** CEF only rasters
its offscreen surface while Steam is actively painting it, so a backgrounded Big
Picture screencasts blank — the script skips a clip that captures too few
frames and tells you why.

Two clips ship (`--target=steam --list` to see them):

- **`steam-theme`** — flips theme-loader's injected `<style>` elements
  (`style[id^="theme-loader-"]`) off/on, so Big Picture visibly recolours
  between vanilla Steam and the active theme. It's the exact mechanism
  theme-loader uses, driven from the capture script — deterministic. **Enable a
  theme in theme-loader first**; a precheck skips the clip otherwise.
- **`steam-epic`** — Steam library navigation isn't reliably scriptable over
  CDP, so this records while **you** drive to the Epic / Store Bridge collection
  by hand, with an on-screen countdown (the same way the Big Picture stills are
  captured today).

Steam clips reuse the small `SteamStep` vocabulary (`eval` / `theme` / `manual`
/ `wait`) in the `STEAM_CLIPS` table — extend it the same way as the overlay
clips.

## Per-plugin tours (`--tours`)

Each plugin can ship a **`plugins/<id>/tour.json`** — a little scripted tour of
that plugin, with **captions burned into the video**. The capture script
discovers every plugin that has a `tour.json` (opt-in), navigates to it, records
the beats, and writes the clip to a **review folder** for you to watch before
anything is published:

```sh
bun run capture:videos --tours                     # all plugins with a tour.json
bun run capture:videos --tours --plugins=tdp-control
bun run capture:videos --promote=tdp-control,fan-control
```

- **Capture in Gaming Mode.** Run tours with the overlay open in Gaming Mode:
  gamescope renders at 1280×800, so that's the overlay's true native scale and
  the real end-user appearance (on the desktop the surface is upscaled to
  1920, which inflates size for no extra detail). Tours default to
  `--width=1280` to match; override with `--width` if you want bigger.
- **Privacy skips.** `network-info` (MAC/SSID/IP) and `playtime` (reveals your
  game history) are never toured, via `TOUR_SKIP` **and** the opt-in model
  (no `tour.json` → no tour). Be mindful that other plugins may still show
  library art (e.g. TDP's per-game profiles).
- **Review → promote.** `--tours` writes to `videos/review/<id>.webp` (the
  `videos/` scratch dir is gitignored). After you've watched them,
  `--promote=<id,…>` copies the approved clips into
  `plugins/<id>/assets/demo.webp` and inserts a `## Demo` section into each
  plugin README (idempotent). The promoted asset is a normal tracked file —
  commit it once you're happy with the clip.

### `tour.json` schema

```jsonc
{
  "title": "TDP Control · power tuning", // optional intro caption
  "fps": 15, // optional (per-tour)
  "tailMs": 900, // optional final-frame hold
  "steps": [
    { "kind": "wait", "ms": 1300 },
    { "kind": "text", "label": "Silent", "caption": "Quiet & cool for the couch" },
    { "kind": "aria", "label": "Custom device settings", "caption": "Add an unlisted device" },
    { "kind": "aria", "label": "Back to TDP Control" },
  ],
}
```

`steps` reuse the overlay `Step` vocabulary (`wait` / `nav` / `sidebar` /
`tile` / `aria` / `text`); the script auto-navigates to `#/plugin/<id>` first,
so steps describe in-plugin beats only. Any step (or the `title`) may carry a
`caption`, which shows from when that step fires until the next caption — mapped
onto the encoded timeline via the real frame durations, then drawn as a
lower-third with ffmpeg `drawtext` (into every output format).

## Why WebP for the README

GitHub-flavoured markdown renders repo-relative images (`![](…)`) and an
**animated WebP autoplays and loops inline**, exactly like a GIF but at a
fraction of the size. That makes committed WebP the one format that is both
self-contained (lives in the repo, versioned next to the code) _and_
inline-animated. The alternatives don't fit:

- **GIF** — also inline-animated, but 3–5× larger, and it balloons on
  photographic content (game box art) where its 256-colour palette struggles.
- **MP4 / WebM** — smallest and highest-quality, but a repo-relative
  `<video>`/`<source>` does **not** render on github.com. Only GitHub's own
  `user-images.githubusercontent.com` URLs (created by drag-dropping a file
  into an issue/PR) play inline — those aren't in the repo, aren't scriptable,
  and aren't versioned, which breaks the deterministic-assets pattern the rest
  of the media pipeline follows.

Rough format comparison for a ~5 s flat-UI clip (WebP q55):

| Format      | Size                           | Inline on GitHub?         |
| ----------- | ------------------------------ | ------------------------- |
| WebP (q55)  | small                          | ✅ `![](…)`               |
| GIF         | 3–5× the WebP → many MB on art | ✅ `![](…)`               |
| MP4 (H.264) | ~10× smaller than WebP         | ❌ repo path won't render |

### Resolution & file-size guidance

Clips capture at the handheld's native width (`--width=1280` by default) so UI
text stays legible; drop `--width` (e.g. `--width=960`) for lighter README
files at the cost of sharpness. WebP encodes each frame near-independently, so
**resolution and frame count both drive size**, and **photographic content is
expensive**:

- Flat UI (dashboards, controls, sidebar) compresses beautifully — keep those
  for hero/tour clips.
- Game-art grids and hero art are gorgeous but heavy; keep those clips short
  and per-plugin rather than dwelling on them in the tour.
- Longer / higher-res clips can drop to 12–15 fps via a per-clip `fps` (or the
  `--fps=` flag) — the eye tolerates it for UI motion and it cuts size roughly
  proportionally.

## Embedding

- **Root README** — the hand-written
  [`See it in action`](../README.md#see-it-in-action) section embeds a hero
  clip (currently `plugins/tdp-control/assets/demo.webp`).
- **Per-plugin README** — `--promote` inserts a `## Demo` section, and
  `scripts/scaffold-plugin-readmes.ts` renders one for any plugin that has an
  `assets/demo.webp`. Either way, capture the tour and the README picks it up.
