import type { PluginBackend, EmitPayload } from "@loadout/types";
import { spawn } from "@loadout/exec";
import { readdir, mkdir, unlink, readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";

const AUDIO_EXTENSIONS = new Set([".mp3", ".ogg", ".wav", ".flac"]);
const DEFAULT_MUSIC_DIR = join(homedir(), ".config", "loadout", "music");
const PREFS_DIR = join(homedir(), ".config", "loadout", "music-player");
const PREFS_FILE = join(PREFS_DIR, "preferences.json");

interface Preferences {
  musicDir: string;
}

interface PlaybackState {
  currentTrack: string | null;
  trackIndex: number;
  volume: number;
  paused: boolean;
  playing: boolean;
}

/**
 * Music Player plugin backend.
 *
 * Plays audio files from ~/.config/loadout/music/ using mpv.
 * Exposes RPC methods for playback control and emits playbackUpdate events.
 */
export default class MusicPlayerBackend implements PluginBackend {
  emit?: (payload: EmitPayload) => void;

  private state: PlaybackState = {
    currentTrack: null,
    trackIndex: -1,
    volume: 80,
    paused: false,
    playing: false,
  };

  private tracks: string[] = [];
  private mpvProcess: ReturnType<typeof spawn> | null = null;
  private mpvSocket: string = "";
  private musicDir: string = DEFAULT_MUSIC_DIR;

  async onLoad(): Promise<void> {
    console.log("[music-player] Plugin loaded");

    // Load saved preferences (music directory)
    await this.loadPreferences();

    // Ensure the music directory exists
    await mkdir(this.musicDir, { recursive: true });

    // Generate a unique IPC socket path for mpv
    this.mpvSocket = `/tmp/loadout-mpv-${process.pid}.sock`;

    // Scan for tracks on startup
    await this.scanTracks();
  }

  async onUnload(): Promise<void> {
    await this.killMpv();
    console.log("[music-player] Plugin unloaded");
  }

  // ── RPC Methods ──────────────────────────────────────────────

  /** Return the current music directory path. */
  async getMusicDir(): Promise<string> {
    return this.musicDir;
  }

  /** Set the music directory path, save to preferences, and rescan. */
  async setMusicDir(dir: string): Promise<void> {
    const resolved = dir.replace(/^~/, homedir());
    await mkdir(resolved, { recursive: true });
    this.musicDir = resolved;
    await this.savePreferences();
    await this.stop();
    await this.scanTracks();
    this.emitUpdate();
  }

  /** List subdirectories at the given path for the folder browser. */
  async listDirectories(path: string): Promise<{ path: string; parent: string | null; dirs: string[] }> {
    const resolved = path.replace(/^~/, homedir());
    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      const parent = resolved === "/" ? null : dirname(resolved);
      return { path: resolved, parent, dirs };
    } catch {
      return { path: resolved, parent: dirname(resolved), dirs: [] };
    }
  }

  /** Scan the music directory and return available tracks. */
  async getTracks(): Promise<string[]> {
    await this.scanTracks();
    return this.tracks;
  }

  /** Return current playback status. */
  async getStatus(): Promise<PlaybackState> {
    return { ...this.state };
  }

  /** Start playing a specific track by filename. */
  async play(filename: string): Promise<void> {
    const index = this.tracks.indexOf(filename);
    if (index === -1) {
      throw new Error(`Track not found: ${filename}`);
    }

    await this.killMpv();

    // Audit F-020: mpv bails with `Could not bind IPC socket: Address
    // already in use` if `--input-ipc-server=<path>` points at a stale
    // socket file. killMpv() unlinks ours, but a previous mpv crash
    // (segfault / SIGKILL / OOM) leaves the file behind without our
    // killMpv ever running. Unlink defensively right before spawn so
    // the new mpv can bind cleanly.
    try {
      await unlink(this.mpvSocket);
    } catch {
      // ENOENT is the steady-state — nothing to clean up.
    }

    const filePath = join(this.musicDir, filename);
    // Capture the just-spawned proc reference. When the user rapidly skips
    // tracks, an earlier proc's onExit can fire AFTER a later play() has
    // already replaced this.mpvProcess — checking proc identity inside the
    // callback prevents clobbering the newer track's state (F-003).
    const proc = spawn(
      [
        "mpv",
        "--no-video",
        "--really-quiet",
        `--input-ipc-server=${this.mpvSocket}`,
        `--volume=${this.state.volume}`,
        filePath,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        onExit: () => {
          // Stale-callback guard: ignore exit events from procs that have
          // already been replaced by a newer play() call.
          if (this.mpvProcess !== proc) return;
          // Playback ended naturally
          if (this.state.playing && !this.state.paused) {
            this.state.playing = false;
            this.state.currentTrack = null;
            this.state.trackIndex = -1;
            this.emitUpdate();
          }
        },
      },
    );
    this.mpvProcess = proc;

    this.state.currentTrack = filename;
    this.state.trackIndex = index;
    this.state.playing = true;
    this.state.paused = false;
    this.emitUpdate();
  }

  /** Pause the currently playing track. */
  async pause(): Promise<void> {
    if (!this.state.playing || this.state.paused) return;
    await this.mpvCommand(["set_property", "pause", true]);
    this.state.paused = true;
    this.emitUpdate();
  }

  /** Resume the currently paused track. */
  async resume(): Promise<void> {
    if (!this.state.playing || !this.state.paused) return;
    await this.mpvCommand(["set_property", "pause", false]);
    this.state.paused = false;
    this.emitUpdate();
  }

  /** Stop playback entirely. */
  async stop(): Promise<void> {
    await this.killMpv();
    this.state.playing = false;
    this.state.paused = false;
    this.state.currentTrack = null;
    this.state.trackIndex = -1;
    this.emitUpdate();
  }

  /** Set volume (0-100). */
  async setVolume(percent: number): Promise<void> {
    this.state.volume = Math.max(0, Math.min(100, Math.round(percent)));
    if (this.state.playing) {
      await this.mpvCommand(["set_property", "volume", this.state.volume]);
    }
    this.emitUpdate();
  }

  /** Skip to the next track. */
  async next(): Promise<void> {
    if (this.tracks.length === 0) return;
    const nextIndex = (this.state.trackIndex + 1) % this.tracks.length;
    await this.play(this.tracks[nextIndex]);
  }

  /** Go to the previous track. */
  async previous(): Promise<void> {
    if (this.tracks.length === 0) return;
    const prevIndex =
      this.state.trackIndex <= 0
        ? this.tracks.length - 1
        : this.state.trackIndex - 1;
    await this.play(this.tracks[prevIndex]);
  }

  // ── Internal Helpers ─────────────────────────────────────────

  private async scanTracks(): Promise<void> {
    try {
      const entries = await readdir(this.musicDir);
      this.tracks = entries
        .filter((f) => {
          const ext = f.substring(f.lastIndexOf(".")).toLowerCase();
          return AUDIO_EXTENSIONS.has(ext);
        })
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    } catch {
      this.tracks = [];
    }
  }

  private async mpvCommand(command: unknown[]): Promise<void> {
    try {
      const payload = JSON.stringify({ command }) + "\n";
      await Bun.connect({
        unix: this.mpvSocket,
        socket: {
          data() {},
          open(socket) {
            socket.write(payload);
            socket.end();
          },
          error() {},
          close() {},
        },
      });
    } catch {
      // mpv IPC not available — ignore silently
    }
  }

  private async killMpv(): Promise<void> {
    if (this.mpvProcess) {
      try {
        this.mpvProcess.kill();
      } catch {
        // already dead
      }
      this.mpvProcess = null;
    }
    // Clean up socket file
    try {
      await unlink(this.mpvSocket);
    } catch {
      // doesn't exist
    }
  }

  private async loadPreferences(): Promise<void> {
    try {
      const raw = await readFile(PREFS_FILE, "utf-8");
      const prefs: Preferences = JSON.parse(raw);
      if (prefs.musicDir) {
        this.musicDir = prefs.musicDir;
      }
    } catch {
      // No preferences file yet — use default
    }
  }

  private async savePreferences(): Promise<void> {
    const prefs: Preferences = { musicDir: this.musicDir };
    await mkdir(PREFS_DIR, { recursive: true });
    await writeFile(PREFS_FILE, JSON.stringify(prefs, null, 2));
  }

  private emitUpdate(): void {
    this.emit?.({
      event: "playbackUpdate",
      data: { ...this.state },
    });
  }
}
