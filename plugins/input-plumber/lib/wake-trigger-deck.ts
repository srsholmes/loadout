/**
 * Steam Deck implementations of the wake-button public API.
 *
 * Bypasses InputPlumber entirely — Steam Input must stay in control of the
 * Deck's controller (per-game configs, Lizard mode, gyro, chords). Instead
 * we read /dev/hidraw{0,1,2} in parallel with Steam Input. See issue #86
 * for the architecture, and packages/deck-hid for the pure helpers.
 *
 * Same return shapes as the IP-based equivalents in wake-trigger.ts so the
 * picker UI (plugins/input-plumber/app.tsx) doesn't branch.
 *
 *   - `getWakeStatus()` reports `isDeck:true, ipActive:true` (so the picker
 *     hides the "Enable IP" path) and a single synthetic device whose
 *     buttons are the hardcoded DECK_BUTTONS list.
 *   - `setWakeButton(raw)` accepts a synthetic `"deck:<name>"` capability
 *     string and persists it. No fs/system writes — the overlay's
 *     hidraw watcher picks up the new binding on its next poll.
 *   - `captureWakeButton(timeoutMs)` opens the discovered hidraw briefly,
 *     watches for the first 0→1 transition on any DECK_BUTTONS entry,
 *     binds it, and returns. Coalesced with a single-flight gate.
 *   - `clearWakeButton()` clears the persisted binding; the watcher arms
 *     itself with no binding (no presses fire) on its next poll.
 *   - `reloadPersistedProfile()` is a no-op — the overlay watcher reads
 *     plugin-storage directly on every poll, no server-side reconciliation
 *     needed.
 */

import { createReadStream } from "node:fs";
import { readPluginStorage, writePluginStorage } from "@loadout/plugin-storage";
import {
  DECK_BUTTONS,
  findButton,
  findDeckHidrawPath,
  splitReports,
  REPORT_ID_INPUT,
  REPORT_LEN,
  type DeckButton,
} from "@loadout/deck-hid";
import type {
  WakeStatus,
  WakeStatusDevice,
  WakeButtonOption,
  WakeOpResult,
  WakeCaptureResult,
} from "../shared";

const PLUGIN_ID = "input-plumber";
const DECK_DEVICE_NAME = "Steam Deck Controller";

// ── Persisted state ─────────────────────────────────────────────────────────

interface WakeState {
  wake?: {
    /** "deck:<DeckButton.name>" — e.g. "deck:Steam". Round-trips through the
     *  picker as WakeButtonOption.raw. The "deck:" prefix lets the overlay
     *  watcher distinguish a Deck binding from a stale IP one. */
    selectedRaw: string | null;
    /** Always the Deck device label so the picker shows a stable header. */
    deviceName: string | null;
  };
}

async function readWake(): Promise<WakeState["wake"] | undefined> {
  const s = await readPluginStorage<WakeState>(PLUGIN_ID);
  return s.wake;
}

async function writeWake(wake: WakeState["wake"]): Promise<void> {
  const existing = await readPluginStorage<WakeState>(PLUGIN_ID);
  await writePluginStorage<WakeState>(PLUGIN_ID, { ...existing, wake });
}

// ── Raw <-> button mapping ──────────────────────────────────────────────────

const DECK_RAW_PREFIX = "deck:";

/** Convert a DeckButton to a synthetic capability for the picker. */
function buttonToRaw(b: DeckButton): string {
  return `${DECK_RAW_PREFIX}${b.name}`;
}

/** Extract a DeckButton from a "deck:<name>" raw, or null if unknown / stale. */
function rawToButton(raw: string | null | undefined): DeckButton | null {
  if (!raw) return null;
  if (!raw.startsWith(DECK_RAW_PREFIX)) return null;
  return findButton(raw.slice(DECK_RAW_PREFIX.length));
}

/** WakeButtonOption rows for the picker. All Deck candidates are
 *  recommended — the gameplay-buttons exclusion that exists for IP
 *  doesn't apply (DECK_BUTTONS already filters to safe choices). */
