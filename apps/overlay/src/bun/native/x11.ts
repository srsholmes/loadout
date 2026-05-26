// libxcb wrapper for the gamescope atom hot path.
//
// The xprop-subprocess path in gamescope-atoms.ts spawns a process per
// atom write (~10ms each). When show() chains 6+ writes, the elapsed
// window during which Steam BPM and our overlay can both have
// STEAM_OVERLAY=1 is ~60ms — long enough for gamescope to flicker
// between compositing them while Steam BPM keeps re-asserting its
// overlay claim from its own render loop.
//
// libxcb queues all property changes on a single connection and flushes
// them in one round-trip to the X server. All PropertyNotify events
// land in gamescope's queue back-to-back, so its DetermineAndApplyFocus
// runs once on the final state — no intermediate "both at 1" window.
//
// This wrapper exposes a tight, gamescope-shaped surface:
//   - intern atoms (cached)
//   - change CARDINAL property (32-bit value) on a window
//   - read a CARDINAL property with a synchronous reply
//   - flush all pending writes in one round-trip
//
// We deliberately don't expose general xcb_send_event/configure paths
// — gamescope-atoms.ts is the only consumer and it only needs property
// manipulation.

import { ptr, read, type Pointer } from "bun:ffi";
import {
  libc,
  xcb,
  XCB_EVENT_MASK_PROPERTY_CHANGE,
  XCB_PROPERTY_NOTIFY,
  XCB_PROPERTY_NOTIFY_WINDOW_OFF,
  XCB_PROPERTY_NOTIFY_ATOM_OFF,
} from "./ffi";

/** PropMode constants (xproto.h: XCB_PROP_MODE_REPLACE = 0). */
const PROP_MODE_REPLACE = 0;

/** xcb_atom_t values for built-in atom types. From xproto.h. */
const XA_CARDINAL = 6;
const XA_STRING = 31;

/** xcb_get_property_reply_t header layout (xproto.h):
 *    uint8_t  response_type;   // 0
 *    uint8_t  format;          // 1
 *    uint16_t sequence;        // 2
 *    uint32_t length;          // 4
 *    xcb_atom_t type;          // 8  (uint32_t)
 *    uint32_t bytes_after;     // 12
 *    uint32_t value_len;       // 16  (count of `format`-bit elements)
 *    uint8_t  pad0[12];        // 20
 *  -> data starts at byte 32.
 */
const REPLY_HDR_FORMAT_OFF = 1;
const REPLY_HDR_TYPE_OFF = 8;
const REPLY_HDR_VALUE_LEN_OFF = 16;
const REPLY_HDR_SIZE = 32;

/**
 * Persistent libxcb connection plus an atom cache and a single root
 * lookup. One instance per process — the connection is opened lazily on
 * first use and closed at shutdown.
 */
export class X11Connection {
  private conn: Pointer | null = null;
  private atomCache = new Map<string, number>();
  private rootWindow: number = 0;

  /** Open the X11 connection and intern any atoms passed up front. Safe
   *  to call multiple times — idempotent. Returns false if the X server
   *  is unreachable (no DISPLAY, gamescope down, etc.) so callers can
   *  fall back to xprop or simply no-op. */
  connect(display: string): boolean {
    if (this.conn !== null) return true;
    const displayBuf = Buffer.from(display + "\0");
    const c = xcb.symbols.xcb_connect(displayBuf, null);
    if (!c || xcb.symbols.xcb_connection_has_error(c) !== 0) {
      // xcb_connect always returns a non-null connection even on error;
      // the error must be checked separately. We treat both as fatal.
      if (c) xcb.symbols.xcb_disconnect(c);
      return false;
    }
    this.conn = c;
    // We don't call xcb_get_setup / xcb_setup_roots_iterator here
    // because we mostly write CARDINAL atoms onto specific windows whose
    // IDs we already know via xprop/xdotool. Root-atom writes
    // (STEAM_TOUCH_CLICK_MODE) need the root window id; we lift it from
    // the X server reply header on first need rather than walking the
    // setup struct (saves ~50 lines of FFI marshaling).
    return true;
  }

  /** Forcibly close the connection. Idempotent. */
  disconnect(): void {
    if (this.conn === null) return;
    xcb.symbols.xcb_disconnect(this.conn);
    this.conn = null;
    this.atomCache.clear();
    this.rootWindow = 0;
  }

  /** True if the connection is open. */
  isConnected(): boolean {
    return this.conn !== null;
  }

