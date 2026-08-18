import { describe, expect, test, beforeEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
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
import { parseCollector, buildBody } from "./transport";
import { parseStack, buildEvent } from "./event";
import {
  initCrashReporting,
  captureError,
  captureFatalSync,
  drainSpool,
  setConsent,
  isEnabled,
  memoryStateStore,
  fileStateStore,
  resetForTests,
} from "./index";
import { spoolEvent, MAX_SPOOL_FILES, MAX_SPOOL_ATTEMPTS, RETRY_BACKOFF_MS } from "./spool";
import type { FaroPayload } from "./types";

const COLLECTOR = "https://faro-collector-prod-eu-west-0.grafana.net/collect/abc123";

const BARE_EVENT: FaroPayload = {
  meta: { sdk: { name: "t" }, app: { name: "loadout" }, os: { name: "linux" } },
  exceptions: [{ timestamp: "1970-01-01T00:00:00.000Z", type: "Error", value: "x" }],
};

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

  test("removes usernames from removable-media mount points", () => {
    // The storage plugin builds `/run/media/${user}/${name}` from the real
    // desktop username, so these paths are constructed deliberately and any
    // throw near SD-card handling carries the account name.
    expect(scrubString("EACCES, scandir '/run/media/simon/Games/steamapps'")).toBe(
      "EACCES, scandir '<media>/Games/steamapps'",
    );
    expect(scrubString("ENOENT, mkdir '/media/simon/SD/steamapps'")).toBe(
      "ENOENT, mkdir '<media>/SD/steamapps'",
    );
    // The volume label after the username is kept — useful for triage, and
    // not itself an account name.
    expect(scrubString("/run/media/simon/BigSSD/x")).toContain("BigSSD");
  });

  test("handles ostree homes without mangling them", () => {
    // Bazzite/Silverblue put real homes at /var/home/<user>. An earlier
    // version matched only the `/home` tail and produced "/var~/…".
    expect(scrubString("/var/home/simon/.config/loadout")).toBe("~/.config/loadout");
    expect(scrubString("/var/home/simon/x")).not.toContain("/var~");
  });

  test("removes the account name from free-form text, case-insensitively", () => {
    const opts = { username: "simonh", hostname: "Simons-Deck" };
    expect(scrubString("permission denied for simonh", opts)).toBe(
      "permission denied for <user>",
    );
    expect(scrubString("SIMONH could not write", opts)).toBe("<user> could not write");
    expect(scrubString("connecting to simons-deck.local", opts)).toBe(
      "connecting to <host>.local",
    );
    // Short names are left alone deliberately: substituting "deck" would
    // corrupt ordinary text, and it is universal on SteamOS so identifies
    // nobody.
    expect(scrubString("deck wrote a file", { username: "deck" })).toBe("deck wrote a file");
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

  test("strips Faro meta fields we never populate, even if set upstream", () => {
    // Faro supports all of these. We don't send them, and scrubEvent deletes
    // them defensively so a future edit can't reintroduce one silently.
    const dirty = {
      meta: {
        sdk: { name: "t" },
        app: { name: "loadout", installationId: "persistent-install-id" },
        os: { name: "linux" },
        user: { id: "u1", email: "a@b.c", username: "simon" },
        page: { url: "https://example/secret" },
        browser: { userAgent: "Mozilla/5.0 …", language: "en-GB" },
        view: { name: "settings" },
        device: { model_identifier: "serial-ish" },
      },
      exceptions: [{ timestamp: "1970-01-01T00:00:00.000Z", type: "Error", value: "x" }],
    } as unknown as FaroPayload;

    const clean = scrubEvent(dirty);
    const meta = clean.meta as unknown as Record<string, unknown>;
    expect(meta.user).toBeUndefined();
    expect(meta.page).toBeUndefined();
    expect(meta.browser).toBeUndefined();
    expect(meta.view).toBeUndefined();
    expect(meta.device).toBeUndefined();
    // A persistent install id would make every report from a machine linkable.
    expect((clean.meta.app as Record<string, unknown>).installationId).toBeUndefined();
  });

  test("scrubs inside frames, values and context", () => {
    const ev = scrubEvent({
      meta: { sdk: { name: "t" }, app: { name: "loadout" }, os: { name: "linux" } },
      exceptions: [
        {
          timestamp: "1970-01-01T00:00:00.000Z",
          type: "Error",
          value: "boom in /home/deck/c.ts",
          context: { path: "/home/deck/b.ts" },
          stacktrace: {
            frames: [
              { filename: "/home/deck/d.ts", function: "f", lineno: 1, colno: 2 },
            ],
          },
        },
      ],
    });
    const ex = ev.exceptions[0]!;
    expect(ex.value).toBe("boom in ~/c.ts");
    expect(ex.context?.path).toBe("~/b.ts");
    expect(ex.stacktrace?.frames[0]?.filename).toBe("~/d.ts");
  });

  test("fingerprint is stable across users and ignores line numbers", () => {
    // This is what makes one bug read as one Grafana issue with N affected
    // devices, rather than N separate issues — it is the top layer of their
    // grouping strategy.
    const mk = (home: string, line: number): FaroPayload => ({
      meta: { sdk: { name: "t" }, app: { name: "loadout", namespace: "backend" }, os: { name: "linux" } },
      exceptions: [
        {
          timestamp: "1970-01-01T00:00:00.000Z",
          type: "TypeError",
          value: "bad",
          stacktrace: {
            frames: [{ filename: `${home}/a.ts`, function: "f", lineno: line, colno: 1 }],
          },
        },
      ],
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
  test("parses a Faro collector URL", () => {
    const c = parseCollector(COLLECTOR);
    expect(c).not.toBeNull();
    expect(c?.url).toBe(COLLECTOR);
  });

  test("rejects malformed endpoints instead of throwing", () => {
    for (const bad of [undefined, null, "", "not-a-url", "ftp://host/collect/x"]) {
      expect(parseCollector(bad as string | undefined)).toBeNull();
    }
  });

  test("the body is the Faro payload shape and nothing more", () => {
    const ev = buildEvent({ error: new Error("héllo — ünicode"), process: "backend" });
    const parsed = JSON.parse(buildBody(ev)) as Record<string, unknown>;
    // Exactly the two documented top-level keys — no logs, measurements,
    // traces or events smuggled in.
    expect(Object.keys(parsed).sort()).toEqual(["exceptions", "meta"]);
    const meta = parsed.meta as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["app", "os", "sdk", "session"]);
    // Non-ASCII survives the round trip intact.
    expect(buildBody(ev)).toContain("ünicode");
  });

  test("geolocation tracking is explicitly disabled", () => {
    const ev = buildEvent({ error: new Error("x"), process: "backend" });
    expect(ev.meta.session?.overrides?.geoLocationTrackingEnabled).toBe(false);
  });

  test("the request itself matches Faro's contract", async () => {
    // Every other fetch mock ignores the URL and headers and returns 200, so
    // none of this was asserted anywhere: a wrong URL, a missing content type
    // or a mishandled status would have passed the whole suite.
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    resetForTests();
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      drainOnInit: false,
      spoolDir: mkdtempSync(join(tmpdir(), "loadout-req-")),
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenInit = init;
        return new Response("", { status: 202 });
      }) as unknown as typeof fetch,
    });

    // 202 Accepted is what the collector returns on success.
    expect(await captureError(new Error("boom"))).toBe(true);
    expect(seenUrl).toBe(COLLECTOR);
    expect(seenInit?.method).toBe("POST");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    // Session header must match the id inside the body.
    const body = JSON.parse(String(seenInit?.body)) as FaroPayload;
    expect(headers["x-faro-session-id"]).toBe(body.meta.session?.id);
    // No api key is set unless the collector needs one.
    expect(headers["x-api-key"]).toBeUndefined();
  });

  test("a rejected request is reported as a failure, not a success", async () => {
    resetForTests();
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      drainOnInit: false,
      spoolDir: mkdtempSync(join(tmpdir(), "loadout-429-")),
      fetchImpl: (async () => new Response("rate limited", { status: 429 })) as unknown as
        typeof fetch,
    });
    expect(await captureError(new Error("boom"))).toBe(false);
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
    // Innermost-first: the throw site is frames[0]. This matches Faro's
    // upstream getStackFramesFromError, which pushes in V8 print order and
    // never reverses. (Sentry is the opposite, which is exactly how the
    // reversal survived the migration and inverted every trace.)
    expect(frames).toHaveLength(4);
    expect(frames[0]?.function).toBe("doThing");
    expect(frames[0]?.lineno).toBe(10);
    expect(frames[1]?.function).toBe("Foo.bar");
    expect(frames[1]?.filename).toBe("/home/deck/b.ts");
    // Vendor frames are flagged locally so they're excluded from the
    // fingerprint; the flag itself never reaches the wire.
    expect(frames.at(-1)?.inApp).toBe(false);
  });

  test("the throw site is the first frame on the wire", () => {
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at applyTdp (/app/tdp.ts:10:5)",
      "    at main (/app/index.ts:3:1)",
    ].join("\n");
    const frames = buildEvent({ error: err, process: "backend" }).exceptions[0]!.stacktrace!
      .frames;
    // Grafana renders the array top-down, so an inverted list shows the
    // process entry point as the failing frame on every single issue.
    expect(frames[0]?.function).toBe("applyTdp");
    expect(frames.at(-1)?.function).toBe("main");
  });

  test("anonymous frames get a placeholder, since Faro requires a string", () => {
    const frames = parseStack(["Error: x", "    at /home/deck/c.ts:1:1"].join("\n"));
    expect(frames[0]?.function).toBe("?");
  });

  test("handles non-Error throws", () => {
    const v = (e: unknown) => buildEvent({ error: e, process: "backend" }).exceptions[0]?.value;
    expect(v("just a string")).toBe("just a string");
    expect(v({ a: 1 })).toBe('{"a":1}');
    expect(v(null)).toBe("null");
  });

  test("tags fault origin so plugin faults can be routed away from core", () => {
    const core = buildEvent({ error: new Error("x"), process: "backend" });
    expect(core.exceptions[0]?.context?.fault_origin).toBe("core");
    expect(core.exceptions[0]?.context?.plugin_id).toBeUndefined();

    const plugin = buildEvent({
      error: new Error("x"),
      process: "backend",
      context: { pluginId: "hltb" },
    });
    expect(plugin.exceptions[0]?.context?.fault_origin).toBe("plugin");
    expect(plugin.exceptions[0]?.context?.plugin_id).toBe("hltb");
  });

  test("marks fatal crashes so they can be separated from handled errors", () => {
    const fatal = buildEvent({
      error: new Error("x"),
      process: "overlay-bun",
      context: { level: "fatal" },
    });
    expect(fatal.exceptions[0]?.fatal).toBe(true);
    expect(buildEvent({ error: new Error("x"), process: "backend" }).exceptions[0]?.fatal).toBe(
      false,
    );
  });

  test("never sets user or a persistent install id", () => {
    const meta = buildEvent({ error: new Error("x"), process: "overlay-bun" })
      .meta as unknown as Record<string, unknown>;
    expect(meta.user).toBeUndefined();
    expect(meta.browser).toBeUndefined();
    expect((meta.app as Record<string, unknown>).installationId).toBeUndefined();
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
      { hostname: "simons-deck", username: "otheruser" },
    );
    const wire = buildBody(event);

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

  test("removes the Steam account id Steam actually uses in paths", () => {
    // Steam names userdata directories by the 32-BIT ACCOUNT ID, not the
    // SteamID64 — `ls ~/.steam/steam/userdata` gives e.g. "25139426". An
    // earlier version of this test used a fictional 7656119… path, so it
    // passed while the identifier loadout really handles went out intact.
    // Add 76561197960265728 to that number and you have a public profile URL.
    const real = scrubString("/home/deck/.local/share/Steam/userdata/25139426/config/grid/1.png");
    expect(real).not.toContain("25139426");
    expect(real).toContain("userdata/<steamid>");
    // The grid/app path after it survives — useful for triage.
    expect(real).toContain("grid");

    // The other renderings of the same account, all permanent identifiers.
    expect(scrubString("profile 76561198012345678 failed")).toBe("profile <steamid> failed");
    expect(scrubString("owner [U:1:25139426] missing")).toBe("owner <steamid> missing");
    expect(scrubString("id STEAM_0:1:12569713 invalid")).toBe("id <steamid> invalid");
  });

  test("does not mangle ordinary numbers outside userdata context", () => {
    // A bare 8-digit number is indistinguishable from a timestamp or byte
    // count, so account-id scrubbing is scoped to `userdata/` deliberately.
    expect(scrubString("wrote 25139426 bytes")).toBe("wrote 25139426 bytes");
    expect(scrubString("timeout after 16000 ms")).toBe("timeout after 16000 ms");
  });
});

