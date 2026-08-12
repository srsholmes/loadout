# Privacy

Loadout collects **nothing** unless you explicitly turn crash reporting on.

There is no usage analytics, no feature tracking, no session recording, and no
account. Loadout has no server of its own and no way to identify you.

> **Status:** crash reporting is implemented but **not yet enabled** — no
> reporting endpoint is configured in released builds, so nothing is sent even
> if the setting is on. This document describes how it behaves once enabled.

## What Loadout does without asking

Two things reach the network by default, both of which predate crash reporting:

| What | Where to | Why |
|---|---|---|
| Update check on startup | `api.github.com` | Checks whether a newer release exists. An unauthenticated GET — GitHub sees your IP address and user-agent, and nothing about your machine is sent. |
| Artwork and plugin data | Steam CDN, and per-plugin services you enable | Game art, ProtonDB ratings, HowLongToBeat times. Each plugin declares which domains it may contact, enforced by a deny-by-default allow-list. |

## Crash reporting

**Off unless you turn it on.** You are asked once, with a plain yes/no and no
pre-selected answer. Declining is remembered and you are not asked again. You
can change your mind at any time in **Settings → Privacy**.

### What a crash report contains

Exactly these fields, and nothing else:

- The error type, message, and stack trace
- Which loadout process crashed (backend, overlay, or interface)
- The loadout version, and whether the fault came from loadout itself or from a
  plugin (with the plugin's id)
- That the operating system is Linux, and the runtime (Bun or CEF)

### What it never contains

- **No IP address**, no account, no user id, no device id — nothing that
  identifies you or your machine across reports
- **No home directory** — `/home/you/…`, `/var/home/you/…` and removable-media
  mounts like `/run/media/you/…` are all rewritten
- **No username or hostname** — removed from paths, and also from free-form
  error text (see the caveat below)
- **No Steam ID** — the account id in `userdata/` paths, plus SteamID64,
  SteamID3 and SteamID2 forms, are all rewritten to `<steamid>`
- **No API keys, tokens, or passwords** — redacted from error text
- **No console logs, no browser history, no request URLs, no cookies**
- **No usage data of any kind** — nothing about what you launch or do

One deliberate exception to the username rule: names shorter than five
characters are left alone in free-form text, because substituting them would
mangle ordinary words. In practice this means the standard SteamOS account name
`deck` is not redacted — it is the same on every Steam Deck and identifies
nobody. Paths are rewritten regardless of name length.

No identifier is attached to a report deliberately — there is no account, no
device id, and no generated install id. So reports are not designed to be
linkable to you or to each other, and one practical consequence is that a
report cannot be traced back and deleted on request, because there is nothing to
trace it by.

We stop short of promising that linkage is *impossible*. A stack trace is
free-form text produced by whatever code failed, and the guarantee is only ever
as good as the scrubbing described above. We remove every identifier we know how
to recognise — and we keep finding new ones to add.

### One thing we cannot fully guarantee

A crash report contains the error message written by whichever code failed. If a
game or a file has a revealing name and that name is part of the error, it can
appear in the message. Paths are rewritten, so `/home/you/Games/Some Game` becomes
`~/Games/Some Game` — the username is gone, but the folder name is not.

We scrub every pattern we can identify. We cannot scrub arbitrary text we can't
recognise. If this matters to you, leave crash reporting off.

### Where reports go

To [Grafana Cloud](https://grafana.com/products/cloud/frontend-observability/)
(Grafana Labs), on **EU** infrastructure, used purely as an error-tracking
processor.

Reports are sent to a Faro collector endpoint. Loadout explicitly disables
Grafana Cloud's IP-derived geolocation from the client side, on every report.

### Turning it off

Any one of these:

1. **Settings → Privacy → Send crash reports** — off.
2. Set `"crashReporting": "denied"` in `~/.config/loadout/config.json`.
3. Delete the key entirely. Anything that isn't exactly `"granted"` — including
   a missing, empty, or unreadable config file — means no reports are sent.

The check runs on **every** report, not at startup, so switching it off takes
effect immediately rather than at next restart.

## Verifying any of this

Loadout is BSD-3-Clause licensed and the whole reporting path is deliberately
small enough to read in one sitting:

- `packages/crash-report/src/types.ts` — every field that can be sent
- `packages/crash-report/src/scrub.ts` — what is removed before sending
- `packages/crash-report/src/transport.ts` — the entire network layer
- `packages/crash-report/src/consent.ts` — the consent check
- `packages/crash-report/src/spool.ts` — where a report waits if your device
  is offline or crashed before it could be sent

Loadout speaks Grafana's Faro wire protocol directly rather than using their
Web SDK, specifically so that this list is complete. An SDK would capture
console output, network breadcrumbs, page URLs and request headers by default,
and no honest short document could then tell you what leaves your machine.

The protocol supports a persistent installation id, a user object, and page and
browser metadata. Loadout populates none of them. The session id it does send is
regenerated every time the process starts and is never written to disk, so it
groups events within a single run and cannot follow you across restarts.

There is a test — "the never-leaks gate" in
`packages/crash-report/src/crash-report.test.ts` — that builds a report from a
crash containing a home directory, another user's path, a Steam ID, an API key
and a hostname, then asserts none of them survive into the transmitted bytes.

## Questions

Open an issue at
[github.com/srsholmes/loadout/issues](https://github.com/srsholmes/loadout/issues).

*Last updated: 2026-08-12.*