  /** Set the root window id explicitly. xprop already knows it (via
   *  xcb_get_setup, but we don't have that bound) — gamescope-atoms.ts
   *  resolves it once via `xprop -root` and passes it in. */
  setRoot(windowId: number): void {
    this.rootWindow = windowId;
  }

  getRoot(): number {
    return this.rootWindow;
  }

  /**
   * Intern a property atom by name and cache it. Synchronous — issues
   * the cookie and waits for the reply. Returns 0 on error (caller
   * should treat as "atom unknown to server" and skip the operation).
   */
  internAtom(name: string): number {
    if (this.conn === null) return 0;
    const cached = this.atomCache.get(name);
    if (cached !== undefined) return cached;

    const nameBuf = Buffer.from(name + "\0");
    // only_if_exists=0 → create the atom if it doesn't exist. All the
    // atoms we deal with (STEAM_*, GAMESCOPE_*) are owned by the X server
    // once gamescope or Steam has registered them, but this works for
    // any case.
    const cookie = xcb.symbols.xcb_intern_atom(
      this.conn,
      0, // only_if_exists
      name.length,
      nameBuf,
    );
    const replyPtr = xcb.symbols.xcb_intern_atom_reply(
      this.conn,
      cookie,
      null,
    );
    if (!replyPtr) return 0;
    // xcb_intern_atom_reply_t layout (xproto.h):
    //   uint8_t response_type, pad0;  // 0,1
    //   uint16_t sequence;            // 2
    //   uint32_t length;              // 4
    //   xcb_atom_t atom;              // 8 (uint32_t)
    const atomId = read.u32(replyPtr, 8);
    libc.symbols.free(replyPtr);
    this.atomCache.set(name, atomId);
    return atomId;
  }

  /**
   * Queue a CARDINAL property write. Doesn't block — the write goes
   * onto libxcb's outgoing queue and is dispatched by `flush()`. Pass a
   * Uint32Array even for single values so the underlying FFI receives a
   * stable pointer.
   */
  setCardinal(windowId: number, atomName: string, value: number): void {
    if (this.conn === null) return;
    const atomId = this.internAtom(atomName);
    if (atomId === 0) return;
    const buf = new Uint32Array([value]);
    xcb.symbols.xcb_change_property(
      this.conn,
      PROP_MODE_REPLACE,
      windowId,
      atomId,
      XA_CARDINAL,
      32, // format
      1, // data_len (count of 32-bit values)
      ptr(buf),
    );
  }

  /** Queue a string property write (UTF-8 / Latin-1). Used for WM_CLASS
   *  and similar string-typed properties. */
  setString(windowId: number, atomName: string, value: string): void {
    if (this.conn === null) return;
    const atomId = this.internAtom(atomName);
    if (atomId === 0) return;
    const buf = Buffer.from(value, "utf8");
    xcb.symbols.xcb_change_property(
      this.conn,
      PROP_MODE_REPLACE,
      windowId,
      atomId,
      XA_STRING,
      8,
      buf.length,
      ptr(buf),
    );
  }

  /**
   * Read a single CARDINAL value off `windowId` synchronously. Returns
   * null if the property isn't set, isn't a CARDINAL, or the request
   * fails. Issues the cookie and immediately collects the reply — that
   * makes it a round-trip; for the reclaim hot path we batch reads via
   * `getCardinals` instead.
   */
  getCardinal(windowId: number, atomName: string): number | null {
    if (this.conn === null) return null;
    const atomId = this.internAtom(atomName);
    if (atomId === 0) return null;
    const cookie = xcb.symbols.xcb_get_property(
      this.conn,
      0, // delete
      windowId,
      atomId,
      XA_CARDINAL,
      0, // offset
      1, // length (32-bit elements requested)
    );
    const replyPtr = xcb.symbols.xcb_get_property_reply(
      this.conn,
      cookie,
      null,
    );
    if (!replyPtr) return null;
    try {
      const valueLen = read.u32(replyPtr, REPLY_HDR_VALUE_LEN_OFF);
      const format = read.u8(replyPtr, REPLY_HDR_FORMAT_OFF);
      const type = read.u32(replyPtr, REPLY_HDR_TYPE_OFF);
      if (valueLen === 0 || format !== 32 || type !== XA_CARDINAL) {
        return null;
      }
      // Value follows the 32-byte reply header. xcb_get_property_value()
      // is the official accessor; without it bound we read offset 32.
      return read.u32(replyPtr, REPLY_HDR_SIZE);
    } finally {
      libc.symbols.free(replyPtr);
    }
  }