describe("scrubbing on the real send path", () => {
  // The scrub tests above and the gating tests below both passed while
  // `captureError` could have skipped scrubEvent entirely — they exercise the
  // scrubber and the transport separately and never together. These assert on
  // the bytes actually handed to fetch, so removing scrubbing from the send
  // path fails here.
  let bodies: string[];
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    resetForTests();
    bodies = [];
    fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
  });

  test("captureError scrubs before transmitting", async () => {
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      release: "0.9.0",
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      hostname: "simons-deck",
      username: "simonh",
      fetchImpl,
      drainOnInit: false,
    });
    const err = new Error("failed for simonh at /home/simonh/x on simons-deck");
    err.stack = "Error: x\n    at f (/run/media/simonh/SD/steamapps/y.ts:1:1)";
    await captureError(err);

    expect(bodies).toHaveLength(1);
    const wire = bodies[0]!;
    for (const forbidden of ["simonh", "simons-deck", "/home/", "/run/media/simonh"]) {
      expect(wire).not.toContain(forbidden);
    }
  });

  test("captureFatalSync scrubs before spooling", () => {
    const dir = mkdtempSync(join(tmpdir(), "loadout-spool-"));
    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      username: "simonh",
      spoolDir: dir,
      fetchImpl,
      drainOnInit: false,
    });
    expect(captureFatalSync(new Error("boom for simonh at /home/simonh/a"))).toBe(true);

    // Read what actually landed on disk — the spool must never hold anything
    // we would not have sent.
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const onDisk = readFileSync(join(dir, files[0]!), "utf8");
    expect(onDisk).not.toContain("simonh");
    expect(onDisk).not.toContain("/home/");
  });
});

