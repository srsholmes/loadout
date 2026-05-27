import { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { FaCompactDisc, FaPlay, FaPause, FaBackwardStep, FaForwardStep, FaStop, FaVolumeHigh, FaArrowsRotate, FaFolderOpen } from "react-icons/fa6";
import {
  Button,
  IconButton,
  PluginProvider,
  Slider,
  useBackend,
  useFocusable,
} from "@loadout/ui";

export { FaMusic as icon } from "react-icons/fa6";

interface PlaybackState {
  currentTrack: string | null;
  trackIndex: number;
  volume: number;
  paused: boolean;
  playing: boolean;
}

const homeDirFallback = "/var/home";

/** Strip extension for display. */
function trackDisplayName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.substring(0, dot) : filename;
}

/** Extract uppercase extension label. */
function trackExt(filename: string): string {
  return filename.substring(filename.lastIndexOf(".") + 1).toUpperCase();
}

function MusicPlayer() {
  const { call, useEvent } = useBackend("music-player");

  const [tracks, setTracks] = useState<string[]>([]);
  const [status, setStatus] = useState<PlaybackState>({
    currentTrack: null,
    trackIndex: -1,
    volume: 80,
    paused: false,
    playing: false,
  });
  const [musicDir, setMusicDir] = useState("");
  const [dirSaving, setDirSaving] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [browserDirs, setBrowserDirs] = useState<string[]>([]);
  const [browserParent, setBrowserParent] = useState<string | null>(null);

  // Subscribe to real-time playback updates
  useEvent({
    event: "playbackUpdate",
    handler: (data) => setStatus(data as PlaybackState),
  });

  // Load tracks, status, and music dir on mount
  useEffect(() => {
    call("getTracks").then((t) => setTracks(t as string[]));
    call("getStatus").then((s) => setStatus(s as PlaybackState));
    call("getMusicDir").then((d) => {
      setMusicDir(d as string);
    });
  }, [call]);

  const handlePlay = useCallback(
    (filename: string) => call("play", filename),
    [call],
  );
  const handlePause = useCallback(() => call("pause"), [call]);
  const handleResume = useCallback(() => call("resume"), [call]);
  const handleStop = useCallback(() => call("stop"), [call]);
  const handleNext = useCallback(() => call("next"), [call]);
  const handlePrevious = useCallback(() => call("previous"), [call]);
  const handleVolume = useCallback(
    (percent: number) => call("setVolume", percent),
    [call],
  );
  const handleRefresh = useCallback(async () => {
    const t = await call("getTracks");
    setTracks(t as string[]);
  }, [call]);
  const browseTo = useCallback(async (path: string) => {
    const result = await call("listDirectories", path) as { path: string; parent: string | null; dirs: string[] };
    setBrowserPath(result.path);
    setBrowserDirs(result.dirs);
    setBrowserParent(result.parent);
  }, [call]);

  const handleOpenBrowser = useCallback(async () => {
    await browseTo(musicDir || homeDirFallback);
    setBrowserOpen(true);
  }, [browseTo, musicDir]);

  const handleSelectFolder = useCallback(async () => {
    if (browserPath === musicDir) {
      setBrowserOpen(false);
      return;
    }
    setDirSaving(true);
    try {
      await call("setMusicDir", browserPath);
      setMusicDir(browserPath);
      const t = await call("getTracks");
      setTracks(t as string[]);
      setBrowserOpen(false);
    } finally {
      setDirSaving(false);
    }
  }, [call, browserPath, musicDir]);

  // Main play button: if something is playing, toggle pause/resume; otherwise start the first track.
  const handleMainPlayButton = useCallback(() => {
    if (status.playing && !status.paused) {
      handlePause();
    } else if (status.playing && status.paused) {
      handleResume();
    } else if (tracks.length > 0) {
      handlePlay(tracks[0]);
    }
  }, [status.playing, status.paused, tracks, handlePause, handleResume, handlePlay]);

  const active = status.currentTrack;
  const activeIndex = status.trackIndex;
  const hasTracks = tracks.length > 0;
  const isPlayingNotPaused = status.playing && !status.paused;

  // Heuristic "artist" label — filename is all we have.
  const heroTitle = active ? trackDisplayName(active) : (hasTracks ? "Nothing playing" : "No music found");
  const heroSubtitle = active ? trackExt(active) + " file" : (hasTracks ? `${tracks.length} track${tracks.length !== 1 ? "s" : ""} in library` : "Add audio files to your music folder");
  const chipLabel = active
    ? (status.paused ? "PAUSED · Local" : "NOW PLAYING · Local")
    : "LIBRARY · Local";

  return (
    <div className="p-7 h-full overflow-y-auto">
      <div className="page-content">
        {/* HERO CARD — now-playing + queue */}
        <div className="card">
          {/* Now playing hero */}
          <div className="subsection" style={{ padding: "24px" }}>
            <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
              <div style={{
                width: 100, height: 100, borderRadius: 14,
                background: "linear-gradient(135deg, oklch(0.5 0.18 295), oklch(0.35 0.16 250))",
                boxShadow: "var(--shadow-md)", flexShrink: 0,
                display: "grid", placeItems: "center",
                color: "white",
              }}>
                <FaCompactDisc size={42} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="chip" style={{ fontSize: 10, marginBottom: 8 }}>{chipLabel}</div>
                <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {heroTitle}
                </div>
                <div style={{ fontSize: 13, color: "var(--fg-2)", marginTop: 2 }}>
                  {heroSubtitle}
                </div>

                {/* Progress indicator (position is not wired from mpv yet; show active/total as index marker) */}
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", width: 36 }}>
                    {active && hasTracks ? String(activeIndex + 1).padStart(2, "0") : "--"}
                  </span>
                  <div style={{ flex: 1, height: 4, background: "var(--bg-inset)", borderRadius: 2, position: "relative" }}>
                    {active && hasTracks && (
                      <>
                        <div style={{
                          position: "absolute", inset: 0,
                          width: `${((activeIndex + 1) / tracks.length) * 100}%`,
                          background: "var(--accent)", borderRadius: 2,
                        }} />
                        <div style={{
                          position: "absolute",
                          left: `${((activeIndex + 1) / tracks.length) * 100}%`,
                          top: "50%", transform: "translate(-50%, -50%)",
                          width: 10, height: 10, borderRadius: 5, background: "var(--accent)",
                        }} />
                      </>
                    )}
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", width: 36, textAlign: "right" }}>
                    {hasTracks ? String(tracks.length).padStart(2, "0") : "--"}
                  </span>
                </div>

                {/* Transport + volume row */}
                <div style={{ display: "flex", gap: 6, marginTop: 14, alignItems: "center" }}>
                  <IconButton
                    onClick={handlePrevious}
                    disabled={!hasTracks}
                    title="Previous"
                    ariaLabel="Previous"
                    className="bg-transparent border-transparent"
                  >
                    <FaBackwardStep size={14} />
                  </IconButton>
                  <IconButton
                    onClick={handleMainPlayButton}
                    disabled={!hasTracks}
                    title={isPlayingNotPaused ? "Pause" : "Play"}
                    ariaLabel={isPlayingNotPaused ? "Pause" : "Play"}
                    variant="accent"
                    size={40}
                    style={{
                      background: "var(--accent)",
                      color: "var(--on-accent)",
                    }}
                  >
                    {isPlayingNotPaused ? <FaPause size={14} /> : <FaPlay size={14} />}
                  </IconButton>
                  <IconButton
                    onClick={handleNext}
                    disabled={!hasTracks}
                    title="Next"
                    ariaLabel="Next"
                    className="bg-transparent border-transparent"
                  >
                    <FaForwardStep size={14} />
                  </IconButton>
                  <IconButton
                    onClick={handleStop}
                    disabled={!status.playing}
                    title="Stop"
                    ariaLabel="Stop"
                    className="bg-transparent border-transparent"
                  >
                    <FaStop size={14} />
                  </IconButton>
                  <div style={{ flex: 1 }} />
                  <FaVolumeHigh size={14} style={{ color: "var(--fg-2)" }} />
                  <div style={{ width: 80 }}>
                    <Slider
                      min={0}
                      max={100}
                      value={status.volume}
                      onChange={handleVolume}
                    />
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", width: 30, textAlign: "right" }}>
                    {status.volume}%
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Queue */}
          <div className="subsection">
            <div className="subsection-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>Queue</span>
              <IconButton
                onClick={handleRefresh}
                title="Rescan library"
                ariaLabel="Rescan library"
                className="bg-transparent border-transparent"
              >
                <FaArrowsRotate size={11} />
              </IconButton>
            </div>
            {!hasTracks ? (
              <div style={{
                padding: 14, background: "var(--bg-inset)", borderRadius: 10,
                fontSize: 13, color: "var(--fg-3)", textAlign: "center",
              }}>
                No audio files found. Add .mp3, .ogg, .wav, or .flac files to your music folder.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 2 }}>
                {tracks.map((track, i) => (
                  <TrackRow
                    key={track}
                    track={track}
                    index={i}
                    isActive={active === track}
                    statusPlaying={status.playing}
                    statusPaused={status.paused}
                    onPlay={() => handlePlay(track)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Music folder */}
          <div className="subsection">
            <div className="subsection-label">Music folder</div>
            <div className="row">
              <span className="row-label">Path</span>
              <span className="row-value mono" style={{
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                maxWidth: "60%",
              }}>
                {musicDir || "Not set"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <Button onClick={handleOpenBrowser}>
                <FaFolderOpen size={12} /> Change folder
              </Button>
            </div>

            {browserOpen && (
              <div style={{
                marginTop: 12,
                border: "1px solid var(--line)",
                borderRadius: 10,
                overflow: "hidden",
                background: "var(--bg-inset)",
              }}>
                <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>
                  <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>
                    {browserPath}
                  </span>
                </div>
                <div style={{ maxHeight: 200, overflowY: "auto", padding: "4px 0" }}>
                  {browserParent !== null && (
                    <BrowserUpRow onClick={() => browseTo(browserParent!)} />
                  )}
                  {browserDirs.map((dir) => (
                    <BrowserDirRow
                      key={dir}
                      label={dir}
                      onClick={() => browseTo(browserPath + "/" + dir)}
                    />
                  ))}
                  {browserDirs.length === 0 && (
                    <div style={{ padding: "10px 14px", fontSize: 12, color: "var(--fg-3)", textAlign: "center" }}>
                      No subfolders
                    </div>
                  )}
                </div>
                <div style={{
                  display: "flex", gap: 6, padding: "10px 12px",
                  borderTop: "1px solid var(--line)", justifyContent: "flex-end",
                }}>
                  <Button onClick={() => setBrowserOpen(false)}>Cancel</Button>
                  <Button
                    variant="primary"
                    onClick={handleSelectFolder}
                    disabled={dirSaving}
                  >
                    {dirSaving ? "Saving…" : "Select this folder"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Mount this plugin into a container element.
 * Called by the overlay shell when this plugin is selected.
 * Returns an unmount function.
 */
/** Track row in the queue — wrapped with `useFocusable` for d-pad nav. */
function TrackRow({
  track,
  index,
  isActive,
  statusPlaying,
  statusPaused,
  onPlay,
}: {
  track: string;
  index: number;
  isActive: boolean;
  statusPlaying: boolean;
  statusPaused: boolean;
  onPlay: () => void;
}) {
  const { ref, focused } = useFocusable({ onEnterPress: onPlay });
  return (
    <button
      ref={ref}
      onClick={onPlay}
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 12px",
        background: isActive
          ? "var(--accent-soft)"
          : focused ? "var(--bg-inset)" : "transparent",
        borderRadius: 8,
        border: focused ? "1px solid var(--accent)" : "1px solid transparent",
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
        color: "inherit",
        transform: focused ? "scale(1.01)" : "scale(1)",
        transition: "all 100ms ease",
      }}
    >
      <span className="mono" style={{ fontSize: 11, color: "var(--fg-3)", width: 22 }}>
        {String(index + 1).padStart(2, "0")}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          fontWeight: isActive ? 600 : 500,
          color: isActive ? "var(--accent)" : "var(--fg-1)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {trackDisplayName(track)}
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-3)" }}>{trackExt(track)}</div>
      </div>
      <span className="mono" style={{ fontSize: 11.5, color: "var(--fg-3)" }}>
        {isActive && statusPlaying
          ? (statusPaused ? "PAUSED" : "PLAYING")
          : "—"}
      </span>
    </button>
  );
}

/** Folder-browser ".." up row — wrapped with `useFocusable`. */
function BrowserUpRow({ onClick }: { onClick: () => void }) {
  const { ref, focused } = useFocusable({ onEnterPress: onClick });
  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        width: "100%", padding: "8px 14px",
        background: focused ? "var(--bg-2)" : "transparent",
        border: focused ? "1px solid var(--accent)" : "1px solid transparent",
        color: "var(--fg-1)", fontSize: 13, cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span>..</span>
      <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-3)" }}>UP</span>
    </button>
  );
}

/** Folder-browser directory row — wrapped with `useFocusable`. */
function BrowserDirRow({ label, onClick }: { label: string; onClick: () => void }) {
  const { ref, focused } = useFocusable({ onEnterPress: onClick });
  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center",
        width: "100%", padding: "8px 14px",
        background: focused ? "var(--bg-2)" : "transparent",
        border: focused ? "1px solid var(--accent)" : "1px solid transparent",
        color: "var(--fg-1)", fontSize: 13, cursor: "pointer",
        textAlign: "left",
      }}
    >
      {label}
    </button>
  );
}

export function mount(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <MusicPlayer />
    </PluginProvider>
  );
  return () => root.unmount();
}

function Header() {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <h1 className="text-xl font-semibold tracking-[-0.015em] m-0 leading-tight">
        Music Player
      </h1>
      <span className="text-[11.5px] text-base-content/55 tracking-[0.02em] truncate leading-tight">
        Local library playback
      </span>
    </div>
  );
}

export function mountHeader(
  container: HTMLElement,
  opts?: { parentFocusKey?: string },
): () => void {
  const root = createRoot(container);
  root.render(
    <PluginProvider parentFocusKey={opts?.parentFocusKey}>
      <Header />
    </PluginProvider>,
  );
  return () => root.unmount();
}
