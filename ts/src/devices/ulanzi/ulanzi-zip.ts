/** Page-archive writer for the Ulanzi D200: a STORED (method 0) ZIP holding a
 *  `manifest.json` plus one icon (JPEG, or PNG for a png-format model) per key the
 *  host has an image for.
 *
 *  Stored, not deflated, for two reasons: txiki.js exposes no compression API
 *  (`tjs.*` has no zlib), and the icons are already compressed — storing costs ~90 bytes
 *  of header per entry and keeps this writer to a readable size. busybox unzip
 *  (what the firmware runs) verifies CRC-32, so a real CRC is required.
 *
 *  Hardware-tested on macOS — see ulanzi-protocol.ts. */

import { WIDE_KEY_IMAGE_MODE } from '../../shared/wide-key.js';
import {
  FIRST_CHUNK_DATA,
  PACKET_SIZE,
  isBoundaryByteSafe,
  isLengthSafe,
  isPayloadSafe,
} from './ulanzi-protocol.js';
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

/** Max pad candidates tried before shipping the page anyway (plan O8). Each retry
 *  adds one more filler byte, so consecutive candidates test adjacent alignments.
 *  Cheap because the search only inspects boundary bytes (see buildSafeZip). */
export const MAX_PAD_RETRIES = 1024;
const PAD_NAME = new TextEncoder().encode('pad.txt');
/** '.' filler; sliced for the analytic search so no candidate allocates its own. */
const PAD_FILL = 0x2e;
const PAD_BYTES = new Uint8Array(MAX_PAD_RETRIES).fill(PAD_FILL);

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
  /** Mode 2 only: Icon path of an earlier ZIP's window image, referenced without shipping it. */
  windowIconRef?: string;
  /** Monotonic build counter, mixed into every icon path — see iconName(). */
  flushSeq: number;
  /** Boundary-byte escape hatch: bytes of ASCII filler in a leading pad.txt. */
  padBytes?: number;
}

// ── CRC-32 (IEEE, the one ZIP uses) ────────────────────────────────────────
/** Slicing-by-8: row 0 is the classic byte table, row k advances a byte through k
 *  more zero bytes, so eight bytes fold in with eight lookups. */