describe("spool and fatal path", () => {
  let dir: string;
  let sentBodies: string[];
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    resetForTests();
    dir = mkdtempSync(join(tmpdir(), "loadout-spool2-"));
    sentBodies = [];
    fetchImpl = (async (_u: string, init: RequestInit) => {
      sentBodies.push(String(init.body));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
  });

  test("a fatal capture survives the process and ships on next start", async () => {
    // Run 1: dies without sending anything.
    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl,
      drainOnInit: false,
    });
    captureFatalSync(new Error("fatal one"));
    expect(sentBodies).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(1);

    // Run 2: a fresh process drains it.
    resetForTests();
    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl,
      drainOnInit: false,
    });
    expect(await drainSpool()).toBe(1);
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toContain("fatal one");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("consent withdrawn between crash and restart discards the spool", async () => {
    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl,
      drainOnInit: false,
    });
    captureFatalSync(new Error("spooled while allowed"));
    expect(readdirSync(dir)).toHaveLength(1);

    resetForTests();
    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "denied",
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl,
      drainOnInit: false,
    });
    expect(await drainSpool()).toBe(0);
    expect(sentBodies).toHaveLength(0);
    // Discarded, not left to be sent if consent is granted again later.
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("a failed drain puts reports back instead of destroying them", async () => {
    // takeSpooled unlinks on read, so without re-spooling, a drain that runs
    // while the device is offline would wipe the queue — defeating the spool
    // in the exact situation it exists for.
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl: offline,
      drainOnInit: false,
    });
    captureFatalSync(new Error("survives an offline drain"));
    expect(readdirSync(dir)).toHaveLength(1);

    expect(await drainSpool()).toBe(0);
    // Still queued, with the attempt count bumped.
    const after = readdirSync(dir);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain("-a1-");

    // Back online — but only after the retry backoff has elapsed, so the
    // clock is pushed forward rather than draining immediately.
    resetForTests();
    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl,
      drainOnInit: false,
      now: () => Date.now() + RETRY_BACKOFF_MS + 1000,
    });
    expect(await drainSpool()).toBe(1);
    expect(sentBodies[0]).toContain("survives an offline drain");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("a restart loop cannot chew through the retry budget", async () => {
    // The budget is per elapsed time, not per process start. systemd restarts
    // the overlay every 5s; without the backoff, five restarts would discard
    // the reports about twenty seconds after the crash that produced them —
    // the exact scenario the spool exists for.
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl: offline,
      drainOnInit: false,
    });
    captureFatalSync(new Error("must survive a restart loop"));

    // Ten rapid restarts, all within the backoff window.
    for (let i = 0; i < 10; i++) await drainSpool();

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    // Exactly one attempt was spent, not ten.
    expect(files[0]).toContain("-a1-");
  });

  test("an event that never sends is eventually given up on", async () => {
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    // Each attempt sits one backoff window further into the future, so the
    // budget is spent over hours rather than in a tight loop.
    let clock = Date.now();
    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl: offline,
      drainOnInit: false,
      now: () => clock,
    });
    captureFatalSync(new Error("permanently unsendable"));
    for (let i = 0; i < MAX_SPOOL_ATTEMPTS + 2; i++) {
      clock += RETRY_BACKOFF_MS + 1000;
      await drainSpool();
    }
    // Dropped rather than retried forever on every start.
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("a fatal capture without consent writes nothing at all", () => {
    initCrashReporting({
      process: "overlay-bun",
      collectorUrl: COLLECTOR,
      readConsent: () => undefined,
      stateStore: memoryStateStore(),
      spoolDir: dir,
      fetchImpl,
      drainOnInit: false,
    });
    expect(captureFatalSync(new Error("boom"))).toBe(false);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test("the spool is bounded so a crash loop cannot fill the disk", () => {
    for (let i = 0; i < MAX_SPOOL_FILES + 15; i++) {
      spoolEvent(dir, { ...BARE_EVENT, event_id: `id${i}` }, 1_700_000_000_000 + i);
    }
    expect(readdirSync(dir).length).toBeLessThanOrEqual(MAX_SPOOL_FILES);
  });
});

