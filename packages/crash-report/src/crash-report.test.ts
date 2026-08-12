import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseConsent,
  readConsentSync,
  userConfigPathFrom,
  userConfigPathsFrom,
  CRASH_REPORTING_KEY,
} from "./consent";
import { scrubString, scrubEvent, fingerprint } from "./scrub";
import { decide, parseState, freshState, DEFAULT_LIMITS } from "./rate-limit";
import { parseDsn, buildEnvelope, envelopeUrl } from "./transport";
import { parseStack, buildEvent } from "./event";
import {
  initCrashReporting,
  captureError,
  setConsent,
  isEnabled,
  memoryStateStore,
  resetForTests,
} from "./index";
import type { SentryEvent } from "./types";

const DSN = "https://abc123@o1.ingest.de.sentry.io/456";

function configWith(value: unknown): { env: Record<string, string>; home: string } {
  const home = mkdtempSync(join(tmpdir(), "loadout-consent-"));
  mkdirSync(join(home, ".config", "loadout"), { recursive: true });
  writeFileSync(
    join(home, ".config", "loadout", "config.json"),
    JSON.stringify(value === undefined ? {} : { [CRASH_REPORTING_KEY]: value }),
  );
  return { env: {}, home };
}

describe("consent", () => {
  test("is tri-state, and only the exact string grants", () => {
    expect(parseConsent("granted")).toBe("granted");
    expect(parseConsent("denied")).toBe("denied");
    expect(parseConsent(undefined)).toBeUndefined();
    // "not asked" must stay distinguishable from "said no" — that
    // distinction is what lets upgraders be prompted exactly once.
    expect(parseConsent(null)).toBeUndefined();
    expect(parseConsent(true)).toBeUndefined();
    expect(parseConsent("GRANTED")).toBeUndefined();
    expect(parseConsent("yes")).toBeUndefined();
  });

  test("honours XDG_CONFIG_HOME the same way user-config.ts does", () => {
    expect(userConfigPathFrom({ XDG_CONFIG_HOME: "/xdg" }, "/home/deck")).toBe(
      "/xdg/loadout/config.json",
    );
    expect(userConfigPathFrom({}, "/home/deck")).toBe("/home/deck/.config/loadout/config.json");
    expect(userConfigPathFrom({ XDG_CONFIG_HOME: "" }, "/home/deck")).toBe(
      "/home/deck/.config/loadout/config.json",
    );
  });

  test("reads both candidate paths, because the two units see different envs", () => {
    // loadout.service is a *system* unit setting only HOME; the overlay is a
    // *user* unit inheriting XDG_CONFIG_HOME. Reading one path would mean the
    // two processes disagree about consent on any machine that sets it.
    expect(userConfigPathsFrom({ XDG_CONFIG_HOME: "/xdg" }, "/home/deck")).toEqual([
      "/xdg/loadout/config.json",
      "/home/deck/.config/loadout/config.json",
    ]);
    expect(userConfigPathsFrom({}, "/home/deck")).toEqual([
      "/home/deck/.config/loadout/config.json",
    ]);

    // The root backend wrote to ~/.config (no XDG in its env); a reader that
    // *does* have XDG set must still find that answer.
    const home = mkdtempSync(join(tmpdir(), "loadout-xdg-"));
    mkdirSync(join(home, ".config", "loadout"), { recursive: true });
    writeFileSync(
      join(home, ".config", "loadout", "config.json"),
      JSON.stringify({ [CRASH_REPORTING_KEY]: "granted" }),
    );
    expect(readConsentSync({ XDG_CONFIG_HOME: "/nonexistent-xdg" }, home)).toBe("granted");
  });

  test("reads granted from disk", () => {
    const { env, home } = configWith("granted");
    expect(readConsentSync(env, home)).toBe("granted");
  });

  test("fails closed on every bad input", () => {
    const denied = configWith("denied");
    expect(readConsentSync(denied.env, denied.home)).toBe("denied");

    const absent = configWith(undefined);
    expect(readConsentSync(absent.env, absent.home)).toBeUndefined();

    // No config file at all.
    expect(readConsentSync({}, mkdtempSync(join(tmpdir(), "loadout-empty-")))).toBeUndefined();

    // Malformed JSON.
    const broken = mkdtempSync(join(tmpdir(), "loadout-broken-"));
    mkdirSync(join(broken, ".config", "loadout"), { recursive: true });
    writeFileSync(join(broken, ".config", "loadout", "config.json"), "{not json");
    expect(readConsentSync({}, broken)).toBeUndefined();

    // Valid JSON, wrong shape.
    const arr = mkdtempSync(join(tmpdir(), "loadout-arr-"));
    mkdirSync(join(arr, ".config", "loadout"), { recursive: true });
    writeFileSync(join(arr, ".config", "loadout", "config.json"), "[1,2,3]");
    expect(readConsentSync({}, arr)).toBeUndefined();
  });
});

