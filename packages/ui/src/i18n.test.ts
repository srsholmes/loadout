import { describe, it, expect } from "bun:test";
import { normalizeLocale, DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from "./i18n";

describe("normalizeLocale", () => {
  it("matches a supported code exactly (case/separator-insensitive)", () => {
    expect(normalizeLocale("zh-cn")).toBe("zh-cn");
    expect(normalizeLocale("ZH-CN")).toBe("zh-cn");
    expect(normalizeLocale("zh_CN")).toBe("zh-cn");
    expect(normalizeLocale("en-gb")).toBe("en-gb");
  });

  it("strips encoding/modifier suffixes from POSIX locales", () => {
    expect(normalizeLocale("zh_CN.UTF-8")).toBe("zh-cn");
    expect(normalizeLocale("en_GB.UTF-8")).toBe("en-gb");
    expect(normalizeLocale("en_GB@euro")).toBe("en-gb");
  });

  it("falls back to the language prefix when the region differs", () => {
    // Any Chinese variant maps to the one supported Chinese locale.
    expect(normalizeLocale("zh")).toBe("zh-cn");
    expect(normalizeLocale("zh-TW")).toBe("zh-cn");
    expect(normalizeLocale("zh-Hans")).toBe("zh-cn");
    // Any English variant maps to the supported English locale.
    expect(normalizeLocale("en")).toBe("en-gb");
    expect(normalizeLocale("en-US")).toBe("en-gb");
  });

  it("defaults to English for unsupported / empty / C locales", () => {
    expect(normalizeLocale("fr-FR")).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLocale("")).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLocale(undefined)).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLocale("C")).toBe(DEFAULT_LANGUAGE);
    expect(normalizeLocale("POSIX")).toBe(DEFAULT_LANGUAGE);
  });

  it("only ever returns a supported code", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    for (const input of ["xx", "de", "ja-JP", "zh", "en-au", ""]) {
      expect(codes).toContain(normalizeLocale(input));
    }
  });
});
