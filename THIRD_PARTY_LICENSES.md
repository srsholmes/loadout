# Third-party licenses

This file aggregates verbatim license text for upstream projects whose code,
data, or templates have been incorporated into this repository — either
directly (porting / vendoring) or in a way that requires preserving the
upstream license per their terms.

For runtime/build-time dependencies (npm packages, Cargo crates, Bun, etc.)
a separate dependency-licensing audit is needed; this file currently covers
only the upstreams identified in `LICENSE_AUDIT.md`.

---

## Electrobun (used by `packages/overlay-electrobun`)

Source: <https://github.com/blackboardsh/electrobun>
SPDX: `MIT`

The overlay shell at `packages/overlay-electrobun` is built on Electrobun
(CEF). Per the MIT license, the upstream copyright notice and license
text are reproduced here verbatim:

```
MIT License

Copyright (c) 2024 Blackboard Technologies inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## decky-lsfg-vk (ported from, used by `plugins/lsfg-vk`)

Source: <https://github.com/xXJSONDeruloXx/decky-lsfg-vk>
SPDX: `BSD-3-Clause`

The `plugins/lsfg-vk` plugin's install / configure / wrapper flow is
ported from `decky-lsfg-vk`. Per BSD-3 §1 / §2 we preserve the upstream
copyright notice and disclaimer here verbatim:

```
BSD 3-Clause License

Copyright (c) 2025, Kurt Himebauch (JSON Derulo)
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from this
   software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

The upstream's LICENSE additionally carries an "Original Copyright (c)
2022-2024, Steam Deck Homebrew" line under the same BSD-3 terms; refer
to <https://github.com/xXJSONDeruloXx/decky-lsfg-vk/blob/main/LICENSE>
for the canonical multi-copyright text.

---

## PancakeTAS/lsfg-vk (referenced by `plugins/lsfg-vk`, runtime dependency)

Source: <https://github.com/PancakeTAS/lsfg-vk>
LICENSE: <https://github.com/PancakeTAS/lsfg-vk/blob/develop/LICENSE.md>
SPDX: `GPL-3.0`

The `plugins/lsfg-vk` plugin downloads `lsfg-vk_noui.zip` from this
upstream's GitHub Releases at user request. **The runtime is not
redistributed by this repository or its release artifacts** — the user
fetches the binary directly from PancakeTAS's official distribution,
and the GPL-3.0 governs the on-disk artifact on the user's machine.
This entry exists for transparency about runtime dependencies, not
because we redistribute GPL-licensed code.

---

## Handy (referenced by `plugins/handy-dictation`)

Source: <https://github.com/cjpais/Handy>
SPDX: `MIT`

The `plugins/handy-dictation` plugin is a thin runtime wrapper that downloads
`Handy.AppImage` from the upstream's GitHub Releases at the user's request.
Handy is **not** redistributed inside this repository or its release
artifacts; the AppImage is fetched directly from CJ Pais' official
distribution. Handy's MIT license therefore governs the AppImage on the
user's machine, not this repository's source. The verbatim text is reproduced
here for transparency:

```
MIT License

Copyright (c) 2025 CJ Pais

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Upstreams credited but not derived from

The following Decky-Loader plugins are credited in per-plugin `NOTICE` files
as inspiration / feature-parity reference. No code from these projects has
been copied into this repository, so their licenses do not bind ours, but
they are listed here for transparency.

| Plugin | Upstream | Upstream license |
|---|---|---|
| `plugins/sound-loader` | [DeckThemes/SDH-AudioLoader](https://github.com/DeckThemes/SDH-AudioLoader) | MIT + BSD-3-Clause (dual) |
| `plugins/theme-loader` | [DeckThemes/SDH-CssLoader](https://github.com/DeckThemes/SDH-CssLoader) | GPL-3.0 (referenced for theme-format interop only — see below) |
| `plugins/launch-options` | [Wurielle/decky-launch-options](https://github.com/Wurielle/decky-launch-options) | MIT + BSD-3-Clause (dual) |
| `plugins/mangohud-tweaks` | [Gawah/MangoPeel](https://github.com/Gawah/MangoPeel) | BSD-3-Clause |
| `plugins/flatpak-manager` | [jurassicplayer/decky-autoflatpaks](https://github.com/jurassicplayer/decky-autoflatpaks) | BSD-3-Clause |
| `plugins/protondb-badges` | [OMGDuke/protondb-decky](https://github.com/OMGDuke/protondb-decky) | GPL-3.0 OR BSD-3-Clause (dual; we elect BSD-3-Clause) |
| `plugins/steamgriddb` | [SteamGridDB/decky-steamgriddb](https://github.com/SteamGridDB/decky-steamgriddb) | GPL-3.0-or-later (referenced for API surface + Steam IPC enum values only — see below) |

**`plugins/theme-loader` interop note.** SDH-CssLoader is GPL-3.0. We
do not incorporate any of its source code. We do read the same theme
manifest format ("ThemeDB", `theme.json`) so existing community themes
work unmodified, and we fetch its public class-name translation feed at
runtime from `https://api.deckthemes.com/stable.json` (cached on the
user's machine, not redistributed). The community theme directory is
fetched live at runtime from `https://api.deckthemes.com/themes` and
cached for 24h — nothing is bundled. Theme thumbnails are hotlinked
from the upstream CDN, not bundled. See `plugins/theme-loader/NOTICE`
for the full statement.

**`plugins/steamgriddb` interop note.** SteamGridDB/decky-steamgriddb
is GPL-3.0-or-later. We do not incorporate any of its source code or
assets. We use the same public SteamGridDB v2 API endpoints (which are
documented at the SGDB API homepage and not specific to Decky), and we
call Steam's own `SteamClient.Apps.SetCustomArtworkForApp` IPC method
with the same `eAssetType` enum values (`{Capsule:0, Hero:1, Logo:2,
WideCapsule:3, Icon:4}`) — those are facts about Valve's IPC, not
Decky's invention. End users supply their own SteamGridDB API key; we
do not reuse the dedicated key shipped in Decky's plugin (which is
TOS-restricted to that distribution). See
`plugins/steamgriddb/NOTICE` for the full statement.

`plugins/lsfg-vk` is **not** in this table because we do derive code from
its upstream — the BSD-3 verbatim text is included above.

See each plugin's own `NOTICE` file for the precise attribution language.

---

## Outstanding

Items yet to be added to this file:

- `plugins/apex-fixes` — kernel-module / kernel-patch artifacts will need
  GPL-2.0 verbatim text and a written-source-offer per GPL-2 §3. Planned
  for extraction to a separate repository (see
  `plugins/apex-fixes/TODO.md`).
- Runtime/build dependency audit (Bun, daisyUI, react-icons, all npm and
  Cargo deps).

These are tracked in `LICENSE_AUDIT.md`.
