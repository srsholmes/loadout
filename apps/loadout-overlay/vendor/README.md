# Patched Electrobun native wrapper (`libNativeWrapper.so`)

This directory vendors a **patched build of Electrobun's Linux native wrapper**
that fixes two bugs in the overlay's CEF browser process:

1. A **100%-CPU busy-loop** (the original reason this vendor exists).
2. A **multithreaded-Xlib crash on window move/resize** (upstream electrobun
   #426) — see "The move/resize crash" below.

The build step (`scripts/build.sh`) copies `libNativeWrapper.so` from here over
the stock one that `electrobun build --release` downloads, so clones and CI
releases get both fixes automatically.

## The bug it fixes

The overlay's CEF **browser process** pinned one full CPU core at ~100%
continuously — even idle, hidden, and on a blank page. A real battery/thermal
drain on a handheld. It did not break functionality, so it went unnoticed.

Root cause: Electrobun drives the Linux event loop with a raw `gtk_main()`
(a vanilla `g_main_loop_run`). CEF initializes lazily and installs its own GLib
sources — `MessagePumpGlib`'s work source and Ozone's X11 event source
(`ui::XSourcePrepare` / `x11::Connection::HasPendingResponses`) — onto the
**default `GMainContext`** that `gtk_main()` is already iterating. Those sources'
`prepare()` returns a 0 ms timeout unless `MessagePumpGlib::Run` has set up its
run-state. A plain `gtk_main()` iterates them **without** that state, so prepare
keeps reporting "work ready, timeout 0", the loop never blocks in `poll()`, and
the core spins. (Confirmed with `perf`: pure `g_main_context_prepare`/`check`,
~0 `ppoll`, ~0 dispatch.)

Note this is **not** the CEF #2809 external-message-pump path; an earlier attempt
using `external_message_pump=true` + `OnScheduleMessagePumpWork` was built,
loaded, and verified live — CPU stayed at ~100%. That approach was discarded.

## The fix

Run CEF's own message loop instead of a raw `gtk_main()`. In `runCEFEventLoop()`:

- Initialize CEF **eagerly** (was lazy, on first webview) so the loop exists.
- Call `CefRunMessageLoop()` instead of `gtk_main()`. It runs
  `MessagePumpGlib::Run`, which blocks correctly when idle while still servicing
  the default context (GTK dialogs/tray, the wrapper's X11 timer keep working).
- `settings.external_message_pump = false` (explicit; required for
  `CefRunMessageLoop`).
- Tear down with `CefQuitMessageLoop()` in `stopEventLoop()` (was
  `gtk_main_quit()`, which would no-op under CEF's loop and hang shutdown).

Result: idle CPU drops from ~100% to ~0%; the main thread blocks in `poll`.
Verified on-device: overlay renders, opens/closes, window maps/unmaps, clean
shutdown, no regressions.

See `nativeWrapper.cpp.patch` for the exact diff.

## The move/resize crash (electrobun #426)

Dragging the overlay window — resizing from a corner, or moving it between
monitors — crashed the whole app with `Signal 11` (and sometimes `SIGABRT`),
with non-deterministic backtraces in JSC's GC. Reproducible in a **pristine
`electrobun init` CEF app** on 1.16.0 **and** 1.18.1, so it's an upstream bug,
not ours (filed upstream as #426).

Root cause: **Xlib is driven from two threads with no `XInitThreads()`**.
`ElectrobunClient::OnPaint` (CEF UI thread) does `XCreateImage` / `XPutImage` /
`XFlush` on the **same `Display*`** that `process_x11_events` (the main/GTK
thread) drains events from. Without `XInitThreads()` those concurrent Xlib
calls corrupt Xlib's internal request heap during a move/resize event storm —
the corruption then surfaces as a SIGSEGV/SIGABRT in an unrelated thread
(usually JSC GC), which is why the backtraces looked random.

The fix is two changes in `runCEFEventLoop`/`process_x11_events`:

- **`XInitThreads()`** as the first call in `initializeGTK()` (before
  `gtk_init` and any `XOpenDisplay`), so Xlib serializes cross-thread calls.
- **Coalesce `ConfigureNotify`**: a drag emits a storm of them; we collapse the
  pending burst to the latest geometry (`XCheckTypedWindowEvent`) and fire the
  JS move/resize callbacks + the CEF `WasResized()`/OSR re-render **at most once
  per tick**, and only when x/y (move) or w/h (resize) actually changed — a pure
  move no longer triggers an OSR repaint storm.

Both are in `nativeWrapper.cpp.patch` alongside the CPU-spin fix.

## Provenance

- Upstream: `github.com/blackboardsh/electrobun` tag **v1.16.0**
  (commit `73519358cdcb50f02c1df3ecc80c33faedfb9ad4`).
- Patched file: `package/src/native/linux/nativeWrapper.cpp`.
- Build marker (printed at startup, grep the journal to confirm it's live):
  `=== ELECTROBUN NATIVE WRAPPER VERSION 1.0.2-loadout-cefloop ===`
- Built against CEF **145.0.23+g3e7fe1c / chromium 145.0.7632.68** (must match
  the `libcef.so` Electrobun bundles; `dlopen`'d at runtime).

## Rebuilding (when bumping Electrobun or CEF)

The wrapper must be rebuilt whenever Electrobun (and thus its bundled CEF) is
bumped, or the ABI will mismatch. Build in a container (SteamOS is immutable):

```sh
# 1. Clone the matching tag and apply the patch
git clone https://github.com/blackboardsh/electrobun.git
cd electrobun && git checkout v<version>
git apply /path/to/this/vendor/nativeWrapper.cpp.patch   # or re-port by hand

# 2. Provide the host's prebuilt libasar.so at the repo root as ./libasar.so
#    (electrobun build emits it; copy it out of a prior build)

# 3. Build the .so in Ubuntu (matches package/build.ts's compile/link steps)
podman run --rm -v "$PWD":/work:Z docker.io/library/ubuntu:24.04 \
  bash /work/build-wrapper.sh        # build-wrapper.sh is vendored alongside this README

# 4. Copy the result over the vendored copy
cp package/src/native/build/libNativeWrapper_cef.so \
   /path/to/apps/loadout-overlay/vendor/libNativeWrapper.so
```

`build-wrapper.sh` pins the CEF and electrobun-dawn URLs — bump those to match
the new Electrobun version. Confirm the version marker changed, swap into
`~/.local/share/loadout-overlay/bin/libNativeWrapper.so`, restart the service,
and check idle CPU is ~0.

## Upstreaming

The fix is generic — it fixes the spin for any Electrobun Linux app. Opening an
upstream PR (`CefRunMessageLoop` + eager init instead of `gtk_main`) would let us
drop this vendored binary entirely. Tracked in srsholmes/loadout#104.
