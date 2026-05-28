import { useState, useEffect, useCallback, useRef } from "react";
import {
  FaSliders,
  FaVolumeHigh,
  FaVolumeXmark,
  FaVolumeLow,
  FaMicrophone,
  FaMicrophoneSlash,
  FaHeadphones,
} from "react-icons/fa6";
import {
  Button,
  IconButton,
  Spinner,
  Slider,
  SegmentedItem,
  Toggle,
  mountComponent,
  useBackend,
  useCurrentGame,
} from "@loadout/ui";

export const icon = FaSliders;

// ---------------------------------------------------------------------------
// Types (mirroring backend.ts)
// ---------------------------------------------------------------------------

type StreamKind = "playback" | "recording";
type DeviceKind = "sink" | "source";

interface AudioStream {
  id: number;
  label: string;
  appName: string;
  iconName: string | null;
  mediaName: string | null;
  volume: number;
  muted: boolean;
  kind: StreamKind;
}

interface AudioDevice {
  id: number;
  nodeName: string;
  label: string;
  description: string;
  isDefault: boolean;
  volume: number;
  muted: boolean;
  kind: DeviceKind;
}

interface MixerState {
  available: boolean;
  unavailableReason: string | null;
  sinks: AudioDevice[];
  sources: AudioDevice[];
  playbackStreams: AudioStream[];
  recordingStreams: AudioStream[];
}

const VOLUME_MAX = 1.5; // matches wpctl's default boost ceiling

// ---------------------------------------------------------------------------
// Volume row — used by both devices and streams
// ---------------------------------------------------------------------------

interface VolumeRowProps {
  id: number;
  label: string;
  sublabel?: string | null;
  volume: number;
  muted: boolean;
  isMicrophone?: boolean;
  badge?: string | null;
  onVolume: (id: number, v: number) => void;
  onMute: (id: number) => void;
}

function VolumeRow({
  id,
  label,
  sublabel,
  volume,
  muted,
  isMicrophone,
  badge,
  onVolume,
  onMute,
}: VolumeRowProps) {
  // Track local slider value so dragging is smooth even though the
  // authoritative state is on the backend (2 Hz polling). Backend writes
  // happen on commit (pointer-up / blur / 600 ms idle) — see Slider.
  const [local, setLocal] = useState(volume);
  const interactingRef = useRef(false);
  const interactingClear = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!interactingRef.current) setLocal(volume);
  }, [volume]);

  useEffect(
    () => () => {
      if (interactingClear.current) clearTimeout(interactingClear.current);
    },
    [],
  );

  const handleChange = useCallback((v: number) => {
    setLocal(v);
    interactingRef.current = true;
    if (interactingClear.current) clearTimeout(interactingClear.current);
  }, []);

  const handleCommit = useCallback(
    (v: number) => {
      setLocal(v);
      onVolume(id, v);
      if (interactingClear.current) clearTimeout(interactingClear.current);
      interactingClear.current = setTimeout(() => {
        interactingRef.current = false;
      }, 200);
    },
    [id, onVolume],
  );

  const percent = Math.round(local * 100);
  const muteIcon = isMicrophone ? (
    muted ? (
      <FaMicrophoneSlash />
    ) : (
      <FaMicrophone />
    )
  ) : muted ? (
    <FaVolumeXmark />
  ) : percent < 1 ? (
    <FaVolumeXmark />
  ) : percent < 50 ? (
    <FaVolumeLow />
  ) : (
    <FaVolumeHigh />
  );

  return (
    <div
      className="row"
      style={{
        flexDirection: "column",
        alignItems: "stretch",
        gap: 8,
        padding: "10px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          minWidth: 0,
        }}
      >
        <IconButton
          onClick={() => onMute(id)}
          ariaLabel={muted ? "Unmute" : "Mute"}
          size={32}
          style={{
            border: "1px solid var(--border)",
            background: muted ? "var(--bg-inset)" : "transparent",
            color: muted ? "var(--color-warning)" : "var(--fg-1)",
          }}
        >
          {muteIcon}
        </IconButton>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </div>
          {sublabel && (
            <div
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--fg-3)",
                marginTop: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {sublabel}
            </div>
          )}
        </div>
        {badge && <span className="chip chip-accent">{badge}</span>}
        <span
          className="mono"
          style={{
            fontSize: 12,
            color: muted ? "var(--fg-3)" : "var(--fg-1)",
            minWidth: 44,
            textAlign: "right",
          }}
        >
          {muted ? "—" : `${percent}%`}
        </span>
      </div>
      <Slider
        value={local}
        onChange={handleChange}
        onCommit={handleCommit}
        min={0}
        max={VOLUME_MAX}
        step={0.01}
        disabled={muted}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

