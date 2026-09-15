/** Decoding for hidapi's `wchar_t*` strings. Split out of hidapi.ts only to keep
 *  that file under the 500-line cap (mise run check-loc). */
import FFI from 'tjs:ffi';
import { isNullPtr, type HidapiSymbols } from './hidapi.js';

/** Bytes per `wchar_t`: 2 on Windows (UTF-16), 4 elsewhere (UTF-32). */
const WCHAR_BYTES = FFI.suffix === 'dll' ? 2 : 4;

/** Longest hid_error() message we bother decoding — hidapi's are one short sentence. */
const WIDE_STR_MAX_CHARS = 256;

/** Decode a NUL-terminated `wchar_t*`. Reading one code unit at a time is the only
 *  option tjs:ffi gives us (no bulk memory read), and these strings are short and
 *  only ever read on an error path.
 *
 *  Needed because a `wchar_t*` read as a C string stops at the first NUL **byte**:
 *  every message truncated to its first character ("Device disconnected" → "D"),
 *  which is exactly the diagnostic you want intact when hardware misbehaves. */
export function readWideString(ptr: unknown, maxChars = WIDE_STR_MAX_CHARS): string | null {
  if (isNullPtr(ptr)) return null;
  const at = ptr as { offset(byteCount: number): unknown };
  const units: number[] = [];
  for (let i = 0; i < maxChars; i++) {
    const code = readUnit(at.offset(i * WCHAR_BYTES));
    if (code === 0) break;
    units.push(code);
  }
  return units.length === 0 ? null : unitsToString(units);
}

function readUnit(ptr: unknown): number {
  return WCHAR_BYTES === 2 ? FFI.read.u16(ptr) : FFI.read.u32(ptr);
}

/** UTF-32 code points are valid fromCodePoint input, as are the UTF-16 units of the
 *  ASCII-range text hidapi emits. A corrupt read (out-of-range value) throws, and
 *  falls back to a hex dump rather than losing the evidence entirely. */
function unitsToString(units: number[]): string {
  try {
    return String.fromCodePoint(...units);
  } catch {
    return units.map((u) => u.toString(16)).join(' ');
  }
}

/** hidapi's last error for `device` as a readable string, never empty. */
export function hidErrorString(hid: HidapiSymbols, device: unknown): string {
  try {
    return readWideString(hid.hid_error(device)) ?? 'unknown';
  } catch (e) {
    return `unknown (hid_error threw: ${String(e)})`;
  }
}
