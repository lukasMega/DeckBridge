/** Page-archive writer for the Ulanzi D200: a STORED (method 0) ZIP holding a
 *  `manifest.json` plus one PNG per key the host has an image for.
 *
 *  Stored, not deflated, for two reasons: txiki.js exposes no compression API
 *  (`tjs.*` has no zlib), and PNG is already deflated — storing costs ~90 bytes
 *  of header per entry and keeps this writer to a readable size. busybox unzip
 *  (what the firmware runs) verifies CRC-32, so a real CRC is required.
 *
 *  NOT HARDWARE-TESTED — see ulanzi-protocol.ts. */

import { isPayloadSafe } from './ulanzi-protocol.js';
import type { FontStyle } from './ulanzi-protocol.js';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
/** "Stored, no compression" — the only method we emit. */
const METHOD_STORE = 0;
/** Minimum ZIP version that understands a stored entry. */
const VERSION_STORE = 10;
/** Fixed DOS timestamp (1980-01-01 00:00:00): the firmware ignores mtime and a
 *  constant keeps two builds of the same page byte-identical. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Max boundary-byte rebuild attempts before shipping the page anyway (plan O8).
 *  Each retry adds one more filler byte, so this samples 64 distinct alignments. */
export const MAX_PAD_RETRIES = 64;
/** Bytes of filler added to pad.txt per retry. One, so consecutive retries test
 *  adjacent alignments rather than skipping 7 of every 8. */
const PAD_STEP_BYTES = 1;

export interface PageSlot {
  slotId: number;
  png?: Uint8Array;
  text?: string;
}

export interface PageZipOptions {
  /** Grid width, for the manifest's "{col}_{row}" keys (col FIRST). */
  columns: number;
  /** Firmware render mode written onto the wide info-window entry. */
  smallWindowMode: number;
  /** Grid position of that wide slot. */
  smallWindowSlot: { col: number; row: number };
  font: FontStyle;
  /** Monotonic build counter, mixed into every icon path — see iconName(). */
  flushSeq: number;
  /** Boundary-byte escape hatch: bytes of ASCII filler in a leading pad.txt. */
  padBytes?: number;
}

// ── CRC-32 (IEEE, the one ZIP uses) ────────────────────────────────────────
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ (data[i] ?? 0)) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** FNV-1a 32-bit — content tag for icon paths. Not security-relevant; it only
 *  has to differ when the bytes differ. */
export function fnv1a(data: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i] ?? 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Icon paths must be FRESH on every flush. Two independent implementations
 *  (jcalado mints a randomUUID() per icon per build; glmagalhaes reworked its
 *  naming to Images/<idx>_<uuid>.png after shipping) churn the path on every
 *  push without documenting why; the shared behaviour is strong evidence the
 *  firmware caches decoded pixmaps by path after unzipping into /tmp/icon/, so a
 *  stable `k0.png` would repaint the OLD image. txiki.js has no UUID API, so mix
 *  the slot, the flush counter and a content hash — deterministic, no crypto
 *  dependency, and collision-free across flushes. Plan O11 checks whether the
 *  churn is actually required. */
export function iconName(slotId: number, flushSeq: number, png: Uint8Array): string {
  return `Images/${slotId}_${flushSeq}_${fnv1a(png).toString(16).padStart(8, '0')}.png`;
}

/** Grid slot id → the manifest's "{col}_{row}" key (column FIRST). */
export function slotKey(slotId: number, columns: number): string {
  return `${slotId % columns}_${Math.floor(slotId / columns)}`;
}

interface ZipEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
}

function entry(name: string, data: Uint8Array): ZipEntry {
  return { name: new TextEncoder().encode(name), data, crc: crc32(data) };
}

function writeLocalHeader(out: Buffer, off: number, e: ZipEntry): number {
  out.writeUInt32LE(LOCAL_SIG, off);
  out.writeUInt16LE(VERSION_STORE, off + 4);
  out.writeUInt16LE(0, off + 6); // flags
  out.writeUInt16LE(METHOD_STORE, off + 8);
  out.writeUInt16LE(DOS_TIME, off + 10);
  out.writeUInt16LE(DOS_DATE, off + 12);
  out.writeUInt32LE(e.crc, off + 14);
  out.writeUInt32LE(e.data.length, off + 18); // compressed == uncompressed
  out.writeUInt32LE(e.data.length, off + 22);
  out.writeUInt16LE(e.name.length, off + 26);
  out.writeUInt16LE(0, off + 28); // extra len
  out.set(e.name, off + LOCAL_HEADER_SIZE);
  return off + LOCAL_HEADER_SIZE + e.name.length;
}

function writeCentralHeader(out: Buffer, off: number, e: ZipEntry, localOff: number): number {
  out.writeUInt32LE(CENTRAL_SIG, off);
  out.writeUInt16LE(VERSION_STORE, off + 4); // version made by
  out.writeUInt16LE(VERSION_STORE, off + 6); // version needed
  out.writeUInt16LE(0, off + 8); // flags
  out.writeUInt16LE(METHOD_STORE, off + 10);
  out.writeUInt16LE(DOS_TIME, off + 12);
  out.writeUInt16LE(DOS_DATE, off + 14);
  out.writeUInt32LE(e.crc, off + 16);
  out.writeUInt32LE(e.data.length, off + 20);
  out.writeUInt32LE(e.data.length, off + 24);
  out.writeUInt16LE(e.name.length, off + 28);
  out.writeUInt16LE(0, off + 30); // extra len
  out.writeUInt16LE(0, off + 32); // comment len
  out.writeUInt16LE(0, off + 34); // disk number start
  out.writeUInt16LE(0, off + 36); // internal attrs
  out.writeUInt32LE(0, off + 38); // external attrs
  out.writeUInt32LE(localOff, off + 42);
  out.set(e.name, off + CENTRAL_HEADER_SIZE);
  return off + CENTRAL_HEADER_SIZE + e.name.length;
}

