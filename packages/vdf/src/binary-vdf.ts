/**
 * Binary VDF parser.
 *
 * Steam uses a compact binary VDF (a.k.a. "appinfo" format) for some files
 * in the userdata tree — most notably `shortcuts.vdf`, which holds
 * non-Steam app entries (added via "Add a non-Steam game" or by tools
 * like EmuDeck).
 *
 * Layout: a flat byte stream where each entry is
 *   <type-byte> <null-terminated key> <value>
 * inside an implicit root object. Nested objects use a recursive entry list
 * terminated by `0x08`. Top-level termination is also `0x08` at the end.
 *
 * Type bytes seen in the wild:
 *   0x00  object   — value is a recursive entry list ended by 0x08
 *   0x01  string   — value is a null-terminated UTF-8 string
 *   0x02  int32    — value is a 4-byte little-endian signed int
 *   0x07  uint64   — value is an 8-byte little-endian unsigned int
 *   0x08  end      — closes the current object
 *   (0x09 occurs as an alternate end marker in some old dumps; treated as 0x08)
 *
 * The parser is permissive about the top-level wrapper: we read entries
 * directly into a root object until the buffer ends or we hit a stray 0x08.
 *
 * Numbers are returned as JS numbers (int32) or `bigint` (uint64). Callers
 * that want unsigned 32-bit appids should do `(value >>> 0)` themselves —
 * we don't apply that here because the parser shouldn't presume what the
 * field means.
 */

const TYPE_OBJECT = 0x00;
const TYPE_STRING = 0x01;
const TYPE_INT32 = 0x02;
const TYPE_UINT64 = 0x07;
const TYPE_END = 0x08;
const TYPE_END_ALT = 0x09;

export type BinaryVdfValue =
  | string
  | number
  | bigint
  | { [key: string]: BinaryVdfValue };

export interface BinaryVdfObject {
  [key: string]: BinaryVdfValue;
}

/**
 * Parse a binary VDF buffer into a nested JS object.
 *
 * Throws on truncated buffers, unknown type bytes, or non-UTF-8 keys.
 */
export function parseBinaryVdf(buf: Buffer | Uint8Array): BinaryVdfObject {
  const view = buf instanceof Buffer ? buf : Buffer.from(buf);
  let offset = 0;

  function readKey(): string {
    const start = offset;
    while (offset < view.length && view[offset] !== 0) offset++;
    if (offset >= view.length) {
      throw new Error(
        `binary VDF: unterminated key string starting at offset ${start}`,
      );
    }
    const key = view.toString("utf-8", start, offset);
    offset++; // consume the null terminator
    return key;
  }

  function readString(): string {
    const start = offset;
    while (offset < view.length && view[offset] !== 0) offset++;
    if (offset >= view.length) {
      throw new Error(
        `binary VDF: unterminated string value starting at offset ${start}`,
      );
    }
    const s = view.toString("utf-8", start, offset);
    offset++;
    return s;
  }

  function readObject(): BinaryVdfObject {
    const obj: BinaryVdfObject = {};
    while (offset < view.length) {
      const type = view[offset++]!; // offset < view.length, so in bounds
      if (type === TYPE_END || type === TYPE_END_ALT) {
        return obj;
      }

      const key = readKey();

      switch (type) {
        case TYPE_OBJECT:
          obj[key] = readObject();
          break;
        case TYPE_STRING:
          obj[key] = readString();
          break;
        case TYPE_INT32: {
          if (offset + 4 > view.length) {
            throw new Error(
              `binary VDF: truncated int32 for key "${key}" at offset ${offset}`,
            );
          }
          obj[key] = view.readInt32LE(offset);
          offset += 4;
          break;
        }
        case TYPE_UINT64: {
          if (offset + 8 > view.length) {
            throw new Error(
              `binary VDF: truncated uint64 for key "${key}" at offset ${offset}`,
            );
          }
          obj[key] = view.readBigUInt64LE(offset);
          offset += 8;
          break;
        }
        default:
          throw new Error(
            `binary VDF: unknown type byte 0x${type
              .toString(16)
              .padStart(2, "0")} for key "${key}" at offset ${offset - 1}`,
          );
      }
    }
    return obj;
  }

  return readObject();
}

/**
 * Compute Steam's 64-bit `gameid` for a non-Steam shortcut, given the
 * shortcut's 32-bit appid (as stored in `shortcuts.vdf`).
 *
 *   gameid64 = (appid << 32) | 0x02000000
 *
 * Used as the filename stem under `userdata/<id>/config/grid/` when
 * locating user-installed local artwork (header / capsule / hero / logo)
 * for non-Steam apps.
 *
 * Returned as a decimal string because the value exceeds JS's safe-integer
 * range (>2^53) once the high 32 bits are populated.
 */
export function shortcutGameId64(appIdUint32: number): string {
  const id = (BigInt(appIdUint32 >>> 0) << 32n) | 0x02000000n;
  return id.toString();
}
