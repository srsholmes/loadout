// Watches /dev/input for event-node create / delete via inotify so
// controllers paired mid-session (most commonly a Bluetooth pad
// connected after the overlay is already running) surface to the
// input interceptor without an overlay restart.
//
// The watcher does not maintain its own thread — pollOnce() drains
// the non-blocking fd from the existing input-intercept poll tick.
// On IN_CREATE we wait a short settling delay before notifying so
// /proc/bus/input/devices has caught up with the new node (the
// kernel publishes the devfs entry and proc-fs entry asynchronously).

import {
  libc,
  IN_CLOEXEC,
  IN_NONBLOCK,
  IN_CREATE,
  IN_DELETE,
  INOTIFY_EVENT_HEADER_SIZE,
} from "./ffi";

const WATCH_DIR = "/dev/input";
const READ_BUF_SIZE = 4096;

// Delay between the inotify CREATE event and asking the caller to
// re-enumerate. /proc/bus/input/devices lags devfs by tens of
// milliseconds in practice on Bazzite — without this, the first
// read after a Bluetooth pair hits the kernel before the proc-fs
// entry exists and the device is silently dropped.
const PROCFS_SETTLE_MS = 100;

const EVENT_NAME_RE = /^event\d+$/;

export interface DeviceHotplugOptions {
  onAdded: (eventPath: string) => void;
  onRemoved: (eventPath: string) => void;
}

export interface DeviceHotplugHandle {
  /** Drain pending inotify events. Safe to call from the existing
   *  poll tick — the fd is non-blocking, so this returns immediately
   *  when nothing has fired. */
  poll(): void;
  /** Close the inotify fd. */
  shutdown(): void;
}

export function startDeviceHotplug(
  opts: DeviceHotplugOptions,
): DeviceHotplugHandle | null {
  const fd = libc.symbols.inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
  if (fd < 0) {
    console.warn(
      "[device-hotplug] inotify_init1 failed — hot-plug disabled",
    );
    return null;
  }
  const dirBuf = Buffer.from(WATCH_DIR + "\0");
  const wd = libc.symbols.inotify_add_watch(fd, dirBuf, IN_CREATE | IN_DELETE);
  if (wd < 0) {
    console.warn(
      `[device-hotplug] inotify_add_watch on ${WATCH_DIR} failed — hot-plug disabled`,
    );
    libc.symbols.close(fd);
    return null;
  }
  console.log(`[device-hotplug] watching ${WATCH_DIR}`);

  const buf = new Uint8Array(READ_BUF_SIZE);
  const view = new DataView(buf.buffer);
  const decoder = new TextDecoder();

  function pollOnce(): void {
    for (;;) {
      const n = Number(libc.symbols.read(fd, buf, BigInt(buf.byteLength)));
      if (n <= 0) return; // EAGAIN on a non-blocking fd is the steady state.
      let off = 0;
      while (off + INOTIFY_EVENT_HEADER_SIZE <= n) {
        const mask = view.getUint32(off + 4, true);
        const len = view.getUint32(off + 12, true);
        let name = "";
        if (len > 0) {
          // `len` is the padded byte count reserved for `name`; the
          // actual string is NUL-terminated inside that window.
          let end = off + INOTIFY_EVENT_HEADER_SIZE;
          const limit = end + len;
          while (end < limit && buf[end] !== 0) end++;
          name = decoder.decode(
            buf.subarray(off + INOTIFY_EVENT_HEADER_SIZE, end),
          );
        }
        off += INOTIFY_EVENT_HEADER_SIZE + len;

        if (!EVENT_NAME_RE.test(name)) continue;
        const eventPath = `${WATCH_DIR}/${name}`;
        if (mask & IN_CREATE) {
          setTimeout(() => opts.onAdded(eventPath), PROCFS_SETTLE_MS);
        }
        if (mask & IN_DELETE) {
          opts.onRemoved(eventPath);
        }
      }
    }
  }

  return {
    poll: pollOnce,
    shutdown: () => {
      libc.symbols.close(fd);
    },
  };
}
