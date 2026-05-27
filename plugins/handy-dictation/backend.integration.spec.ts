/**
 * Integration tests for the handy-dictation plugin (Handy wrapper).
 *
 * These tests exercise the REAL Handy AppImage that the install flow
 * downloads into ~/.local/share/loadout/handy-dictation/bin.
 * Skip if it's missing (CI without the AppImage).
 *
 * Run: bun test plugins/handy-dictation/backend.integration.spec.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { homedir } from "os";
import { join } from "path";
import type { EmitPayload } from "@loadout/types";
import HandyDictationBackend from "./backend";

const APPIMAGE_PATH = join(
  homedir(),
  ".local/share/loadout/handy-dictation/bin/Handy.AppImage",
);

const hasAppImage = await Bun.file(APPIMAGE_PATH).exists();

describe.skipIf(!hasAppImage)("handy-dictation integration", () => {
  let backend: HandyDictationBackend;
  let events: EmitPayload[];

  beforeAll(async () => {
    backend = new HandyDictationBackend();
    events = [];
    backend.emit = (payload: EmitPayload) => events.push(payload);
    await backend.onLoad();
  });

  afterAll(async () => {
    await backend.onUnload();
  });

  it("detects the installed Handy AppImage", async () => {
    const status = await backend.getStatus();
    expect(status.installed).toBe(true);
    expect(status.appImagePath).not.toBeNull();
  });

  it("reports running state after starting Handy", async () => {
    const started = await backend.startHandy();
    expect(started.success).toBe(true);

    const status = await backend.getStatus();
    expect(status.running).toBe(true);

    const stopped = await backend.stopHandy();
    expect(stopped.success).toBe(true);

    const statusAfter = await backend.getStatus();
    expect(statusAfter.running).toBe(false);
  }, 30000);

  it("reports error when starting Handy twice", async () => {
    const start1 = await backend.startHandy();
    expect(start1.success).toBe(true);

    const start2 = await backend.startHandy();
    expect(start2.success).toBe(false);
    expect(start2.error).toContain("already running");

    await backend.stopHandy();
  }, 30000);
});
