import { describe, expect, it } from "bun:test";

const _path = import.meta.dir + "/binary-vdf.ts";
const { parseBinaryVdf, shortcutGameId64 } = await import(
  _path + "?real"
);

/**
 * Helper: build a binary VDF byte array from a series of typed entries.
 * Mirrors the wire format described in binary-vdf.ts header.
 */
function buildVdf(entries: Uint8Array[]): Buffer {
  let total = 0;
  for (const e of entries) total += e.length;
  total += 1; // closing 0x08
  const buf = Buffer.alloc(total);
  let off = 0;
  for (const e of entries) {
    buf.set(e, off);
    off += e.length;
  }
  buf[off] = 0x08;
  return buf;
}

function strField(key: string, value: string): Uint8Array {
  const k = Buffer.from(key + "\0", "utf-8");
  const v = Buffer.from(value + "\0", "utf-8");
  const buf = Buffer.alloc(1 + k.length + v.length);
  buf[0] = 0x01;
  buf.set(k, 1);
  buf.set(v, 1 + k.length);
  return buf;
}

function int32Field(key: string, value: number): Uint8Array {
  const k = Buffer.from(key + "\0", "utf-8");
  const buf = Buffer.alloc(1 + k.length + 4);
  buf[0] = 0x02;
  buf.set(k, 1);
  buf.writeInt32LE(value, 1 + k.length);
  return buf;
}

function uint64Field(key: string, value: bigint): Uint8Array {
  const k = Buffer.from(key + "\0", "utf-8");
  const buf = Buffer.alloc(1 + k.length + 8);
  buf[0] = 0x07;
  buf.set(k, 1);
  buf.writeBigUInt64LE(value, 1 + k.length);
  return buf;
}

function objectFieldHeader(key: string): Uint8Array {
  const k = Buffer.from(key + "\0", "utf-8");
  const buf = Buffer.alloc(1 + k.length);
  buf[0] = 0x00;
  buf.set(k, 1);
  return buf;
}

const END = Buffer.from([0x08]);

describe("parseBinaryVdf", () => {
  it("parses a single string entry", () => {
    const out = parseBinaryVdf(buildVdf([strField("name", "Celeste")]));
    expect(out).toEqual({ name: "Celeste" });
  });

  it("parses int32 (positive) and string mixed", () => {
    const out = parseBinaryVdf(
      buildVdf([int32Field("appid", 504230), strField("appname", "Celeste")]),
    );
    expect(out).toEqual({ appid: 504230, appname: "Celeste" });
  });

  it("parses int32 with high bit set as negative (signed)", () => {
    // 0x9959500e — top bit set, so signed-int32 reading is negative.
    // Callers use `value >>> 0` to recover the unsigned form Steam
    // actually stores (see plugins/{game-browser,launch-options}).
    const SIGNED = 0x9959500e | 0; // JS bitwise produces int32-correct signed
    const out = parseBinaryVdf(buildVdf([int32Field("appid", SIGNED)]));
    expect(out.appid as number).toBeLessThan(0);
    expect(out.appid as number).toBe(SIGNED);
    expect((out.appid as number) >>> 0).toBe(0x9959500e >>> 0);
  });

  it("parses uint64 as bigint", () => {
    const id = (0x9959500en << 32n) | 0x02000000n;
    const out = parseBinaryVdf(buildVdf([uint64Field("gameid", id)]));
    expect(out.gameid).toBe(id);
  });

  it("parses a nested object terminated by 0x08", () => {
    // shortcuts -> { 0 -> { appid, appname } }
    const buf = Buffer.concat([
      objectFieldHeader("shortcuts"),
      objectFieldHeader("0"),
      int32Field("appid", 12345),
      strField("appname", "Foo"),
      END, // close "0"
      END, // close "shortcuts"
      END, // close root
    ]);
    const out = parseBinaryVdf(buf);
    expect(out).toEqual({
      shortcuts: { "0": { appid: 12345, appname: "Foo" } },
    });
  });

  it("throws on unknown type byte", () => {
    const buf = Buffer.from([0x99, 0x6b, 0x00, 0x08]);
    expect(() => parseBinaryVdf(buf)).toThrow(/unknown type byte 0x99/);
  });

  it("throws on unterminated key", () => {
    const buf = Buffer.from([0x01, 0x6e, 0x6f, 0x6e]); // 0x01 "non" (no null)
    expect(() => parseBinaryVdf(buf)).toThrow(/unterminated key/);
  });
});

describe("shortcutGameId64", () => {
  // Reference value computed independently via Python:
  //   (0x9959500e << 32) | 0x02000000 = 11049951181823541248
  const APPID_UINT32 = 0x9959500e;
  const APPID_SIGNED = APPID_UINT32 | 0;
  const EXPECTED_GAMEID = ((0x9959500en << 32n) | 0x02000000n).toString();

  it("computes the gameid algebraically: (appid << 32) | 0x02000000", () => {
    expect(shortcutGameId64(APPID_UINT32)).toBe(EXPECTED_GAMEID);
  });

  it("normalises negative signed input to its uint32 form", () => {
    // The parser hands us a negative number when the appid's top bit is
    // set; shortcutGameId64 should treat that as the unsigned uint32.
    expect(shortcutGameId64(APPID_SIGNED)).toBe(EXPECTED_GAMEID);
    expect(APPID_SIGNED).toBeLessThan(0);
  });

  it("matches expected literal for sanity", () => {
    expect(EXPECTED_GAMEID).toBe("11049951181823541248");
  });
});