describe("scrubbing", () => {
  test("removes any user's home, not just this process's", () => {
    // The backend runs as root, so frames reference a home that isn't its own.
    expect(scrubString("/home/deck/.local/share/x.ts")).toBe("~/.local/share/x.ts");
    expect(scrubString("/home/simon/foo")).toBe("~/foo");
    expect(scrubString("at fn (/home/alice/a.ts:1:2)")).toBe("at fn (~/a.ts:1:2)");
  });

  test("normalises on-device plugin paths so users share a fingerprint", () => {
    const a = scrubString("/home/deck/.local/share/loadout/plugins/hltb/backend.ts");
    const b = scrubString("/home/simon/.local/share/loadout/plugins/hltb/backend.ts");
    expect(a).toBe(b);
    expect(a).toContain("<plugins>/hltb");
    // The plugin id survives — we still need to know which plugin broke.
    expect(a).toContain("hltb");
  });

  test("redacts credentials that leak into error messages", () => {
    expect(scrubString("GET https://x/api?key=SECRET123&b=1")).toBe(
      "GET https://x/api?key=<redacted>&b=1",
    );
    expect(scrubString("api_key=abc")).toBe("api_key=<redacted>");
    expect(scrubString("access_token=abc")).toBe("access_token=<redacted>");
    expect(scrubString("Authorization: Bearer eyJhbGci.foo-bar_baz")).toBe(
      "Authorization: Bearer <redacted>",
    );
    expect(scrubString("/run/user/1000/bus")).toBe("/run/user/<uid>/bus");
  });

  test("strips identifying fields even if something upstream sets them", () => {
    const dirty = {
      event_id: "x",
      timestamp: 0,
      platform: "node",
      level: "error",
      user: { ip_address: "1.2.3.4", email: "a@b.c" },
      server_name: "simons-deck",
      breadcrumbs: [{ message: "secret" }],
      request: { url: "https://x", headers: { cookie: "c" } },
    } as unknown as SentryEvent;
    const clean = scrubEvent(dirty) as unknown as Record<string, unknown>;
    expect(clean.user).toBeUndefined();
    expect(clean.server_name).toBeUndefined();
    expect(clean.breadcrumbs).toBeUndefined();
    expect(clean.request).toBeUndefined();
  });

  test("scrubs inside frames, messages and tags", () => {
    const ev = scrubEvent({
      event_id: "x",
      timestamp: 0,
      platform: "node",
      level: "error",
      message: { formatted: "failed at /home/deck/a.ts" },
      tags: { path: "/home/deck/b.ts" },
      exception: {
        values: [
          {
            type: "Error",
            value: "boom in /home/deck/c.ts",
            stacktrace: {
              frames: [{ filename: "/home/deck/d.ts", function: "f", lineno: 1, colno: 2 }],
            },
          },
        ],
      },
    });
    expect(ev.message?.formatted).toBe("failed at ~/a.ts");
    expect(ev.tags?.path).toBe("~/b.ts");
    expect(ev.exception?.values[0]?.value).toBe("boom in ~/c.ts");
    expect(ev.exception?.values[0]?.stacktrace?.frames[0]?.filename).toBe("~/d.ts");
  });

  test("fingerprint is stable across users and ignores line numbers", () => {
    const mk = (home: string, line: number): SentryEvent => ({
      event_id: "x",
      timestamp: 0,
      platform: "node",
      level: "error",
      tags: { process: "backend" },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "bad",
            stacktrace: {
              frames: [{ filename: `${home}/a.ts`, function: "f", lineno: line, colno: 1 }],
            },
          },
        ],
      },
    });
    const a = fingerprint(scrubEvent(mk("/home/deck", 10)));
    const b = fingerprint(scrubEvent(mk("/home/simon", 99)));
    expect(a).toBe(b);
  });
});

