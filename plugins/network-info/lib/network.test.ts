import { describe, it, expect } from "bun:test";
import {
  parseIpAddrOutput,
  parseNmcliOutput,
  parseIwconfigOutput,
  parseProcNetWireless,
  fmtSpeed,
  fmtLatency,
  signalLabel,
  CF_DATACENTERS,
} from "./network";

describe("parseIpAddrOutput", () => {
  it("parses basic IPv4 interfaces", () => {
    const output = [
      "2: eth0    inet 192.168.1.100/24 brd 192.168.1.255 scope global eth0",
      "3: wlan0    inet 10.0.0.50/24 brd 10.0.0.255 scope global wlan0",
    ].join("\n");

    const result = parseIpAddrOutput(output);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: "eth0", ip: "192.168.1.100" });
    expect(result[1]).toEqual({ name: "wlan0", ip: "10.0.0.50" });
  });

  it("skips loopback (lo) entries", () => {
    const output = [
      "1: lo    inet 127.0.0.1/8 scope host lo",
      "2: eth0    inet 192.168.1.100/24 brd 192.168.1.255 scope global eth0",
    ].join("\n");

    const result = parseIpAddrOutput(output);
    expect(result.every((i) => i.name !== "lo")).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("eth0");
  });

  it("skips IPv6 entries (inet6 family)", () => {
    const output = [
      "2: eth0    inet6 ::1/128 scope host",
      "3: eth0    inet 192.168.1.100/24 brd 192.168.1.255 scope global eth0",
    ].join("\n");

    const result = parseIpAddrOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].ip).toBe("192.168.1.100");
  });

  it("deduplicates by interface name — keeps first", () => {
    const output = [
      "2: eth0    inet 192.168.1.100/24 brd 192.168.1.255 scope global eth0",
      "2: eth0    inet 192.168.1.101/24 brd 192.168.1.255 scope global eth0",
    ].join("\n");

    const result = parseIpAddrOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].ip).toBe("192.168.1.100");
  });

  it("returns empty array for empty / whitespace-only output", () => {
    expect(parseIpAddrOutput("")).toEqual([]);
    expect(parseIpAddrOutput("   \n  \n")).toEqual([]);
  });

  it("ignores malformed lines gracefully", () => {
    const output = [
      "not a valid ip line",
      "2: eth0    inet 10.0.0.1/24",
    ].join("\n");

    const result = parseIpAddrOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("eth0");
  });
});

describe("parseNmcliOutput", () => {
  it("parses active WiFi entry", () => {
    const result = parseNmcliOutput("yes:MyNetwork:85:5180");
    expect(result).not.toBeNull();
    expect(result?.ssid).toBe("MyNetwork");
    expect(result?.signal).toBe(85);
    expect(result?.frequency).toBe("5180 MHz");
  });

  it("returns null when no active entry", () => {
    const output = [
      "no:OtherNet:50:2412",
      "no:ThirdNet:30:5200",
    ].join("\n");
    expect(parseNmcliOutput(output)).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(parseNmcliOutput("")).toBeNull();
  });

  it("handles missing frequency gracefully", () => {
    const result = parseNmcliOutput("yes:Network:70:");
    expect(result?.frequency).toBeNull();
    expect(result?.signal).toBe(70);
  });

  it("handles missing signal gracefully", () => {
    const result = parseNmcliOutput("yes:Network::5180");
    expect(result?.signal).toBeNull();
    expect(result?.frequency).toBe("5180 MHz");
  });
});

