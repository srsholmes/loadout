#!/usr/bin/env python3
"""Monitor InputPlumber D-Bus signals to see what events fire for QAM/KB/Guide.

Subscribes to InputEvent signals from all InputPlumber D-Bus devices and logs
them. Also shows the current intercept mode state.

Run: python3 scripts/trace-qam-dbus.py
(No sudo needed for D-Bus session/system bus monitoring)
"""

import subprocess
import sys
import signal
import os


def main():
    # First, show the composite device tree
    print("InputPlumber D-Bus tree:")
    print("=" * 60)
    try:
        result = subprocess.run(
            ["busctl", "tree", "org.shadowblip.InputPlumber"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            print(result.stdout)
        else:
            print(f"  ERROR: {result.stderr.strip()}")
            print("  InputPlumber may not be running on system bus.")
            print("  Check: systemctl status inputplumber")
            sys.exit(1)
    except FileNotFoundError:
        print("  busctl not found")
        sys.exit(1)

    # Show current intercept mode for each composite device
    print("Composite device intercept modes:")
    print("-" * 60)
    try:
        tree_out = subprocess.run(
            ["busctl", "tree", "org.shadowblip.InputPlumber"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in tree_out.splitlines():
            line = line.strip().lstrip("/").lstrip()
            # Look for CompositeDevice paths
            if "CompositeDevice" in line:
                path = line.strip()
                if not path.startswith("/"):
                    path = "/" + path
                # Clean up tree formatting characters
                path = path.replace("├─", "").replace("└─", "").replace("│", "").strip()
                if not path.startswith("/"):
                    path = "/" + path
                try:
                    result = subprocess.run(
                        [
                            "busctl", "get-property",
                            "org.shadowblip.InputPlumber",
                            path,
                            "org.shadowblip.Input.CompositeDevice",
                            "InterceptMode",
                        ],
                        capture_output=True, text=True, timeout=5,
                    )
                    if result.returncode == 0:
                        mode = result.stdout.strip()
                        print(f"  {path}: {mode}")
                    else:
                        print(f"  {path}: (error: {result.stderr.strip()})")
                except Exception as e:
                    print(f"  {path}: (exception: {e})")
    except Exception:
        pass

    print()
    print("=" * 60)
    print("Monitoring ALL InputPlumber D-Bus signals.")
    print("Press QAM, KB, Guide, paddles — events will appear below.")
    print("Ctrl+C to stop.")
    print("=" * 60)
    print()

    # Monitor all signals from InputPlumber using busctl monitor
    # This shows InputEvent signals with event name and value
    try:
        proc = subprocess.Popen(
            [
                "busctl", "monitor",
                "--system",
                "org.shadowblip.InputPlumber",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        def cleanup(sig, frame):
            proc.terminate()
            print("\nDone.")
            sys.exit(0)

        signal.signal(signal.SIGINT, cleanup)

        # Stream output line by line, filtering for interesting events
        buffer = []
        for line in proc.stdout:
            line = line.rstrip()
            buffer.append(line)

            # Print signal blocks (busctl monitor groups lines)
            # A new signal starts with a line containing the signal metadata
            if line == "" and buffer:
                block = "\n".join(buffer)
                # Show InputEvent signals and property changes
                if "InputEvent" in block or "InterceptMode" in block or "PropertiesChanged" in block:
                    # Highlight QAM-related events
                    if "QuickAccess" in block:
                        print(">>> QAM BUTTON <<<")
                    elif "Keyboard" in block and "Key" not in block:
                        print(">>> KB BUTTON <<<")
                    elif "Guide" in block:
                        print(">>> GUIDE BUTTON <<<")
                    elif "Paddle" in block:
                        print(">>> PADDLE <<<")
                    print(block)
                    print()
                buffer = []

    except FileNotFoundError:
        print("busctl not found")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
