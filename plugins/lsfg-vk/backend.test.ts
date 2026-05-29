import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  spyOn,
} from "bun:test";
import type { EmitPayload } from "@loadout/types";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import LsfgVkBackend from "./backend";

// The backend hard-codes paths from homedir(). For tests we redirect
// HOME and XDG_CONFIG_HOME to a tmpdir so plugin-storage's
// loadoutConfigDir() lands in our sandbox too. Then every write the
// backend issues stays inside the dir we clean up in afterEach.

let sandboxHome: string;
const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;

describe("LsfgVkBackend", () => {
  let backend: LsfgVkBackend;
  let emitted: EmitPayload[];

  beforeEach(async () => {
    sandboxHome = await mkdtemp(join(tmpdir(), "lsfg-vk-test-"));
    process.env.HOME = sandboxHome;
    process.env.XDG_CONFIG_HOME = join(sandboxHome, ".config");
    backend = new LsfgVkBackend();
    emitted = [];
    backend.emit = (payload: EmitPayload) => {
      emitted.push(payload);
    };
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(sandboxHome, { recursive: true, force: true });
  });

  // ── Defaults ────────────────────────────────────────────────────

  describe("getSettings", () => {
    it("returns the documented defaults before any change", async () => {
      const s = await backend.getSettings();
      expect(s).toEqual({
        multiplier: 2,
        flow_scale: 0.8,
        performance_mode: false,
        hdr_mode: false,
        experimental_present_mode: "fifo",
        verbose_logging: false,
      });
    });

    it("returns a copy, not a reference", async () => {
      const s1 = await backend.getSettings();
      s1.multiplier = 99;
      const s2 = await backend.getSettings();
      expect(s2.multiplier).toBe(2);
    });
  });

  // ── updateSettings ──────────────────────────────────────────────

  describe("updateSettings", () => {
    it("merges partial updates", async () => {
      await backend.updateSettings({ multiplier: 4, hdr_mode: true });
      const s = await backend.getSettings();
      expect(s.multiplier).toBe(4);
      expect(s.hdr_mode).toBe(true);
      expect(s.flow_scale).toBe(0.8);
    });

    it("emits settingsChanged", async () => {
      await backend.updateSettings({ performance_mode: true });
      const evt = emitted.find((e) => e.event === "settingsChanged");
      expect(evt).toBeDefined();
      expect((evt!.data as { performance_mode: boolean }).performance_mode).toBe(
        true,
      );
    });

    it("persists settings via @loadout/plugin-storage", async () => {
      await backend.updateSettings({ multiplier: 4 });
      // Pull a fresh backend; onLoad() should read the persisted store.
      const fresh = new LsfgVkBackend();
      await fresh.onLoad();
      const s = await fresh.getSettings();
      expect(s.multiplier).toBe(4);
    });
  });

  // ── getStatus ───────────────────────────────────────────────────

  describe("getStatus", () => {
    it("reports not installed when layer files are missing", async () => {
      const status = await backend.getStatus();
      expect(status.install.installed).toBe(false);
      expect(status.install.layerSoExists).toBe(false);
      expect(status.install.layerJsonExists).toBe(false);
      expect(status.install.wrapperExists).toBe(false);
    });

    it("reports installed when all three artifacts exist", async () => {
      // Lay down stubs at the install-target paths.
      await mkdir(join(sandboxHome, ".local/lib"), { recursive: true });
      await mkdir(join(sandboxHome, ".local/share/vulkan/implicit_layer.d"), {
        recursive: true,
      });
      await writeFile(
        join(sandboxHome, ".local/lib/liblsfg-vk.so"),
        "stub",
      );
      await writeFile(
        join(
          sandboxHome,
          ".local/share/vulkan/implicit_layer.d/VkLayer_LS_frame_generation.json",
        ),
        "{}",
      );
      await writeFile(join(sandboxHome, "lsfg"), "#!/bin/bash\n");

      const status = await backend.getStatus();
      expect(status.install.installed).toBe(true);
      expect(status.install.layerSoExists).toBe(true);
      expect(status.install.layerJsonExists).toBe(true);
      expect(status.install.wrapperExists).toBe(true);
    });

    it("includes ~/lsfg %command% as launchOptions", async () => {
      const status = await backend.getStatus();
      expect(status.launchOptions).toBe("~/lsfg %command%");
    });

    it("exposes wrapperToken alongside the absolute wrapperPath", async () => {
      const status = await backend.getStatus();
      expect(status.install.wrapperToken).toBe("~/lsfg");
      expect(status.install.wrapperPath).toBe(`${sandboxHome}/lsfg`);
    });
  });

  // ── DLL detection ───────────────────────────────────────────────

  describe("DLL detection", () => {
    it("detects Lossless.dll at the default Steam path", async () => {
      const dllDir = join(
        sandboxHome,
        ".local/share/Steam/steamapps/common/Lossless Scaling",
      );
      await mkdir(dllDir, { recursive: true });
      await writeFile(join(dllDir, "Lossless.dll"), "PE...");

      const status = await backend.getStatus();
      expect(status.dll.found).toBe(true);
      expect(status.dll.isCustom).toBe(false);
      expect(status.dll.path).toContain("Lossless.dll");
    });

    it("setCustomDllPath overrides detection", async () => {
      const customPath = join(sandboxHome, "custom/Lossless.dll");
      await mkdir(join(sandboxHome, "custom"), { recursive: true });
      await writeFile(customPath, "PE...");

      const status = await backend.setCustomDllPath(customPath);
      expect(status.found).toBe(true);
      expect(status.isCustom).toBe(true);
      expect(status.path).toBe(customPath);
    });

    it("clearCustomDllPath falls back to default detection", async () => {
      await backend.setCustomDllPath("/does/not/exist/Lossless.dll");
      const cleared = await backend.clearCustomDllPath();
      expect(cleared.isCustom).toBe(false);
    });
  });

  // ── TOML rendering (integration: writes a real file) ────────────

  describe("TOML output", () => {
    it("writes a valid conf.toml after settings change", async () => {
      await backend.updateSettings({
        multiplier: 3,
        flow_scale: 0.7,
        performance_mode: true,
        hdr_mode: false,
        experimental_present_mode: "mailbox",
      });
      // updateSettings only writes the TOML when the .so exists; call
      // the private writer directly here.
      await (
        backend as unknown as { _writeTomlConfig: () => Promise<void> }
      )._writeTomlConfig();

      const toml = await readFile(
        join(sandboxHome, ".config/lsfg-vk/conf.toml"),
        "utf8",
      );
      expect(toml).toContain('current_profile = "steam-loader-lsfg-vk"');
      expect(toml).toContain('exe = "steam-loader-lsfg-vk"');
      expect(toml).toContain("multiplier = 3");
      expect(toml).toContain("flow_scale = 0.7");
      expect(toml).toContain("performance_mode = true");
      expect(toml).toContain("hdr_mode = false");
      expect(toml).toContain('experimental_present_mode = "mailbox"');
    });
  });

  // ── Wrapper script (integration: writes a real file + chmod) ────

  describe("wrapper script", () => {
    it("writes ~/lsfg with shebang, LSFG_PROCESS export, and exec $@", async () => {
      await (
        backend as unknown as { _writeWrapperScript: () => Promise<void> }
      )._writeWrapperScript();

      const script = await readFile(join(sandboxHome, "lsfg"), "utf8");
      expect(script.startsWith("#!/bin/bash")).toBe(true);
      expect(script).toContain("export LSFG_PROCESS=steam-loader-lsfg-vk");
      expect(script).toContain('exec "$@"');
    });

    it("makes the wrapper executable (0o755)", async () => {
      await (
        backend as unknown as { _writeWrapperScript: () => Promise<void> }
      )._writeWrapperScript();
      const { stat } = await import("node:fs/promises");
      const s = await stat(join(sandboxHome, "lsfg"));
      // Owner exec bit set.
      expect(s.mode & 0o100).toBe(0o100);
    });

    it("multiplier=0 omits LSFG_PROCESS export and clamps TOML to 2", async () => {
      await backend.updateSettings({ multiplier: 0 });
      await (
        backend as unknown as { _writeWrapperScript: () => Promise<void> }
      )._writeWrapperScript();
      await (
        backend as unknown as { _writeTomlConfig: () => Promise<void> }
      )._writeTomlConfig();

      const script = await readFile(join(sandboxHome, "lsfg"), "utf8");
      expect(script).not.toContain("LSFG_PROCESS");
      expect(script).toContain('exec "$@"');

      const toml = await readFile(
        join(sandboxHome, ".config/lsfg-vk/conf.toml"),
        "utf8",
      );
      expect(toml).toContain("multiplier = 2");
    });
  });

  // ── getLaunchOptionsString ──────────────────────────────────────

  describe("getLaunchOptionsString", () => {
    it("returns the wrapper invocation for Steam", async () => {
      const launch = await backend.getLaunchOptionsString();
      expect(launch).toBe("~/lsfg %command%");
    });
  });

  // ── Install error path ──────────────────────────────────────────

  describe("install (error path only — happy path requires network)", () => {
    it("returns success=false with a message when the GitHub API errors", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        () =>
          Promise.resolve(
            new Response("nope", { status: 503, statusText: "boom" }),
          ),
      );
      try {
        const res = await backend.install();
        expect(res.success).toBe(false);
        expect(res.error).toContain("503");
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
