// Shared bun:ffi bindings for libc and libxcb.
//
// Centralised so evdev.ts and x11.ts don't each reach into dlopen separately.
// ioctl numbers are the Linux-specific _IOW-encoded constants lifted from
// input-event-codes.h — identical to the ones declared in
// src-tauri/src/input_interceptor.rs.

import { dlopen, FFIType } from "bun:ffi";

// ---- libc -------------------------------------------------------------------

const libcPath = `libc.so.6`;

export const libc = dlopen(libcPath, {
  ioctl: {
    // int ioctl(int fd, unsigned long request, ... /* arg */);
    args: [FFIType.i32, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  open: {
    args: [FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
  close: {
    args: [FFIType.i32],
    returns: FFIType.i32,
  },
  read: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u64],
    returns: FFIType.i64,
  },
  epoll_create1: {
    args: [FFIType.i32],
    returns: FFIType.i32,
  },
  epoll_ctl: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr],
    returns: FFIType.i32,
  },
  epoll_wait: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  inotify_init1: {
    args: [FFIType.i32],
    returns: FFIType.i32,
  },
  inotify_add_watch: {
    args: [FFIType.i32, FFIType.cstring, FFIType.u32],
    returns: FFIType.i32,
  },
  kill: {
    // int kill(pid_t pid, int sig);  — used by process-control.ts to
    // SIGSTOP / SIGCONT the Steam process on overlay open/close so
    // gamepad input can't reach the game underneath.
    args: [FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  free: {
    // void free(void *ptr);  — used by x11.ts to release malloc'd
    // xcb reply buffers (xcb_get_property_reply, xcb_intern_atom_reply
    // etc. all return malloc()d pointers that the caller must free).
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
});

// ---- libxcb -----------------------------------------------------------------
//
// We'll use libxcb (not libX11) because it's leaner and the C API maps 1:1
// onto FFI without having to deal with Xlib's nested callback model.

const libxcbPath = `libxcb.so.1`;

export const xcb = dlopen(libxcbPath, {
  xcb_connect: {
    args: [FFIType.cstring, FFIType.ptr],
    returns: FFIType.ptr,
  },
  xcb_disconnect: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  xcb_connection_has_error: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  xcb_intern_atom: {
    args: [FFIType.ptr, FFIType.u8, FFIType.u16, FFIType.cstring],
    returns: FFIType.u32, // xcb_intern_atom_cookie_t is { uint32_t sequence }
  },
  xcb_intern_atom_reply: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.ptr,
  },
  xcb_change_property: {
    args: [
      FFIType.ptr, // connection
      FFIType.u8,  // mode
      FFIType.u32, // window
      FFIType.u32, // property atom
      FFIType.u32, // type atom
      FFIType.u8,  // format (8/16/32)
      FFIType.u32, // data_len
      FFIType.ptr, // data
    ],
    returns: FFIType.u32,
  },
  xcb_get_property: {
    args: [
      FFIType.ptr, // connection
      FFIType.u8,  // delete
      FFIType.u32, // window
      FFIType.u32, // property
      FFIType.u32, // type
      FFIType.u32, // offset
      FFIType.u32, // length
    ],
    returns: FFIType.u32,
  },
  xcb_get_property_reply: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.ptr,
  },
  xcb_query_tree: {
    args: [FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  xcb_query_tree_reply: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.ptr,
  },
  xcb_flush: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  // Subscribe a window to PropertyChangeMask events so XSelectInput-style
  // event-driven atom monitoring works. Replaces our old 100ms polling
  // reclaim watcher with a "react when Steam actually changes" model
  // (matches HHD's approach).
  //
  // C signature: xcb_void_cookie_t xcb_change_window_attributes(
  //     xcb_connection_t *c, xcb_window_t window,
  //     uint32_t value_mask, const uint32_t *value_list);
  xcb_change_window_attributes: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.u32,
  },
  // Drain pending events from the X server's incoming queue without
  // blocking. Returns NULL if no event ready. Each non-null pointer
  // must be free()'d.
  // C signature: xcb_generic_event_t *xcb_poll_for_event(xcb_connection_t *c);
  xcb_poll_for_event: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
});

// X11 event mask values (from /usr/include/X11/X.h).
export const XCB_EVENT_MASK_PROPERTY_CHANGE = 0x00400000;

// X11 event response_type values we care about (low 7 bits of byte 0
// of any xcb_generic_event_t).
export const XCB_PROPERTY_NOTIFY = 28;

// xcb_property_notify_event_t layout (32 bytes):
//   uint8_t  response_type;  // 0
//   uint8_t  pad0;           // 1
//   uint16_t sequence;       // 2
//   xcb_window_t window;     // 4  (uint32_t)
//   xcb_atom_t atom;         // 8  (uint32_t)
//   xcb_timestamp_t time;    // 12 (uint32_t)
//   uint8_t state;           // 16 (0 = NewValue, 1 = Deleted)
//   uint8_t pad1[15];        // 17..31
export const XCB_PROPERTY_NOTIFY_WINDOW_OFF = 4;
export const XCB_PROPERTY_NOTIFY_ATOM_OFF = 8;

// ---- ioctl numbers (linux/input.h) -----------------------------------------
// Lifted verbatim from src-tauri/src/input_interceptor.rs. These are the
// _IOW-encoded values, not symbolic — do not change without updating both.

export const EVIOCGRAB = 0x40044590n;   // _IOW('E', 0x90, int)
export const EVIOCSMASK = 0x40104593n;  // _IOW('E', 0x93, struct input_mask)

// ---- inotify (linux/inotify.h) ---------------------------------------------
// Used by device-hotplug.ts to watch /dev/input for event* node create/remove.

export const IN_CLOEXEC = 0x80000;
export const IN_NONBLOCK = 0x800;
export const IN_CREATE = 0x100;
export const IN_DELETE = 0x200;

// struct inotify_event header is 16 bytes on x86_64:
//   __s32 wd;       /* 4 bytes */
//   __u32 mask;     /* 4 bytes */
//   __u32 cookie;   /* 4 bytes */
//   __u32 len;      /* 4 bytes */
//   char  name[];   /* `len` bytes, NUL-terminated, padded to align */
export const INOTIFY_EVENT_HEADER_SIZE = 16;

// struct input_event is 24 bytes on x86_64:
//   struct timeval time;  /* 16 bytes */
//   __u16 type;           /*  2 bytes */
//   __u16 code;           /*  2 bytes */
//   __s32 value;          /*  4 bytes */
export const INPUT_EVENT_SIZE = 24;