const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n]!;
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff]! ^ (c >>> 8);
      t[k * 256 + n] = c >>> 0;
    }
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  const t = CRC_TABLE;
  const n = data.length;
  let c = 0xffffffff;
  let i = 0;
  // Word reads need 4-byte alignment; the word loop assumes a little-endian host.
  const head = Math.min(n, (4 - (data.byteOffset & 3)) & 3);
  for (; i < head; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  const words = (n - i) >>> 3;
  if (words > 0) {
    const u = new Uint32Array(data.buffer, data.byteOffset + i, words * 2);
    for (let w = 0; w < u.length; w += 2) {
      const a = u[w]! ^ c;
      const b = u[w + 1]!;
      c =
        t[1792 + (a & 0xff)]! ^
        t[1536 + ((a >>> 8) & 0xff)]! ^
        t[1280 + ((a >>> 16) & 0xff)]! ^
        t[1024 + (a >>> 24)]! ^
        t[768 + (b & 0xff)]! ^
        t[512 + ((b >>> 8) & 0xff)]! ^
        t[256 + ((b >>> 16) & 0xff)]! ^
        t[b >>> 24]!;
    }
    i += words * 8;
  }
  for (; i < n; i++) c = t[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Icon paths must be FRESH on every flush. Two independent implementations
 *  (jcalado mints a randomUUID() per icon per build; glmagalhaes reworked its
 *  naming to Images/<idx>_<uuid>.png after shipping) churn the path on every
 *  push without documenting why; the shared behaviour is strong evidence the
 *  firmware caches decoded pixmaps by path after unzipping into /tmp/icon/, so a
 *  stable `k0.png` would repaint the OLD image. txiki.js has no UUID API, so mix
 *  the slot, the flush counter and the content CRC-32 (already needed for the
 *  ZIP entry, so naming costs no second pass) — deterministic, no crypto
 *  dependency, and collision-free across flushes. Plan O11 checks whether the
 *  churn is actually required. */
export function iconName(slotId: number, flushSeq: number, png: Uint8Array): string {
  // JPEG experiment: the extension follows the bytes (SOI marker FF D8); the
  // black clear-key PNG stays .png.
  const ext = png[0] === 0xff && png[1] === 0xd8 ? 'jpg' : 'png';
  return `Images/${slotId}_${flushSeq}_${digest(png).toString(16).padStart(8, '0')}.${ext}`;
}

/** crc32 costs O(bytes) in interpreted JS, and the same PNG objects are rebuilt into
 *  every full page, so hash each buffer once. Keyed by identity: PNGs are never
 *  mutated after staging. */
const digests = new WeakMap<Uint8Array, number>();
function digest(data: Uint8Array): number {
  let d = digests.get(data);
  if (d === undefined) {
    d = crc32(data);
    digests.set(data, d);
  }
  return d;
}

/** Hash at stage time so the cost hides in the gaps between CORA images instead of
 *  the flush that follows. */
export function warmDigest(data: Uint8Array): void {
  digest(data);
}

/** Grid slot id → the manifest's "{col}_{row}" key (column FIRST). */
export function slotKey(slotId: number, columns: number): string {
  return `${slotId % columns}_${Math.floor(slotId / columns)}`;
}

export interface ZipEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
}

export function entry(name: string, data: Uint8Array, crc: number = crc32(data)): ZipEntry {
  return { name: new TextEncoder().encode(name), data, crc };
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

/** Central directory + EOCD, starting at `off` in `out`. `cdStart` is the directory's
 *  absolute offset in the archive, which differs from `off` when `out` is only a
 *  scratch copy of the tail. Returns the end offset. */
function writeTail(
  out: Buffer,
  off: number,
  cdStart: number,
  entries: ZipEntry[],
  localOffsets: number[],
): number {
  const first = off;
  for (let i = 0; i < entries.length; i++) {
    off = writeCentralHeader(out, off, entries[i]!, localOffsets[i]!);
  }
  const cdSize = off - first;

  out.writeUInt32LE(EOCD_SIG, off);
  out.writeUInt16LE(0, off + 4); // this disk
  out.writeUInt16LE(0, off + 6); // disk with CD
  out.writeUInt16LE(entries.length, off + 8);
  out.writeUInt16LE(entries.length, off + 10);
  out.writeUInt32LE(cdSize, off + 12);
  out.writeUInt32LE(cdStart, off + 16);
  out.writeUInt16LE(0, off + 20); // comment len
  return off + EOCD_SIZE;
}

/** Local-section layout: each entry's offset and where the central directory starts. */
function layout(entries: ZipEntry[]): { localOffsets: number[]; localEnd: number; size: number } {
  const localOffsets: number[] = [];
  let off = 0;
  let size = EOCD_SIZE;
  for (const e of entries) {
    localOffsets.push(off);
    off += LOCAL_HEADER_SIZE + e.name.length + e.data.length;
    size += CENTRAL_HEADER_SIZE + e.name.length;
  }
  return { localOffsets, localEnd: off, size: size + off };
}

/** Assemble a stored-method ZIP from entries, in the given order. */
function writeZip(entries: ZipEntry[]): Buffer {
  const { localOffsets, localEnd, size } = layout(entries);
  const out = Buffer.alloc(size, 0);
  let off = 0;
  for (const e of entries) {
    off = writeLocalHeader(out, off, e);
    out.set(e.data, off);
    off += e.data.length;
  }
  writeTail(out, localEnd, localEnd, entries, localOffsets);
  return out;
}

/** The wide window's image slot, only while it shows a host image (mode 2): in every other
 *  mode the firmware draws the window itself and a staged image would be dead weight. */
function wideImage(slots: PageSlot[], opts: PageZipOptions): PageSlot | undefined {
  if (opts.smallWindowMode !== WIDE_KEY_IMAGE_MODE) return undefined;
  const wideKey = `${opts.smallWindowSlot.col}_${opts.smallWindowSlot.row}`;
  return slots.find((s) => s.png && slotKey(s.slotId, opts.columns) === wideKey);
}

/** Build the manifest JSON for a page.
 *
 *  Dialect: the INTERSECTION of the two firmware generations behind this VID:PID
 *  (Qt/RK3308 `UlanziDeckKey` and ZKSWE/SSD210 EasyUI). Per slot we emit only
 *  `{State, ViewParam:[{Icon, Font, Text}]}`; slots with no image are OMITTED
 *  entirely, because empty entries are documented to break subsequent page
 *  changes on the Qt generation. No `Action` keys: DeckBridge routes every press
 *  itself over CORA, and letting the firmware also act on a press double-fires.
 *  The wide info-window slot always gets an entry carrying `SmallViewMode`; in mode 2
 *  (host image) it also carries the image as its `Icon`. */
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

  const image = wideImage(slots, opts);
  const icon = image?.png ? iconName(image.slotId, opts.flushSeq, image.png) : opts.windowIconRef;
  manifest[wideKey] = {
    State: 0,
    SmallViewMode: opts.smallWindowMode,
    ViewParam: [icon ? { Icon: icon, Font: opts.font, Text: '' } : { Font: opts.font, Text: '' }],
  };

  return JSON.stringify(manifest);
}

/** Every entry except the optional leading pad.txt. Built once per page so a
 *  boundary-byte retry only re-lays-out the archive instead of re-hashing it. */
function pageEntries(slots: PageSlot[], opts: PageZipOptions): ZipEntry[] {
  const entries: ZipEntry[] = [
    entry('manifest.json', new TextEncoder().encode(buildManifest(slots, opts))),
  ];

  const wideKey = `${opts.smallWindowSlot.col}_${opts.smallWindowSlot.row}`;
  const image = wideImage(slots, opts);
  for (const slot of slots) {
    if (!slot.png) continue;
    if (slotKey(slot.slotId, opts.columns) === wideKey && slot !== image) continue;
    entries.push(entry(iconName(slot.slotId, opts.flushSeq, slot.png), slot.png, digest(slot.png)));
  }
  // The firmware can drop the final entry (marcelobrake protocol.md), so it is a throwaway.
  entries.push(entry('sentinel.txt', new Uint8Array(0)));
  return entries;
}

/** `pad.txt` goes FIRST when padding is requested, so its bytes shift every icon
 *  that follows (appending it last is a no-op for the boundary-byte rule —
 *  racerxdl PR #11). */
function assemble(entries: ZipEntry[], padBytes: number): Uint8Array {
  if (padBytes <= 0) return writeZip(entries);
  const pad = entry('pad.txt', new Uint8Array(padBytes).fill(0x2e)); // '.'
  return writeZip([pad, ...entries]);
}

/** Build one page archive. */
export function buildPageZip(slots: PageSlot[], opts: PageZipOptions): Uint8Array {
  return assemble(pageEntries(slots, opts), opts.padBytes ?? 0);
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
  return buildSafeZip(pageEntries(slots, opts));
}

/** CRC-32 register after `p` filler bytes, advanced one byte per call. */
function padCrcStep(c: number): number {
  return CRC_TABLE[(c ^ PAD_FILL) & 0xff]! ^ (c >>> 8);
}

/** Judges pad candidates for one entry list without assembling them.
 *
 *  The local section carries no absolute offsets, so a pad only shifts it: boundary
 *  bytes come from the unpadded archive at shifted offsets, plus a small rebuilt tail
 *  (central directory + EOCD, the only part that changes). */
class PadSearch {
  private readonly localOffsets: number[];
  private readonly localEnd: number;
  private readonly tailLen: number;
  private readonly scratch: Buffer;
  private readonly padded: ZipEntry[];
  private readonly padOffsets: number[];
  private crc = 0xffffffff;

  constructor(
    entries: ZipEntry[],
    private readonly base: Uint8Array,
  ) {
    const l = layout(entries);
    this.localOffsets = l.localOffsets;
    this.localEnd = l.localEnd;
    this.tailLen = l.size - l.localEnd + CENTRAL_HEADER_SIZE + PAD_NAME.length;
    this.scratch = Buffer.alloc(this.tailLen);
    this.padded = [{ name: PAD_NAME, data: PAD_BYTES, crc: 0 }, ...entries];
    this.padOffsets = [0, ...l.localOffsets];
  }

  /** Candidates must be tried with pad = 1, 2, 3, … (the CRC register advances per call). */
  isSafe(pad: number): boolean {
    this.crc = padCrcStep(this.crc);
    const shift = LOCAL_HEADER_SIZE + PAD_NAME.length + pad;
    const tailStart = shift + this.localEnd;
    const total = tailStart + this.tailLen;
    if (!isLengthSafe(total)) return false;
    let tailBuilt = false;
    for (let off = FIRST_CHUNK_DATA; off < total; off += PACKET_SIZE) {
      // off >= 1016 clears pad.txt's 37-byte header, so a pad boundary is always filler.
      let b = PAD_FILL;
      if (off >= tailStart) {
        if (!tailBuilt) {
          this.buildTail(pad, shift, tailStart);
          tailBuilt = true;
        }
        b = this.scratch[off - tailStart]!;
      } else if (off >= shift) {
        b = this.base[off - shift]!;
      }
      if (!isBoundaryByteSafe(b)) return false;
    }
    return true;
  }

  private buildTail(pad: number, shift: number, tailStart: number): void {
    const crc = (this.crc ^ 0xffffffff) >>> 0;
    this.padded[0] = { name: PAD_NAME, data: PAD_BYTES.subarray(0, pad), crc };
    for (let i = 0; i < this.localOffsets.length; i++) {
      this.padOffsets[i + 1] = this.localOffsets[i]! + shift;
    }
    writeTail(this.scratch, 0, tailStart, this.padded, this.padOffsets);
  }
}

/** The pad loop for an arbitrary entry list — the hardware probes build manifests
 *  the driver never emits. Same order and rule as rebuilding the whole archive per
 *  candidate (so the chosen pad is identical), but only the winner is assembled. */
export function buildSafeZip(entries: ZipEntry[]): {
  zip: Uint8Array;
  retries: number;
  safe: boolean;
} {
  const base = writeZip(entries);
  if (isPayloadSafe(base)) return { zip: base, retries: 0, safe: true };

  const search = new PadSearch(entries, base);
  for (let pad = 1; pad <= MAX_PAD_RETRIES; pad++) {
    if (search.isSafe(pad)) return { zip: assemble(entries, pad), retries: pad, safe: true };
  }
  return { zip: base, retries: MAX_PAD_RETRIES, safe: false };
}
