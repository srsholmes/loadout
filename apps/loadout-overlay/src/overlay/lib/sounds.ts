/**
 * Sound engine for gaming-OS-native feel.
 *
 * Tries to load Steam Deck UI sounds from the local Steam installation
 * via the host RPC bridge (Electrobun). Falls back to procedural Web
 * Audio synthesis when the host isn't present or Steam isn't installed.
 *
 * AudioContext is lazily created on first call to comply with autoplay policies.
 * Volume + enabled state persist through the user config file.
 */

import { getConfigValue, setConfigValue } from "./userConfig";

const VOLUME_CONFIG_KEY = "sfxVolume";
const ENABLED_CONFIG_KEY = "sfxEnabled";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Volume / enabled settings
// ---------------------------------------------------------------------------

export function getSoundVolume(): number {
  const v = getConfigValue<number>(VOLUME_CONFIG_KEY, 0.3);
  return Math.max(0, Math.min(1, v));
}

export function setSoundVolume(v: number) {
  setConfigValue(VOLUME_CONFIG_KEY, Math.max(0, Math.min(1, v)));
}

export function isSoundEnabled(): boolean {
  return getConfigValue<boolean>(ENABLED_CONFIG_KEY, true);
}

export function setSoundEnabled(v: boolean) {
  setConfigValue(ENABLED_CONFIG_KEY, v);
}

// ---------------------------------------------------------------------------
// Steam sound file loading via host RPC
// ---------------------------------------------------------------------------

/** Map of sound name → decoded AudioBuffer (or null if failed to load). */
const steamBuffers = new Map<string, AudioBuffer | null>();
let steamSoundsLoaded = false;
let steamSoundsLoading = false;

/** Sound event → Steam WAV filename mapping. */
const STEAM_SOUND_MAP: Record<string, string> = {
  nav: "deck_ui_navigation.wav",
  select: "deck_ui_default_activation.wav",
  back: "deck_ui_hide_modal.wav",
  toggleOn: "deck_ui_switch_toggle_on.wav",
  toggleOff: "deck_ui_switch_toggle_off.wav",
  sliderUp: "deck_ui_slider_up.wav",
  sliderDown: "deck_ui_slider_down.wav",
  error: "confirmation_negative.wav",
  sideMenuIn: "deck_ui_side_menu_fly_in.wav",
  sideMenuOut: "deck_ui_side_menu_fly_out.wav",
  tabTransition: "deck_ui_tab_transition_01.wav",
};

/** Call a request on the Electroview RPC bridge if it's present. Returns
 *  undefined when running under plain `vite dev` so the loader gracefully
 *  falls back to synthesized sounds. */
async function hostRpc<T>(method: string, args?: Record<string, unknown>): Promise<T | undefined> {
  const electro = (window as unknown as {
    __electroview?: { rpc?: { request?: Record<string, (args?: unknown) => Promise<unknown>> } };
  }).__electroview;
  const fn = electro?.rpc?.request?.[method];
  if (typeof fn !== "function") return undefined;
  return (await fn(args)) as T;
}

/** Load all Steam sounds into AudioBuffers. Called once lazily. */
async function loadSteamSounds(): Promise<void> {
  if (steamSoundsLoaded || steamSoundsLoading) return;
  steamSoundsLoading = true;

  try {
    const path = await hostRpc<string | null>("getSteamSoundsPath");
    // undefined  → no host bridge; null  → host says Steam isn't installed.
    if (!path) {
      steamSoundsLoading = false;
      return;
    }

    const ac = getCtx();
    if (!ac) {
      steamSoundsLoading = false;
      return;
    }

    const entries = Object.entries(STEAM_SOUND_MAP);
    await Promise.all(
      entries.map(async ([key, filename]) => {
        try {
          // Electrobun returns Uint8Array over the wire, not number[].
          const bytes = await hostRpc<Uint8Array>("readSoundFile", { filename });
          if (!bytes) {
            steamBuffers.set(key, null);
            return;
          }
          const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          // .buffer is ArrayBuffer | SharedArrayBuffer in lib.dom; we allocated a
          // fresh ArrayBuffer-backed Uint8Array above so the slice is safe.
          const audioBuf = await ac.decodeAudioData(
            view.buffer.slice(0) as ArrayBuffer,
          );
          steamBuffers.set(key, audioBuf);
        } catch {
          steamBuffers.set(key, null);
        }
      }),
    );

    steamSoundsLoaded = true;
  } catch {
    // Host bridge threw mid-flight — use synthesized sounds.
  }
  steamSoundsLoading = false;
}

