import { describe, it, expect } from "bun:test";
import {
  renderTomlConfig,
  renderWrapperScript,
  tomlString,
} from "./render-config";
import { DEFAULTS } from "./constants";
import type { LsfgSettings } from "./types";

describe("tomlString", () => {
  it("wraps plain values in basic-string quotes", () => {
    expect(tomlString("/home/u/foo.dll")).toBe('"/home/u/foo.dll"');
  });

  it("escapes backslashes", () => {
    expect(tomlString("C:\\Games\\foo.dll")).toBe(
      '"C:\\\\Games\\\\foo.dll"',
    );
  });

  it("escapes double quotes", () => {
    expect(tomlString('has "quote"')).toBe('"has \\"quote\\""');
  });
});

describe("renderTomlConfig", () => {
  const dll = "/home/u/.local/share/Steam/steamapps/common/Lossless Scaling/Lossless.dll";

  it("renders default settings into a valid conf.toml", () => {
    const out = renderTomlConfig(DEFAULTS, dll);
    expect(out).toContain('current_profile = "steam-loader-lsfg-vk"');
    expect(out).toContain('exe = "steam-loader-lsfg-vk"');
    expect(out).toContain("multiplier = 2");
    expect(out).toContain("flow_scale = 0.8");
    expect(out).toContain("performance_mode = false");
    expect(out).toContain("hdr_mode = false");
    expect(out).toContain('experimental_present_mode = "fifo"');
    expect(out).toContain(`dll = "${dll}"`);
  });

  it("reflects partial setting changes", () => {
    const settings: LsfgSettings = {
      multiplier: 3,
      flow_scale: 0.7,
      performance_mode: true,
      hdr_mode: false,
      experimental_present_mode: "mailbox",
      verbose_logging: false,
    };
    const out = renderTomlConfig(settings, dll);
    expect(out).toContain("multiplier = 3");
    expect(out).toContain("flow_scale = 0.7");
    expect(out).toContain("performance_mode = true");
    expect(out).toContain('experimental_present_mode = "mailbox"');
  });

  it("clamps multiplier=0 to 2 in TOML (Off sentinel handled by wrapper)", () => {
    const out = renderTomlConfig({ ...DEFAULTS, multiplier: 0 }, dll);
    expect(out).toContain("multiplier = 2");
  });

  it("escapes special characters in the DLL path", () => {
    const weirdPath = '/path/has "quote" and\\backslash/Lossless.dll';
    const out = renderTomlConfig(DEFAULTS, weirdPath);
    expect(out).toContain('\\"quote\\"');
    expect(out).toContain("\\\\backslash");
  });
});

describe("renderWrapperScript", () => {
  it("emits a bash shebang and an exec passthrough", () => {
    const out = renderWrapperScript(DEFAULTS);
    expect(out.startsWith("#!/bin/bash")).toBe(true);
    expect(out).toContain('exec "$@"');
  });

  it("exports LSFG_PROCESS for the default profile when multiplier > 0", () => {
    const out = renderWrapperScript(DEFAULTS);
    expect(out).toContain("export LSFG_PROCESS=steam-loader-lsfg-vk");
  });

  it("omits LSFG_PROCESS when multiplier=0 (Off sentinel)", () => {
    const out = renderWrapperScript({ ...DEFAULTS, multiplier: 0 });
    expect(out).not.toContain("LSFG_PROCESS");
    expect(out).toContain('exec "$@"');
  });

  it("emits LSFG_LOG + VK_LOADER_DEBUG when verbose_logging is on", () => {
    const out = renderWrapperScript({ ...DEFAULTS, verbose_logging: true });
    expect(out).toContain("export LSFG_LOG=1");
    expect(out).toContain("export VK_LOADER_DEBUG=layer");
  });

  it("omits the logging exports when verbose_logging is off", () => {
    const out = renderWrapperScript({ ...DEFAULTS, verbose_logging: false });
    expect(out).not.toContain("LSFG_LOG");
    expect(out).not.toContain("VK_LOADER_DEBUG");
  });
});