/** Assemble a stored-method ZIP from entries, in the given order. */
function writeZip(entries: ZipEntry[]): Uint8Array {
  let size = EOCD_SIZE;
  for (const e of entries) {
    size += LOCAL_HEADER_SIZE + e.name.length + e.data.length;
    size += CENTRAL_HEADER_SIZE + e.name.length;
  }
  const out = Buffer.alloc(size, 0);

  const localOffsets: number[] = [];
  let off = 0;
  for (const e of entries) {
    localOffsets.push(off);
    off = writeLocalHeader(out, off, e);
    out.set(e.data, off);
    off += e.data.length;
  }

  const cdStart = off;
  for (let i = 0; i < entries.length; i++) {
    off = writeCentralHeader(out, off, entries[i]!, localOffsets[i]!);
  }
  const cdSize = off - cdStart;

  out.writeUInt32LE(EOCD_SIG, off);
  out.writeUInt16LE(0, off + 4); // this disk
  out.writeUInt16LE(0, off + 6); // disk with CD
  out.writeUInt16LE(entries.length, off + 8);
  out.writeUInt16LE(entries.length, off + 10);
  out.writeUInt32LE(cdSize, off + 12);
  out.writeUInt32LE(cdStart, off + 16);
  out.writeUInt16LE(0, off + 20); // comment len
  return out;
}

/** Build the manifest JSON for a page.
 *
 *  Dialect: the INTERSECTION of the two firmware generations behind this VID:PID
 *  (Qt/RK3308 `UlanziDeckKey` and ZKSWE/SSD210 EasyUI). Per slot we emit only
 *  `{State, ViewParam:[{Icon, Font, Text}]}`; slots with no image are OMITTED
 *  entirely, because empty entries are documented to break subsequent page
 *  changes on the Qt generation. No `Action` keys: DeckBridge routes every press
 *  itself over CORA, and letting the firmware also act on a press double-fires.
 *  The wide info-window slot always gets an entry carrying `SmallViewMode`. */
export function buildManifest(slots: PageSlot[], opts: PageZipOptions): string {
  const manifest: Record<string, unknown> = {};
  const wideKey = `${opts.smallWindowSlot.col}_${opts.smallWindowSlot.row}`;

  for (const slot of slots) {
    if (!slot.png) continue;
    const key = slotKey(slot.slotId, opts.columns);
    if (key === wideKey) continue; // owned by the info-window entry below
    manifest[key] = {
      State: 0,
      ViewParam: [
        {
          Icon: iconName(slot.slotId, opts.flushSeq, slot.png),
          Font: opts.font,
          Text: slot.text ?? '',
        },
      ],
    };
  }

  manifest[wideKey] = {
    State: 0,
    SmallViewMode: opts.smallWindowMode,
    ViewParam: [{ Font: opts.font, Text: '' }],
  };

  return JSON.stringify(manifest);
}

/** Build one page archive. Entry order is deliberate: `pad.txt` FIRST when
 *  padding is requested, so its bytes shift every icon that follows (appending
 *  it last is a no-op for the boundary-byte rule — racerxdl PR #11). */
export function buildPageZip(slots: PageSlot[], opts: PageZipOptions): Uint8Array {
  const entries: ZipEntry[] = [];

  const padBytes = opts.padBytes ?? 0;
  if (padBytes > 0) {
    entries.push(entry('pad.txt', new Uint8Array(padBytes).fill(0x2e))); // '.'
  }

  entries.push(entry('manifest.json', new TextEncoder().encode(buildManifest(slots, opts))));

  const wideKey = `${opts.smallWindowSlot.col}_${opts.smallWindowSlot.row}`;
  for (const slot of slots) {
    if (!slot.png) continue;
    if (slotKey(slot.slotId, opts.columns) === wideKey) continue;
    entries.push(entry(iconName(slot.slotId, opts.flushSeq, slot.png), slot.png));
  }

  return writeZip(entries);
}

/** Build a page archive whose bytes satisfy the chunk-boundary rule
 *  (see isPayloadSafe), growing a leading pad.txt until they do.
 *
 *  `retries` is 0 on the common path and is logged by the driver: a counter that
 *  never leaves 0 on real hardware means the workaround can be deleted (O8).
 *
 *  Convergence is probabilistic, not guaranteed: every boundary has to be safe
 *  at the SAME alignment, and one shift moves all of them together. Real pages
 *  converge easily (PNG payloads are deflate-compressed, so a given boundary
 *  byte is unsafe with probability ~2/256 and a page has ~180 of them), but a
 *  payload with long constant runs of 0x00 can pin a boundary at every offset we
 *  try. In that case we ship the unpadded archive and flag it rather than
 *  throwing: refusing to render leaves the panel blank, which is strictly worse
 *  than sending an archive that MIGHT tear — and per aleyvag the whole hazard
 *  may not exist for a writer that prepends the report-id byte, as ours does. */
export function buildSafePageZip(
  slots: PageSlot[],
  opts: PageZipOptions,
): { zip: Uint8Array; retries: number; safe: boolean } {
  let first: Uint8Array | null = null;
  for (let retry = 0; retry <= MAX_PAD_RETRIES; retry++) {
    const zip = buildPageZip(slots, { ...opts, padBytes: retry * PAD_STEP_BYTES });
    if (isPayloadSafe(zip)) return { zip, retries: retry, safe: true };
    first ??= zip;
  }
  return { zip: first!, retries: MAX_PAD_RETRIES, safe: false };
}
