#!/usr/bin/env python3
"""Trace what evdev events fire when QAM / KB / Guide buttons are pressed.

Opens ALL /dev/input/event* devices and logs KEY events with device name,
keycode, and human-readable name. Press each button to see exactly which
device and keycode it uses.

Run: sudo python3 scripts/trace-qam-evdev.py
"""

import os
import select
import struct
import sys

# input_event struct: struct timeval (16 bytes on 64-bit), u16 type, u16 code, i32 value
INPUT_EVENT_FMT = "llHHi"
INPUT_EVENT_SIZE = struct.calcsize(INPUT_EVENT_FMT)

# Key code names (covers all the codes our overlay checks + common gamepad buttons)
KEY_NAMES = {
    # Modifiers
    0x1D: "KEY_LEFTCTRL",
    0x38: "KEY_LEFTALT",
    0x61: "KEY_RIGHTCTRL",
    0x64: "KEY_RIGHTALT",
    0x7D: "KEY_LEFTMETA",
    0x7E: "KEY_RIGHTMETA",
    # Number keys (our overlay uses Ctrl+1, Ctrl+2)
    0x02: "KEY_1",
    0x03: "KEY_2",
    # F-keys (the critical ones for this bug)
    0xB7: "KEY_F13",
    0xB8: "KEY_F14",
    0xB9: "KEY_F15",
    0xBA: "KEY_F16",
    0xBB: "KEY_F17",
    0xBC: "KEY_F18",
    # Other keys InputPlumber maps
    0x18: "KEY_O",
    0x22: "KEY_G",
    0x6F: "KEY_DELETE",
    0x63: "KEY_SYSRQ",
    # Volume (dials)
    0x72: "KEY_VOLUMEDOWN",
    0x73: "KEY_VOLUMEUP",
    0xE0: "KEY_BRIGHTNESSDOWN",
    0xE1: "KEY_BRIGHTNESSUP",
    # Gamepad buttons
    0x130: "BTN_SOUTH/A",
    0x131: "BTN_EAST/B",
    0x133: "BTN_NORTH/Y",
    0x134: "BTN_WEST/X",
    0x136: "BTN_TL",
    0x137: "BTN_TR",
    0x13A: "BTN_SELECT",
    0x13B: "BTN_START",
    0x13C: "BTN_MODE/GUIDE",
    0x13D: "BTN_THUMBL",
    0x13E: "BTN_THUMBR",
    # D-pad as buttons
    0x220: "BTN_DPAD_UP",
    0x221: "BTN_DPAD_DOWN",
    0x222: "BTN_DPAD_LEFT",
    0x223: "BTN_DPAD_RIGHT",
    # Trigger happy (paddles)
    0x2C0: "BTN_TRIGGER_HAPPY1",
    0x2C1: "BTN_TRIGGER_HAPPY2",
    0x2C2: "BTN_TRIGGER_HAPPY3",
    0x2C3: "BTN_TRIGGER_HAPPY4",
}

# Event types
EV_KEY = 1


def get_device_name(event_num):
    try:
        with open(f"/sys/class/input/event{event_num}/device/name") as f:
            return f.read().strip()
    except Exception:
        return "unknown"


def main():
    devices = {}

    print("Opening all input devices...\n")
    entries = sorted(
        [e for e in os.listdir("/dev/input") if e.startswith("event")],
        key=lambda x: int(x.replace("event", "")),
    )

    for entry in entries:
        num = int(entry.replace("event", ""))
        name = get_device_name(num)
        path = f"/dev/input/{entry}"
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            devices[fd] = (entry, name)
            print(f"  {entry:10s} = {name}")
        except PermissionError:
            print(f"  {entry:10s} = {name}  (SKIP: no permission)")
        except Exception as e:
            print(f"  {entry:10s} = {name}  (SKIP: {e})")

    if not devices:
        print("\nNo devices opened! Run with: sudo python3 scripts/trace-qam-evdev.py")
        sys.exit(1)

    print(f"\n{'='*80}")
    print("Press these buttons one at a time and note which device/keycode each uses:")
    print("  1. QAM button (Turbo)")
    print("  2. KB button")
    print("  3. Guide/Steam button (Orange)")
    print("  4. Back paddles")
    print("")
    print("KEY events only (SYN/ABS/MSC filtered). Ctrl+C to stop.")
    print(f"{'='*80}\n")

    poll = select.poll()
    for fd in devices:
        poll.register(fd, select.POLLIN)

    try:
        while True:
            events = poll.poll(1000)
            for fd, mask in events:
                if not (mask & select.POLLIN):
                    continue
                try:
                    while True:
                        data = os.read(fd, INPUT_EVENT_SIZE)
                        if len(data) < INPUT_EVENT_SIZE:
                            break
                        _, _, ev_type, ev_code, ev_value = struct.unpack(
                            INPUT_EVENT_FMT, data
                        )
                        if ev_type != EV_KEY:
                            continue

                        entry, name = devices[fd]
                        key_name = KEY_NAMES.get(ev_code, f"UNKNOWN_0x{ev_code:04x}")
                        state = (
                            "DOWN"
                            if ev_value == 1
                            else "UP"
                            if ev_value == 0
                            else f"REPEAT"
                        )

                        # Highlight the F-keys and BTN_MODE that could trigger our overlay
                        marker = ""
                        if ev_code in (0xB7, 0xB8, 0xB9, 0xBA):
                            marker = " <<< F-KEY (overlay trigger?)"
                        elif ev_code == 0x13C:
                            marker = " <<< BTN_MODE (guide)"

                        print(
                            f"  [{entry:10s}] {name:35s}  "
                            f"{key_name:20s} (0x{ev_code:04x})  {state}{marker}"
                        )
                except BlockingIOError:
                    pass
    except KeyboardInterrupt:
        print("\nDone.")
    finally:
        for fd in devices:
            os.close(fd)


if __name__ == "__main__":
    main()