function deckButtonOptions(): WakeButtonOption[] {
  return DECK_BUTTONS.map((b) => ({
    raw: buttonToRaw(b),
    name: b.name,
    category: "deck",
    label: b.label,
    recommended: true,
  }));
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function getWakeStatus(): Promise<WakeStatus> {
  const wake = await readWake();
  const devices: WakeStatusDevice[] = [
    { name: DECK_DEVICE_NAME, buttons: deckButtonOptions() },
  ];
  // ipActive:true is a UI hint — it tells the picker that bind/capture are
  // immediately usable. There's no IP daemon involved; the field's contract
  // in shared.ts is "the picker can act", which is true here.
  return {
    ipActive: true,
    isDeck: true,
    devices,
    selectedRaw: wake?.selectedRaw ?? null,
    hasLegacyProfile: false,
  };
}

/** No setup needed on Deck — the overlay watcher owns the hidraw fd and
 *  picks up bindings from plugin-storage directly. */
export async function prepareWake(): Promise<WakeOpResult> {
  return { ok: true };
}

export async function setWakeButton(raw: string): Promise<WakeOpResult> {
  const btn = rawToButton(raw);
  if (!btn) {
    return {
      ok: false,
      error: `Unknown Deck button identifier: ${raw}`,
    };
  }
  await writeWake({ selectedRaw: buttonToRaw(btn), deviceName: DECK_DEVICE_NAME });
  return { ok: true };
}

export async function clearWakeButton(): Promise<WakeOpResult> {
  await writeWake({ selectedRaw: null, deviceName: null });
  return { ok: true };
}

/** No-op on Deck — there's no profile to reload. The watcher reads its
 *  binding from plugin-storage on every poll, so reboot reconciliation is
 *  automatic. Defined so the public API stays the same shape. */
export async function reloadPersistedProfile(): Promise<WakeOpResult> {
  return { ok: true };
}

// ── Press-to-capture ────────────────────────────────────────────────────────

/** Single-flight gate matching the IP path's behaviour: a second concurrent
 *  capture coalesces onto the first. Without this two pickers would race
 *  to open the same hidraw and persist different buttons. */
let captureInflight: Promise<WakeCaptureResult> | null = null;

export async function captureWakeButton(
  timeoutMs = 10_000,
): Promise<WakeCaptureResult> {
  if (captureInflight) return captureInflight;
  const ms = Math.max(1000, Math.min(60_000, timeoutMs || 10_000));
  captureInflight = (async () => captureInner(ms))().finally(() => {
    captureInflight = null;
  });
  return captureInflight;
}

async function captureInner(timeoutMs: number): Promise<WakeCaptureResult> {
  const path = await findDeckHidrawPath();
  if (!path) {
    return {
      ok: false,
      error: "Could not find the Steam Deck gamepad hidraw node.",
    };
  }

  // Snapshot the previous binding so a failed capture doesn't clobber it.
  // (The overlay watcher tolerates this either way — but capture-cancelled
  // shouldn't equal capture-cleared, which is what we'd get if we wrote a
  // null binding mid-flow.)
  const prev = await readWake();

  return new Promise<WakeCaptureResult>((resolve) => {
    const stream = createReadStream(path);
    let buf: Buffer = Buffer.alloc(0);
    /** Per-button "previously held" memory so a button that was already
     *  down when capture started doesn't fire on the first frame. */
    const held = new Map<string, boolean>();
    let settled = false;

    const finish = (result: WakeCaptureResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      // Restore the previous binding BEFORE resolving, so the single-flight
      // gate in captureWakeButton stays held until storage is consistent —
      // otherwise a second capture could start and get clobbered by this
      // late restore. Best-effort: a write failure must not crash the
      // overlay backend, so swallow it.
      void (async () => {
        try {
          if (prev && prev.selectedRaw !== (await readWake())?.selectedRaw) {
            await writeWake(prev);
          }
        } catch {
          /* best-effort restore */
        } finally {
          finish({
            ok: false,
            timedOut: true,
            error: "No button pressed within the timeout.",
          });
        }
      })();
    }, timeoutMs);

    const onData = (chunkRaw: Buffer | string): void => {
      if (settled) return;
      const chunk =
        typeof chunkRaw === "string" ? Buffer.from(chunkRaw) : chunkRaw;
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      let pressed: DeckButton | null = null;
      for (const report of splitReports(buf)) {
        // Only report id 0x01 carries button state; skip interleaved frames.
        if (report[0] !== REPORT_ID_INPUT) continue;
        for (const b of DECK_BUTTONS) {
          const cur = (report[b.byte] & (1 << b.bit)) !== 0;
          const prevHeld = held.get(b.name) ?? false;
          held.set(b.name, cur);
          if (cur && !prevHeld && !pressed) pressed = b;
        }
        if (pressed) break;
      }
      // Trim consumed frames.
      const consumed = Math.floor(buf.length / REPORT_LEN) * REPORT_LEN;
      buf = consumed === buf.length ? Buffer.alloc(0) : buf.subarray(consumed);
      if (!pressed) return;
      // Stop consuming further frames synchronously — detach the listener
      // before the await so a coalesced follow-up `data` event can't
      // re-enter and persist a second binding.
      stream.off("data", onData);
      const raw = buttonToRaw(pressed);
      const label = pressed.label;
      void (async () => {
        try {
          await writeWake({ selectedRaw: raw, deviceName: DECK_DEVICE_NAME });
          finish({ ok: true, capturedRaw: raw, capturedLabel: label });
        } catch (err) {
          finish({
            ok: false,
            error: `Failed to persist captured button: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      })();
    };

    stream.on("data", onData);
    stream.on("error", (err: Error) => {
      finish({ ok: false, error: `hidraw read error: ${err.message}` });
    });
  });
}