describe("parseIwconfigOutput", () => {
  const sampleOutput = [
    'wlan0     IEEE 802.11  ESSID:"FallbackNet"',
    "          Frequency:5.18 GHz  Bit Rate=866.7 Mb/s",
    "          Signal level=-45 dBm",
  ].join("\n");

  it("parses SSID", () => {
    const result = parseIwconfigOutput(sampleOutput);
    expect(result.ssid).toBe("FallbackNet");
  });

  it("parses signal dBm and converts to percentage", () => {
    const result = parseIwconfigOutput(sampleOutput);
    // 2 * (-45 + 100) = 110, clamped to 100
    expect(result.signal).toBe(100);
  });

  it("clamps negative dBm signal to 0 at the floor", () => {
    const result = parseIwconfigOutput("Signal level=-110 dBm");
    // 2 * (-110 + 100) = -20, clamped to 0
    expect(result.signal).toBe(0);
  });

  it("parses frequency", () => {
    const result = parseIwconfigOutput(sampleOutput);
    expect(result.frequency).toBe("5.18 GHz");
  });

  it("parses bit rate", () => {
    const result = parseIwconfigOutput(sampleOutput);
    expect(result.bitRate).toBe("866.7 Mb/s");
  });

  it("returns empty partial when output is empty", () => {
    const result = parseIwconfigOutput("");
    expect(result.ssid).toBeUndefined();
    expect(result.signal).toBeUndefined();
  });
});

describe("parseProcNetWireless", () => {
  it("parses negative dBm level (typical case)", () => {
    const content = [
      "Inter-| sta-|   Quality        |   Discarded packets",
      " face | tus |   link.  level.  noise.",
      " wlan0: 0001    50.  -60.  -95.    0      0      0",
    ].join("\n");

    const result = parseProcNetWireless(content);
    // 2 * (-60 + 100) = 80
    expect(result).toBe(80);
  });

  it("parses positive relative level", () => {
    const content = [
      "header1",
      "header2",
      " wlan0: 0001    50.  75.  -95.    0      0      0",
    ].join("\n");

    const result = parseProcNetWireless(content);
    expect(result).toBe(75);
  });

  it("clamps values to 0–100", () => {
    const content = [
      "header1",
      "header2",
      " wlan0: 0001    50.  -5.  -95.    0      0      0",
    ].join("\n");
    // 2 * (-5 + 100) = 190, clamped to 100
    const result = parseProcNetWireless(content);
    expect(result).toBe(100);
  });

  it("returns null for empty content", () => {
    expect(parseProcNetWireless("")).toBeNull();
    expect(parseProcNetWireless("header1\nheader2\n")).toBeNull();
  });

  it("returns null when level column is NaN", () => {
    const content = ["header1", "header2", " wlan0: 0001    50.  N/A  -95.    0"].join("\n");
    expect(parseProcNetWireless(content)).toBeNull();
  });
});

describe("fmtSpeed", () => {
  it("returns '--' for null", () => {
    expect(fmtSpeed(null)).toBe("--");
  });
  it("converts bps to Mbps with 1 decimal", () => {
    expect(fmtSpeed(94_000_000)).toBe("94.0");
    expect(fmtSpeed(1_500_000)).toBe("1.5");
  });
});

describe("fmtLatency", () => {
  it("returns '--' for null", () => {
    expect(fmtLatency(null)).toBe("--");
  });
  it("formats ms with 1 decimal", () => {
    expect(fmtLatency(12.345)).toBe("12.3");
  });
});

describe("signalLabel", () => {
  it("returns Unknown for null", () => {
    expect(signalLabel(null)).toBe("Unknown");
  });
  it("returns Excellent for 80+", () => {
    expect(signalLabel(80)).toBe("Excellent");
    expect(signalLabel(100)).toBe("Excellent");
  });
  it("returns Good for 60–79", () => {
    expect(signalLabel(60)).toBe("Good");
    expect(signalLabel(79)).toBe("Good");
  });
  it("returns Fair for 40–59", () => {
    expect(signalLabel(40)).toBe("Fair");
    expect(signalLabel(59)).toBe("Fair");
  });
  it("returns Weak for 20–39", () => {
    expect(signalLabel(20)).toBe("Weak");
    expect(signalLabel(39)).toBe("Weak");
  });
  it("returns Very Weak for 0–19", () => {
    expect(signalLabel(0)).toBe("Very Weak");
    expect(signalLabel(19)).toBe("Very Weak");
  });
});

describe("CF_DATACENTERS", () => {
  it("maps known PoPs to city names", () => {
    expect(CF_DATACENTERS["ATL"]).toBe("Atlanta, GA");
    expect(CF_DATACENTERS["LHR"]).toBe("London, GB");
    expect(CF_DATACENTERS["NRT"]).toBe("Tokyo, JP");
  });
});
