# Third-party licenses

This file aggregates verbatim license text for upstream projects whose code,
data, or templates have been incorporated into this repository.

The overlay shell incorporates **Electrobun** (below). Each bundled plugin
under `plugins/` carries its own `NOTICE` file with any per-plugin
attribution.

A separate audit is still needed for runtime/build-time dependencies (npm
packages, Bun, daisyUI, react-icons, etc.).

---

## Electrobun (used by `apps/loadout-overlay`)

Source: <https://github.com/blackboardsh/electrobun>
SPDX: `MIT`

The overlay shell at `apps/loadout-overlay` is built on Electrobun
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

## CEF / Chromium (bundled in the Electrobun overlay)

Source: <https://bitbucket.org/chromiumembedded/cef> · <https://www.chromium.org>
SPDX: `BSD-3-Clause` (CEF itself), with bundled Chromium components under
their respective licenses (predominantly `BSD-3-Clause`; some components under
`MPL-2.0`, `LGPL-2.1` — notably the bundled FFmpeg — and others).

The overlay ships the CEF runtime produced by the Electrobun build — `libcef.so`,
the `Resources/` and `locales/` trees, ICU data, and the helper processes — in
the `loadout-overlay-*.tar.xz` release asset. The Chromium Embedded Framework
is distributed under the BSD 3-Clause license; the underlying Chromium project
bundles numerous third-party components under their own licenses.

Per those licenses, the full attribution text is reproduced in the
materials shipped with the CEF binary distribution rather than inlined here:

- CEF binary distribution `LICENSE.txt` and the bundled `about_credits.html`
  (Chromium's full credits), included alongside `libcef.so` in the overlay tree.
- Upstream references:
  - CEF binaries: <https://cef-builds.spotifycdn.com/index.html>
  - Chromium license: <https://chromium.googlesource.com/chromium/src/+/main/LICENSE>

If you redistribute the overlay tree, keep the CEF `LICENSE.txt` /
`about_credits.html` alongside the binaries.