/** Play a cached Steam AudioBuffer. Returns true if played, false if not available. */
function playSteamSound(key: string): boolean {
  if (!isSoundEnabled()) return true; // pretend we played — skip synth too
  const buf = steamBuffers.get(key);
  if (!buf) return false;

  const ac = getCtx();
  if (!ac) return false;

  const vol = getSoundVolume();
  if (vol <= 0) return true;

  const source = ac.createBufferSource();
  source.buffer = buf;

  const gain = ac.createGain();
  gain.gain.value = vol;

  source.connect(gain);
  gain.connect(ac.destination);
  source.start();
  return true;
}

// Kick off loading on import (non-blocking)
loadSteamSounds();

// ---------------------------------------------------------------------------
// Synthesized fallback sounds
// ---------------------------------------------------------------------------

function burst(
  type: OscillatorType,
  freq: number,
  durationMs: number,
  peakGain: number,
  freqEnd?: number,
) {
  if (!isSoundEnabled()) return;
  const ac = getCtx();
  if (!ac) return;

  const vol = getSoundVolume();
  if (vol <= 0) return;

  const now = ac.currentTime;
  const dur = durationMs / 1000;

  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (freqEnd !== undefined) {
    osc.frequency.linearRampToValueAtTime(freqEnd, now + dur);
  }

  const gain = ac.createGain();
  const peak = peakGain * vol;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peak, now + 0.005);
  gain.gain.linearRampToValueAtTime(0, now + dur);

  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(now);
  osc.stop(now + dur + 0.01);
}

// ---------------------------------------------------------------------------
// Public API — tries Steam sounds first, falls back to synthesized
// ---------------------------------------------------------------------------

/** Navigate / focus change. */
export function playNav() {
  if (!playSteamSound("nav")) burst("sine", 800, 30, 0.15);
}

/** Select / A button. */
export function playSelect() {
  if (!playSteamSound("select")) burst("sine", 1200, 60, 0.25);
}

/** Back / B button. */
export function playBack() {
  if (!playSteamSound("back")) burst("sine", 600, 50, 0.2, 350);
}

/** Toggle switched on. */
export function playToggleOn() {
  if (!playSteamSound("toggleOn")) burst("sine", 600, 40, 0.2, 900);
}

/** Toggle switched off. */
export function playToggleOff() {
  if (!playSteamSound("toggleOff")) burst("sine", 900, 40, 0.2, 600);
}

/** Slider step. */
export function playSliderTick() {
  if (!playSteamSound("sliderUp")) burst("triangle", 1000, 15, 0.08);
}

/** Error. */
export function playError() {
  if (!playSteamSound("error")) burst("square", 200, 80, 0.15);
}

/** Side menu fly in. */
export function playSideMenuIn() {
  if (!playSteamSound("sideMenuIn")) burst("sine", 400, 100, 0.15, 800);
}

/** Side menu fly out. */
export function playSideMenuOut() {
  if (!playSteamSound("sideMenuOut")) burst("sine", 800, 100, 0.15, 400);
}

/** Tab transition. */
export function playTabTransition() {
  if (!playSteamSound("tabTransition")) burst("sine", 600, 40, 0.12, 800);
}