describe("rate limiting", () => {
  const T0 = 1_700_000_000_000;

  test("caps repeats of one fault — the crash-loop case", () => {
    let s = freshState(T0);
    const allowed: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const d = decide(s, T0 + i * 1000, "same-fp");
      allowed.push(d.allow);
      s = d.state;
    }
    expect(allowed).toEqual([true, true, false, false, false]);
  });

  test("survives a restart — the reason state is on disk at all", () => {
    // A crash loop restarts the process every few seconds. An in-memory
    // limiter resets each time and reports forever; this must not.
    let persisted = JSON.stringify(freshState(T0));
    const results: boolean[] = [];
    for (let restart = 0; restart < 5; restart++) {
      const state = parseState(persisted, T0 + restart * 5000);
      const d = decide(state, T0 + restart * 5000, "loop-fp");
      results.push(d.allow);
      persisted = JSON.stringify(d.state);
    }
    expect(results).toEqual([true, true, false, false, false]);
  });

  test("enforces hourly and daily ceilings", () => {
    let s = freshState(T0);
    let sent = 0;
    for (let i = 0; i < 50; i++) {
      const d = decide(s, T0 + i * 1000, `fp-${i}`);
      if (d.allow) sent++;
      s = d.state;
    }
    expect(sent).toBe(DEFAULT_LIMITS.maxPerHour);
  });

  test("rolls windows forward", () => {
    let s = freshState(T0);
    for (let i = 0; i < 10; i++) s = decide(s, T0 + i, `fp-${i}`).state;
    expect(decide(s, T0 + 1000, "new").allow).toBe(false);
    const later = decide(s, T0 + DEFAULT_LIMITS.windowMs + 1, "new");
    expect(later.allow).toBe(true);
  });

  test("daily ceiling outlasts hourly rollovers", () => {
    let s = freshState(T0);
    let sent = 0;
    for (let h = 0; h < 12; h++) {
      for (let i = 0; i < 10; i++) {
        const now = T0 + h * DEFAULT_LIMITS.windowMs + i * 1000;
        const d = decide(s, now, `fp-${h}-${i}`);
        if (d.allow) sent++;
        s = d.state;
      }
    }
    expect(sent).toBe(DEFAULT_LIMITS.maxPerDay);
  });

  test("recovers from corrupt or future-dated state", () => {
    expect(parseState("{garbage", T0).hourCount).toBe(0);
    expect(parseState(null, T0).hourCount).toBe(0);
    expect(parseState(JSON.stringify({ v: 99 }), T0).hourCount).toBe(0);
    // Clock stepped backwards (suspend/resume, NTP) — a future-dated window
    // would otherwise never roll over and would wedge reporting forever.
    const future = JSON.stringify({ ...freshState(T0 + 100_000), v: 1 });
    expect(parseState(future, T0).hourStart).toBe(T0);
  });
});