describe("the shipped default consent supplier", () => {
  // Every other gating test injects its own `readConsent`, so the default
  // built inside initCrashReporting — the one that actually runs in
  // production — had no coverage at all. A fail-open there would have passed
  // the entire suite.
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

  function initWithHome(home: string) {
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      // No readConsent: exercise the real default, pointed at a temp home.
      hostname: "irrelevant",
      stateStore: memoryStateStore(),
      spoolDir: mkdtempSync(join(tmpdir(), "loadout-defspool-")),
      fetchImpl,
      drainOnInit: false,
      homeOverride: home,
      // Hermetic: consent resolution checks $XDG_CONFIG_HOME before the home
      // directory, so sandboxing only the home would still read the real
      // machine's config on a developer who sets that variable.
      envOverride: {},
    });
  }

  test("sends when config.json on disk says granted", async () => {
    initWithHome(configWith("granted").home);
    expect(await captureError(new Error("boom"))).toBe(true);
    expect(sent).toBe(1);
  });

  test("sends nothing when the config says denied", async () => {
    initWithHome(configWith("denied").home);
    expect(await captureError(new Error("boom"))).toBe(false);
    expect(sent).toBe(0);
  });

  test("sends nothing when the key is absent or the file is missing", async () => {
    initWithHome(configWith(undefined).home);
    expect(await captureError(new Error("boom"))).toBe(false);

    resetForTests();
    initWithHome(mkdtempSync(join(tmpdir(), "loadout-nohome-")));
    expect(await captureError(new Error("boom"))).toBe(false);
    expect(sent).toBe(0);
  });
});