  /**
   * Pipelined batch of CARDINAL reads on a single window. Issues all
   * cookies first, then collects replies — saves N-1 round-trips
   * compared to N sequential `getCardinal` calls. Returns a map keyed
   * by atom name; missing atoms are absent from the map.
   */
  getCardinals(
    windowId: number,
    atomNames: readonly string[],
  ): Map<string, number> {
    const out = new Map<string, number>();
    if (this.conn === null || atomNames.length === 0) return out;

    type Pending = { name: string; cookie: number };
    const pending: Pending[] = [];
    for (const name of atomNames) {
      const atomId = this.internAtom(name);
      if (atomId === 0) continue;
      const cookie = xcb.symbols.xcb_get_property(
        this.conn,
        0,
        windowId,
        atomId,
        XA_CARDINAL,
        0,
        1,
      );
      pending.push({ name, cookie });
    }
    for (const { name, cookie } of pending) {
      const replyPtr = xcb.symbols.xcb_get_property_reply(
        this.conn,
        cookie,
        null,
      );
      if (!replyPtr) continue;
      const valueLen = read.u32(replyPtr, REPLY_HDR_VALUE_LEN_OFF);
      const format = read.u8(replyPtr, REPLY_HDR_FORMAT_OFF);
      const type = read.u32(replyPtr, REPLY_HDR_TYPE_OFF);
      if (valueLen > 0 && format === 32 && type === XA_CARDINAL) {
        out.set(name, read.u32(replyPtr, REPLY_HDR_SIZE));
      }
      libc.symbols.free(replyPtr);
    }
    return out;
  }

  /** Dispatch all queued property writes to the X server in one
   *  round-trip. Property changes from a single client are processed in
   *  order, so gamescope sees all of them before the next focus
   *  arbitration runs. */
  flush(): void {
    if (this.conn === null) return;
    xcb.symbols.xcb_flush(this.conn);
  }

  /**
   * Subscribe the given window to PropertyChangeMask, so subsequent
   * property changes on it generate PropertyNotify events on this
   * connection's event queue.
   *
   * Pairs with `pollPropertyChanges()` for event-driven monitoring —
   * the same model HHD uses (`win.change_attributes(event_mask=
   * Xlib.X.PropertyChangeMask)`). Replaces our old 100ms polling
   * reclaim watcher: instead of reading Steam's atoms 10× per second
   * regardless of whether anything changed, we only react when Steam
   * actually changes state.
   */
  selectPropertyChanges(windowId: number): void {
    if (this.conn === null) return;
    // CW_EVENT_MASK = (1 << 11) — see /usr/include/xcb/xproto.h
    const CW_EVENT_MASK = 1 << 11;
    const valueList = new Uint32Array([XCB_EVENT_MASK_PROPERTY_CHANGE]);
    xcb.symbols.xcb_change_window_attributes(
      this.conn,
      windowId,
      CW_EVENT_MASK,
      ptr(valueList),
    );
    this.flush();
  }

  /**
   * Drain pending PropertyNotify events from the X server queue and
   * return the (window, atom) pairs that changed. Non-blocking; safe
   * to call from a fast tick loop. Other event types are silently
   * dropped (we only subscribed to PropertyChangeMask anyway).
   *
   * The atom value is the gamescope-interned atom id, NOT the human
   * name — callers compare against ids from `internAtom()`.
   */
  pollPropertyChanges(): Array<{ window: number; atom: number }> {
    if (this.conn === null) return [];
    const out: Array<{ window: number; atom: number }> = [];
    while (true) {
      const evtPtr = xcb.symbols.xcb_poll_for_event(this.conn);
      if (!evtPtr) break;
      // response_type's low 7 bits identify the event kind. Bit 7 is
      // set when the event came from xcb_send_event (synthetic) — we
      // ignore that bit by masking 0x7f.
      const responseType = read.u8(evtPtr, 0) & 0x7f;
      if (responseType === XCB_PROPERTY_NOTIFY) {
        out.push({
          window: read.u32(evtPtr, XCB_PROPERTY_NOTIFY_WINDOW_OFF),
          atom: read.u32(evtPtr, XCB_PROPERTY_NOTIFY_ATOM_OFF),
        });
      }
      libc.symbols.free(evtPtr);
    }
    return out;
  }
}