describe("transport", () => {
  test("parses a DSN and builds the ingest URL", () => {
    const d = parseDsn(DSN);
    expect(d).not.toBeNull();
    expect(d?.publicKey).toBe("abc123");
    expect(d?.projectId).toBe("456");
    expect(envelopeUrl(d!)).toBe("https://o1.ingest.de.sentry.io/api/456/envelope/");
  });

  test("rejects malformed DSNs instead of throwing", () => {
    for (const bad of [undefined, null, "", "not-a-url", "https://nokey.example.com/1", "https://k@host/"]) {
      expect(parseDsn(bad as string | undefined)).toBeNull();
    }
  });

  test("envelope length counts bytes, not characters", () => {
    // A stack trace with any non-ASCII would otherwise produce a short
    // count and an envelope the server rejects.
    const ev = buildEvent({ error: new Error("héllo — ünicode"), process: "backend" });
    const env = buildEnvelope(ev, parseDsn(DSN)!);
    const [, itemHeader, body] = env.split("\n");
    const declared = (JSON.parse(itemHeader!) as { length: number }).length;
    expect(declared).toBe(new TextEncoder().encode(body!).length);
    expect(declared).toBeGreaterThan(body!.length - 10);
  });
});

describe("event building", () => {
  test("parses V8 frames from both runtimes", () => {
    const frames = parseStack(
      [
        "Error: boom",
        "    at doThing (/home/deck/a.ts:10:5)",
        "    at async Foo.bar (file:///home/deck/b.ts:3:1)",
        "    at /home/deck/c.ts:1:1",
        "    at other (node:internal/x:1:1)",
      ].join("\n"),
    );
    // Reversed: Sentry renders oldest-first.
    expect(frames).toHaveLength(4);
    expect(frames.at(-1)?.function).toBe("doThing");
    expect(frames.at(-1)?.lineno).toBe(10);
    expect(frames.at(-2)?.function).toBe("Foo.bar");
    expect(frames.at(-2)?.filename).toBe("/home/deck/b.ts");
    expect(frames[0]?.in_app).toBe(false);
  });

  test("handles non-Error throws", () => {
    expect(buildEvent({ error: "just a string", process: "backend" }).exception?.values[0]?.value)
      .toBe("just a string");
    expect(buildEvent({ error: { a: 1 }, process: "backend" }).exception?.values[0]?.value)
      .toBe('{"a":1}');
    expect(buildEvent({ error: null, process: "backend" }).exception?.values[0]?.value).toBe("null");
  });

  test("tags fault origin so plugin faults can be routed away from core", () => {
    const core = buildEvent({ error: new Error("x"), process: "backend" });
    expect(core.tags?.fault_origin).toBe("core");
    expect(core.tags?.plugin_id).toBeUndefined();

    const plugin = buildEvent({
      error: new Error("x"),
      process: "backend",
      context: { pluginId: "hltb" },
    });
    expect(plugin.tags?.fault_origin).toBe("plugin");
    expect(plugin.tags?.plugin_id).toBe("hltb");
  });

  test("never sets hostname or user", () => {
    const ev = buildEvent({ error: new Error("x"), process: "overlay-bun" }) as unknown as
      Record<string, unknown>;
    expect(ev.server_name).toBeUndefined();
    expect(ev.user).toBeUndefined();
  });
});

describe("the never-leaks gate", () => {
  // Asserts on the *serialized envelope*, not on intermediate objects.
  // Everything else in this file checks a transformation; this checks the
  // bytes that would actually cross the network. If a future change adds a
  // field that carries a path, this is the test that catches it.
  test("no identifying data survives into the wire format", () => {
    const err = new Error(
      "Request failed for /home/deck/Games/My Private Game/save.dat " +
        "via https://api.steamgriddb.com/v2/x?api_key=sk_live_abcdef123456 " +
        "(user 76561198012345678, host simons-deck)",
    );
    err.stack = [
      "Error: boom",
      "    at load (/home/deck/.local/share/loadout/plugins/hltb/backend.ts:42:7)",
      "    at run (/home/otheruser/.local/share/loadout/plugins/hltb/backend.ts:9:1)",
      "    at boot (/run/user/1000/loadout/x.ts:3:1)",
    ].join("\n");

    const event = scrubEvent(
      buildEvent({
        error: err,
        process: "backend",
        release: "0.9.0",
        context: { pluginId: "hltb", tags: { path: "/home/deck/secret" } },
      }),
      { hostname: "simons-deck" },
    );
    const wire = buildEnvelope(event, parseDsn(DSN)!);

    for (const forbidden of [
      "/home/",
      "deck/Games",
      "otheruser",
      "simons-deck",
      "sk_live_abcdef123456",
      "/run/user/1000",
      "76561198012345678",
    ]) {
      expect(wire).not.toContain(forbidden);
    }

    // …while still carrying enough to actually debug the fault.
    expect(wire).toContain("<plugins>/hltb");
    expect(wire).toContain("hltb");
    expect(wire).toContain("0.9.0");
    // And the plugin path is well-formed, not a mangled "~<plugins>/…".
    expect(wire).not.toContain("~<plugins>");
  });

  test("a steam id in a path is not silently preserved by normalisation", () => {
    // Steam userdata paths embed a SteamID64. They arrive under $HOME, so
    // home normalisation is what removes them; this pins that behaviour.
    const s = scrubString("/home/deck/.steam/steam/userdata/76561198012345678/config");
    expect(s).not.toContain("/home/");
    expect(s.startsWith("~/")).toBe(true);
  });
});

