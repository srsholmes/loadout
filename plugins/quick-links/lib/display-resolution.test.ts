import { describe, it, expect, mock, beforeEach } from "bun:test";

// fs/promises stubs must precede the import-under-test.
const mockReadFile = mock<(path: string, encoding?: string) => Promise<string>>(
  () => Promise.resolve(""),
);
const mockReaddir = mock<(path: string) => Promise<string[]>>(() =>
  Promise.resolve([]),
);
mock.module("fs/promises", () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
}));

const { detectDisplayResolution, FALLBACK_RESOLUTION } = await import(
  "./display-resolution"
);

beforeEach(() => {
  mockReadFile.mockReset();
  mockReaddir.mockReset();
});

describe("detectDisplayResolution", () => {
  it("returns FALLBACK when /sys/class/drm is unreadable", async () => {
    mockReaddir.mockImplementation(() =>
      Promise.reject(new Error("ENOENT")),
    );
    const res = await detectDisplayResolution();
    expect(res).toEqual(FALLBACK_RESOLUTION);
  });

  it("returns the first connected output's preferred mode", async () => {
    mockReaddir.mockImplementation(() =>
      Promise.resolve(["card1", "card1-eDP-1", "card1-HDMI-A-1"]),
    );
    mockReadFile.mockImplementation((path) => {
      const p = typeof path === "string" ? path : "";
      if (p.endsWith("/status")) return Promise.resolve("connected\n");
      if (p.endsWith("/modes"))
        return Promise.resolve("2560x1600\n1920x1200\n");
      return Promise.resolve("");
    });
    const res = await detectDisplayResolution();
    expect(res).toEqual({ width: 2560, height: 1600 });
  });

  it("skips disconnected outputs and probes the next one", async () => {
    mockReaddir.mockImplementation(() =>
      Promise.resolve(["card1-eDP-1", "card1-HDMI-A-1"]),
    );
    mockReadFile.mockImplementation((path) => {
      const p = typeof path === "string" ? path : "";
      if (p.includes("eDP-1/status"))
        return Promise.resolve("disconnected\n");
      if (p.includes("HDMI-A-1/status")) return Promise.resolve("connected\n");
      if (p.includes("HDMI-A-1/modes"))
        return Promise.resolve("3840x2160\n1920x1080\n");
      return Promise.resolve("");
    });
    const res = await detectDisplayResolution();
    expect(res).toEqual({ width: 3840, height: 2160 });
  });

  it("filters out Writeback pseudo-outputs", async () => {
    mockReaddir.mockImplementation(() =>
      Promise.resolve(["card1-Writeback-1", "card1-eDP-1"]),
    );
    mockReadFile.mockImplementation((path) => {
      const p = typeof path === "string" ? path : "";
      if (p.includes("eDP-1/status")) return Promise.resolve("connected\n");
      if (p.includes("eDP-1/modes")) return Promise.resolve("1920x1080\n");
      // Writeback outputs would falsely report connected with garbage
      // modes — assert the helper never reaches readFile for them.
      throw new Error(`should not read writeback path: ${p}`);
    });
    const res = await detectDisplayResolution();
    expect(res).toEqual({ width: 1920, height: 1080 });
  });

  it("falls back to 1920x1080 when no output is connected", async () => {
    mockReaddir.mockImplementation(() =>
      Promise.resolve(["card1-eDP-1"]),
    );
    mockReadFile.mockImplementation((path) => {
      const p = typeof path === "string" ? path : "";
      if (p.endsWith("/status")) return Promise.resolve("disconnected\n");
      return Promise.resolve("");
    });
    const res = await detectDisplayResolution();
    expect(res).toEqual(FALLBACK_RESOLUTION);
  });

  it("falls back to 1920x1080 when modes file is unparseable", async () => {
    mockReaddir.mockImplementation(() =>
      Promise.resolve(["card1-eDP-1"]),
    );
    mockReadFile.mockImplementation((path) => {
      const p = typeof path === "string" ? path : "";
      if (p.endsWith("/status")) return Promise.resolve("connected\n");
      if (p.endsWith("/modes")) return Promise.resolve("");
      return Promise.resolve("");
    });
    const res = await detectDisplayResolution();
    expect(res).toEqual(FALLBACK_RESOLUTION);
  });
});
