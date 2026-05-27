#!/usr/bin/env bash
#
# ip-load-profile.sh — boot-time loader. Polls for IP's CompositeDevice to
# appear on D-Bus, then loads the overlay-trigger profile via LoadProfilePath.
#
# Deployed to /etc/loadout/inputplumber/ip-load-profile.sh; invoked by
# loadout-ip-profile.service ordered After=inputplumber, Before=graphical.
#
# Profile path is the second argument to LoadProfilePath; defaults to the
# one written by the installer, overridable for ad-hoc reloads.
SVC=org.shadowblip.InputPlumber
PROFILE="${1:-/etc/loadout/inputplumber/overlay-profile.yaml}"

for _ in $(seq 1 60); do
  CD=$(busctl tree "$SVC" 2>/dev/null | grep -oE "/org/shadowblip/InputPlumber/CompositeDevice[0-9]+" | head -1)
  [ -n "$CD" ] && break
  sleep 0.5
done

if [ -z "${CD:-}" ]; then
  echo "loadout: no IP composite device on D-Bus after 30s" >&2
  exit 0
fi

busctl call "$SVC" "$CD" org.shadowblip.Input.CompositeDevice LoadProfilePath s "$PROFILE"