interface AudioGameProfileLite {
  appId: number;
  gameName: string;
  defaultSinkName?: string;
  masterVolume?: number;
}

function AudioMixer() {
  const { call, useEvent } = useBackend("audio-mixer");
  const currentGame = useCurrentGame();
  const [state, setState] = useState<MixerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInputs, setShowInputs] = useState(false);
  const [perGameEnabled, setPerGameEnabled] = useState(false);
  const [gameProfiles, setGameProfiles] = useState<AudioGameProfileLite[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([call("getPerGameEnabled"), call("getGameProfiles")])
      .then(([enabled, list]) => {
        if (!alive) return;
        setPerGameEnabled(Boolean(enabled));
        setGameProfiles((list as AudioGameProfileLite[]) ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call]);

  useEvent({
    event: "perGameEnabledChanged",
    handler: (data: unknown) => {
      const { enabled } = data as { enabled: boolean };
      setPerGameEnabled(enabled);
    },
  });

  useEvent({
    event: "gameProfileChanged",
    handler: () => {
      call("getGameProfiles")
        .then((list) => setGameProfiles((list as AudioGameProfileLite[]) ?? []))
        .catch(() => {});
    },
  });

  const handleTogglePerGame = useCallback(
    async (next: boolean) => {
      setPerGameEnabled(next);
      await call("setPerGameEnabled", next).catch(() =>
        setPerGameEnabled(!next),
      );
    },
    [call],
  );

  const handleRemoveGameProfile = useCallback(
    async (appId: number) => {
      await call("removeGameProfile", appId).catch(() => {});
      const list = (await call("getGameProfiles").catch(
        () => [],
      )) as AudioGameProfileLite[];
      setGameProfiles(list);
    },
    [call],
  );

  useEffect(() => {
    let alive = true;
    call("getMixerState")
      .then((s) => {
        if (alive) setState(s as MixerState);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [call]);

  useEvent({
    event: "mixerChanged",
    handler: (data) => {
      setState(data as MixerState);
    },
  });

  const handleVolume = useCallback(
    (id: number, volume: number) => {
      call("setVolume", id, volume).catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    },
    [call],
  );

  const handleMute = useCallback(
    (id: number) => {
      call("setMute", id, "toggle").catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    },
    [call],
  );

  const handleSetDefault = useCallback(
    (id: number) => {
      call("setDefault", id).catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    },
    [call],
  );

  if (!state) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="flex items-center justify-center h-64">
            <Spinner size={32} />
          </div>
        </div>
      </div>
    );
  }

  if (!state.available) {
    return (
      <div className="p-7 h-full overflow-y-auto">
        <div className="page-content">
          <div className="card">
            <div className="card-body p-4.5">
              <div
                className="subsection-label mb-1.5"
                style={{ color: "var(--color-warning)" }}
              >
                Audio mixer unavailable
              </div>
              <div className="text-sm text-base-content/80">
                {state.unavailableReason ??
                  "PipeWire/WirePlumber are required. Install the wireplumber and pipewire packages, then reopen this plugin."}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const defaultSink = state.sinks.find((s) => s.isDefault) ?? state.sinks[0];

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {/* PER-GAME PROFILES */}
        <div className="card">
          <div className="card-body p-4.5">
            <div className="flex items-center justify-between mb-3.5">
              <div>
                <div className="subsection-label mb-0">Per-Game Profiles</div>
                <div className="subsection-desc mt-1">
                  Save the default output and master volume for the running
                  game; auto-apply on next launch.
                </div>
              </div>
              <Toggle
                checked={perGameEnabled}
                onChange={(next) => handleTogglePerGame(Boolean(next))}
              />
            </div>
            {perGameEnabled && currentGame && (
              <div className="row">
                <span className="row-label truncate">
                  Currently bound to{" "}
                  {currentGame.gameName || `App ${currentGame.appId}`}
                </span>
                <span className="row-value">
                  {(() => {
                    const p = gameProfiles.find(
                      (x) => x.appId === currentGame.appId,
                    );
                    if (!p) return "Unsaved";
                    const parts: string[] = [];
                    if (p.defaultSinkName) parts.push("sink");
                    if (typeof p.masterVolume === "number")
                      parts.push(`${Math.round(p.masterVolume * 100)}%`);
                    return parts.length ? parts.join(" · ") : "Unsaved";
                  })()}
                </span>
              </div>
            )}
            {perGameEnabled && gameProfiles.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {gameProfiles.map((p) => (
                  <div key={p.appId} className="row">
                    <span className="row-label truncate">
                      {p.gameName || `App ${p.appId}`}
                    </span>
                    <span className="row-value">
                      {typeof p.masterVolume === "number"
                        ? `${Math.round(p.masterVolume * 100)}%`
                        : "—"}
                    </span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => handleRemoveGameProfile(p.appId)}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* OUTPUT DEVICE — selector + master volume */}
        <div className="card">
          <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaHeadphones className="w-3 h-3" /> OUTPUT
            </div>
            {defaultSink && (
              <span className="chip chip-accent">{defaultSink.label}</span>
            )}
          </div>
          <div className="px-4.5 py-4">
            {state.sinks.length === 0 ? (
              <div className="subsection-desc">No output devices found.</div>
            ) : (
              <>
                {state.sinks.length > 1 && (
                  <div className="subsection" style={{ marginTop: 0 }}>
                    <div className="subsection-label">Device</div>
                    <div
                      className="segmented w-full"
                      style={{ flexWrap: "wrap" }}
                    >
                      {state.sinks.map((sink) => (
                        <SegmentedItem
                          key={sink.id}
                          active={sink.isDefault}
                          onSelect={() => handleSetDefault(sink.id)}
                          style={{ flex: 1, minWidth: 140 }}
                        >
                          {sink.label}
                        </SegmentedItem>
                      ))}
                    </div>
                  </div>
                )}
                {defaultSink && (
                  <div className="subsection">
                    <div className="subsection-label">Master Volume</div>
                    <VolumeRow
                      id={defaultSink.id}
                      label={defaultSink.label}
                      sublabel={defaultSink.description}
                      volume={defaultSink.volume}
                      muted={defaultSink.muted}
                      onVolume={handleVolume}
                      onMute={handleMute}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* PER-APP MIXER */}
        <div className="card">
          <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
            <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
              <FaSliders className="w-3 h-3" /> APPLICATIONS
            </div>
            <span className="mono text-[11px] text-base-content/50">
              {state.playbackStreams.length}
              {state.playbackStreams.length === 1 ? " stream" : " streams"}
            </span>
          </div>
          <div className="px-4.5 py-2">
            {state.playbackStreams.length === 0 ? (
              <div className="subsection-desc" style={{ padding: "16px 0" }}>
                Nothing playing. Start a game, browser tab, or media player and
                it will appear here.
              </div>
            ) : (
              state.playbackStreams.map((s) => (
                <VolumeRow
                  key={s.id}
                  id={s.id}
                  label={s.label}
                  sublabel={s.mediaName !== s.label ? s.mediaName : null}
                  volume={s.volume}
                  muted={s.muted}
                  onVolume={handleVolume}
                  onMute={handleMute}
                />
              ))
            )}
          </div>
        </div>

        {/* INPUT DEVICES — collapsed by default */}
        {(state.sources.length > 0 || state.recordingStreams.length > 0) && (
          <div className="card">
            <div className="card-header flex items-center justify-between py-3.5 px-4.5 border-b border-base-300">
              <div className="card-title flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-base-content/50">
                <FaMicrophone className="w-3 h-3" /> INPUT
              </div>
              <Button onClick={() => setShowInputs((v) => !v)}>
                {showInputs ? "Hide" : "Show"}
              </Button>
            </div>
            {showInputs && (
              <div className="px-4.5 py-2">
                {state.sources.length > 0 && (
                  <div className="subsection">
                    <div className="subsection-label">Microphones</div>
                    {state.sources.map((src) => (
                      <VolumeRow
                        key={src.id}
                        id={src.id}
                        label={src.label}
                        sublabel={src.description}
                        volume={src.volume}
                        muted={src.muted}
                        isMicrophone
                        badge={src.isDefault ? "Default" : null}
                        onVolume={handleVolume}
                        onMute={handleMute}
                      />
                    ))}
                  </div>
                )}
                {state.recordingStreams.length > 0 && (
                  <div className="subsection">
                    <div className="subsection-label">
                      Recording Applications
                    </div>
                    {state.recordingStreams.map((s) => (
                      <VolumeRow
                        key={s.id}
                        id={s.id}
                        label={s.label}
                        sublabel={s.mediaName !== s.label ? s.mediaName : null}
                        volume={s.volume}
                        muted={s.muted}
                        isMicrophone
                        onVolume={handleVolume}
                        onMute={handleMute}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="card">
            <div className="card-body p-4.5">
              <div
                className="subsection-label mb-1.5"
                style={{ color: "var(--color-error)" }}
              >
                Error
              </div>
              <div className="text-sm">{error}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Homepage widget — quick master volume + mute toggle
// ---------------------------------------------------------------------------

function AudioMixerHomeWidget() {
  const { call, useEvent } = useBackend("audio-mixer");
  const currentGame = useCurrentGame();
  const [state, setState] = useState<MixerState | null>(null);
  const [error, setError] = useState(false);
  const [local, setLocal] = useState<number | null>(null);
  const [perGameEnabled, setPerGameEnabled] = useState(false);
  // While the user is holding a slider gesture, suppress incoming
  // mixerChanged updates so the live drag isn't yanked back to whatever
  // PipeWire most recently echoed.
  const interactingRef = useRef(false);
  const interactingClear = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    call("getMixerState")
      .then((s) => setState(s as MixerState))
      .catch(() => setError(true));
  }, [call]);

  useEffect(() => {
    let alive = true;
    call("getPerGameEnabled")
      .then((enabled) => {
        if (alive) setPerGameEnabled(Boolean(enabled));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [call]);

  useEvent({
    event: "mixerChanged",
    handler: (data) => setState(data as MixerState),
  });

  useEvent({
    event: "perGameEnabledChanged",
    handler: (data: unknown) => {
      const { enabled } = data as { enabled: boolean };
      setPerGameEnabled(enabled);
    },
  });

  const defaultSink = state?.sinks.find((s) => s.isDefault) ?? state?.sinks[0];
  const boundToGame = perGameEnabled && currentGame !== null;

  useEffect(() => {
    if (!interactingRef.current && defaultSink) {
      setLocal(defaultSink.volume);
    }
  }, [defaultSink]);

  useEffect(
    () => () => {
      if (interactingClear.current) clearTimeout(interactingClear.current);
    },
    [],
  );

  if (error || (state && !state.available)) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-center h-full">
          <span className="text-xs italic text-base-content/60">
            Audio mixer unavailable
          </span>
        </div>
      </div>
    );
  }

  if (!state || !defaultSink) {
    return (
      <div className="card-body">
        <div className="flex items-center justify-center h-full">
          <Spinner size={20} />
        </div>
      </div>
    );
  }

  const value = local ?? defaultSink.volume;
  const percent = Math.round(value * 100);
  const playing = state.playbackStreams.length;

  // Live drag: only update the local UI value. No backend writes — those
  // were causing a feedback loop where every micro-tick fired a PipeWire
  // update + a mixerChanged echo, and the resulting re-render storm was
  // dropping focus on the slider. Apply happens in handleCommit.
  const handleSlide = (v: number) => {
    setLocal(v);
    interactingRef.current = true;
    if (interactingClear.current) clearTimeout(interactingClear.current);
  };

  // Pointer-up / touch-end / key-up / blur or 600 ms idle (Slider's
  // built-in fallback) — flush the user's chosen value to PipeWire and,
  // if the per-game profile is bound, persist the new master volume.
  const handleCommit = (v: number) => {
    setLocal(v);
    call("setVolume", defaultSink.id, v).catch(() => {});
    if (boundToGame) {
      call(
        "setGameProfile",
        currentGame!.appId,
        currentGame!.gameName,
        {
          defaultSinkName: defaultSink.nodeName,
          masterVolume: v,
        },
      ).catch(() => {});
    }
    // Hold the suppression a beat longer than the commit so the resulting
    // mixerChanged echo doesn't snap us back to a stale draggingRef state.
    if (interactingClear.current) clearTimeout(interactingClear.current);
    interactingClear.current = setTimeout(() => {
      interactingRef.current = false;
    }, 200);
  };

  return (
    <div className="card-body">
      <div className="flex items-center justify-between mb-3.5">
        <div className="card-title">AUDIO</div>
        <div className="chip chip-accent truncate max-w-[60%]">
          {boundToGame
            ? `Saved · ${currentGame!.gameName || `App ${currentGame!.appId}`}`
            : `${playing} ${playing === 1 ? "stream" : "streams"}`}
        </div>
      </div>

      <div className="flex items-baseline gap-2 mb-4.5">
        <div className="metric-value mono">
          {defaultSink.muted ? "—" : percent}
        </div>
        <div className="metric-unit">{defaultSink.muted ? "muted" : "%"}</div>
        <div
          className="ml-auto mono text-[11px] text-base-content/50"
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 160,
          }}
        >
          {defaultSink.label}
        </div>
      </div>

      <Slider
        value={value}
        min={0}
        max={VOLUME_MAX}
        step={0.01}
        disabled={defaultSink.muted}
        onChange={handleSlide}
        onCommit={handleCommit}
      />

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button
          onClick={() =>
            call("setMute", defaultSink.id, "toggle").catch(() => {})
          }
        >
          {defaultSink.muted ? "Unmute" : "Mute"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Audio Mixer
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        PipeWire · Per-app volume + output routing
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mounts
// ---------------------------------------------------------------------------

export const mount = mountComponent(AudioMixer);
export const mountHomeWidget = mountComponent(AudioMixerHomeWidget);
export const mountHeader = mountComponent(Header);