describe("rate-limit state really persists to disk", () => {
  // The rate-limit tests above drive the pure `decide` function and would all
  // pass if fileStateStore were removed entirely. This drives the real store.
  test("the limit holds across simulated process restarts", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "loadout-state-")), "state.json");
    let sent = 0;
    const fetchImpl = (async () => {
      sent++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    // Each iteration is a fresh process hitting the identical fault — exactly
    // what systemd Restart=on-failure produces during a crash loop.
    for (let restart = 0; restart < 5; restart++) {
      resetForTests();
      initCrashReporting({
        process: "backend",
        collectorUrl: COLLECTOR,
        readConsent: () => "granted",
        stateStore: fileStateStore(path),
        fetchImpl,
        drainOnInit: false,
      });
      await captureError(new Error("identical crash loop fault"));
    }
    expect(sent).toBe(DEFAULT_LIMITS.maxPerFingerprintPerHour);
    expect(existsSync(path)).toBe(true);
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
      collectorUrl: COLLECTOR,
      readConsent: () => undefined,
      stateStore: memoryStateStore(),
      fetchImpl,
      drainOnInit: false,
    });
    expect(isEnabled()).toBe(false);
    expect(await captureError(new Error("boom"))).toBe(false);
    expect(sent).toBe(0);
  });

  test("sends nothing when consent is denied", async () => {
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      readConsent: () => "denied",
      stateStore: memoryStateStore(),
      fetchImpl,
      drainOnInit: false,
    });
    expect(await captureError(new Error("boom"))).toBe(false);
    expect(sent).toBe(0);
  });

  test("sends nothing when no collector is configured", async () => {
    initCrashReporting({
      process: "backend",
      collectorUrl: undefined,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      fetchImpl,
      drainOnInit: false,
    });
    expect(isEnabled()).toBe(false);
    expect(await captureError(new Error("boom"))).toBe(false);
    expect(sent).toBe(0);
  });

  test("sends when granted", async () => {
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      release: "0.9.0",
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      fetchImpl,
      drainOnInit: false,
    });
    expect(isEnabled()).toBe(true);
    expect(await captureError(new Error("boom"))).toBe(true);
    expect(sent).toBe(1);
  });

  test("revoking consent stops reporting immediately, not at next restart", async () => {
    let consent: "granted" | "denied" = "granted";
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      readConsent: () => consent,
      stateStore: memoryStateStore(),
      fetchImpl,
      drainOnInit: false,
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
      collectorUrl: COLLECTOR,
      stateStore: memoryStateStore(),
      fetchImpl,
      drainOnInit: false,
    });
    expect(await captureError(new Error("boom"))).toBe(false);
    setConsent("granted");
    expect(await captureError(new Error("boom"))).toBe(true);
    expect(sent).toBe(1);
  });

  test("a network failure resolves false rather than throwing", async () => {
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      // Isolated like every neighbouring test: without these, init drains the
      // developer's REAL spool at ~/.local/state/loadout/crash-spool-backend
      // and, with a throwing fetch, burns an attempt off each genuine queued
      // report until they are discarded.
      spoolDir: mkdtempSync(join(tmpdir(), "loadout-netfail-")),
      drainOnInit: false,
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await captureError(new Error("boom"))).toBe(false);
  });

  test("rate limiting applies end to end", async () => {
    initCrashReporting({
      process: "backend",
      collectorUrl: COLLECTOR,
      readConsent: () => "granted",
      stateStore: memoryStateStore(),
      fetchImpl,
      drainOnInit: false,
    });
    for (let i = 0; i < 6; i++) await captureError(new Error("same boom"));
    // Same fault repeated — the per-fingerprint cap is what stops a loop.
    expect(sent).toBe(DEFAULT_LIMITS.maxPerFingerprintPerHour);
  });
});