describe("capture gating (the test that matters)", () => {
  let sent: number;
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    resetForTests();
    sent = 0;
    fetchImpl = (async () => {
      sent++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
  });

  test("sends nothing when consent is unset", async () => {
    initCrashReporting({
      process: "backend",
      dsn: DSN,
      readConsent: () => undefined,
      stateStore: memoryStateStore(),
      fetchImpl,
    });
    expect(isEnabled()).toBe(false);
    expect(await captureError(new Error("boom"))).toBe(false);
    expect(sent).toBe(0);
  });

  test("sends nothing when consent is denied", async () => {
    initCrashReporting({
      process: "backend",
      dsn: DSN,
      readConsent: () => "denied",
      stateStore: memoryStateStore(),
      fetchImpl,
    });
    expect(await captureError(new Error("boom"))).toBe(false);
    expect(sent).toBe(0);
  });

  test("sends nothing when no DSN is configured", async () => {
    initCrashReporting({
      process: "backend",
      dsn: undefined,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      fetchImpl,
    });
    expect(isEnabled()).toBe(false);
    expect(await captureError(new Error("boom"))).toBe(false);
    expect(sent).toBe(0);
  });

  test("sends when granted", async () => {
    initCrashReporting({
      process: "backend",
      dsn: DSN,
      release: "0.9.0",
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      fetchImpl,
    });
    expect(isEnabled()).toBe(true);
    expect(await captureError(new Error("boom"))).toBe(true);
    expect(sent).toBe(1);
  });

  test("revoking consent stops reporting immediately, not at next restart", async () => {
    let consent: "granted" | "denied" = "granted";
    initCrashReporting({
      process: "backend",
      dsn: DSN,
      readConsent: () => consent,
      stateStore: memoryStateStore(),
      fetchImpl,
    });
    await captureError(new Error("one"));
    expect(sent).toBe(1);
    consent = "denied";
    await captureError(new Error("two"));
    expect(sent).toBe(1);
  });

  test("webview consent comes from setConsent", async () => {
    initCrashReporting({
      process: "webview",
      dsn: DSN,
      stateStore: memoryStateStore(),
      fetchImpl,
    });
    expect(await captureError(new Error("boom"))).toBe(false);
    setConsent("granted");
    expect(await captureError(new Error("boom"))).toBe(true);
    expect(sent).toBe(1);
  });

  test("a network failure resolves false rather than throwing", async () => {
    initCrashReporting({
      process: "backend",
      dsn: DSN,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await captureError(new Error("boom"))).toBe(false);
  });

  test("rate limiting applies end to end", async () => {
    initCrashReporting({
      process: "backend",
      dsn: DSN,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      fetchImpl,
    });
    for (let i = 0; i < 6; i++) await captureError(new Error("same boom"));
    // Same fault repeated — the per-fingerprint cap is what stops a loop.
    expect(sent).toBe(DEFAULT_LIMITS.maxPerFingerprintPerHour);
  });
});
