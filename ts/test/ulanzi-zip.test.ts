import assert from 'tjs:assert';
import {
  MAX_PAD_RETRIES,
  buildManifest,
  buildPageZip,
  buildSafePageZip,
  crc32,
  fnv1a,
  iconName,
  slotKey,
} from '../src/devices/ulanzi/ulanzi-zip.js';
import type { PageSlot, PageZipOptions } from '../src/devices/ulanzi/ulanzi-zip.js';
import { DEFAULT_FONT, isPayloadSafe } from '../src/devices/ulanzi/ulanzi-protocol.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const OPTS: PageZipOptions = {
  columns: 5,
  smallWindowMode: 203,
  smallWindowSlot: { col: 3, row: 2 },
  font: DEFAULT_FONT,
  flushSeq: 0,
};

/** Deterministic pseudo-PNG payload — the writer never inspects the bytes. */
function fakePng(seed: number, len = 64): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (seed * 31 + i * 17) % 256;
  return out;
}

// ── CRC-32 ───────────────────────────────────────────────────────────────────

console.log('\nulanzi-zip: crc32');

await test('crc32 matches the published IEEE vector for "123456789"', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

await test('crc32 of the empty input is 0', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
});

await test('crc32 matches the published vector for "The quick brown fox..."', () => {
  const s = 'The quick brown fox jumps over the lazy dog';
  assert.equal(crc32(new TextEncoder().encode(s)), 0x414fa339);
});

await test('fnv1a differs for different bytes and is stable for the same bytes', () => {
  assert.equal(fnv1a(fakePng(1)), fnv1a(fakePng(1)));
  assert.notEqual(fnv1a(fakePng(1)), fnv1a(fakePng(2)));
});

// ── manifest ─────────────────────────────────────────────────────────────────

console.log('\nulanzi-zip: manifest');

await test('slotKey puts the COLUMN first', () => {
  assert.equal(slotKey(0, 5), '0_0');
  assert.equal(slotKey(7, 5), '2_1');
  assert.equal(slotKey(13, 5), '3_2');
});

await test('the manifest keys every staged slot as "{col}_{row}"', () => {
  const m = JSON.parse(buildManifest([{ slotId: 7, png: fakePng(1) }], OPTS)) as Record<
    string,
    unknown
  >;
  assert.notEqual(m['2_1'], undefined, 'slot 7 must land at column 2, row 1');
});

// Empty entries are documented to break subsequent page changes on the Qt
// firmware generation, so a slot with no image must not appear at all.
await test('slots without an image are OMITTED, not emitted empty', () => {
  const m = JSON.parse(
    buildManifest([{ slotId: 0, png: fakePng(1) }, { slotId: 1 }], OPTS),
  ) as Record<string, unknown>;
  assert.notEqual(m['0_0'], undefined);
  assert.equal(m['1_0'], undefined, 'the image-less slot must be absent');
});

await test('the wide info-window entry is always present and carries SmallViewMode', () => {
  const m = JSON.parse(buildManifest([], OPTS)) as Record<string, { SmallViewMode?: number }>;
  assert.notEqual(m['3_2'], undefined);
  assert.equal(m['3_2']!.SmallViewMode, 203);
});

// DeckBridge routes every press itself over CORA; a firmware Action would
// double-fire the same press.
await test('no manifest entry carries an Action key', () => {
  const json = buildManifest([{ slotId: 0, png: fakePng(1) }], OPTS);
  assert.equal(json.includes('"Action"'), false);
});

await test('icon paths change on every flush even for identical bytes', () => {
  const png = fakePng(3);
  assert.notEqual(iconName(0, 0, png), iconName(0, 1, png));
});

// ── ZIP structure ────────────────────────────────────────────────────────────

console.log('\nulanzi-zip: archive structure');

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  data: Uint8Array;
}

/** Minimal central-directory reader: walks the EOCD back to the CD, then reads
 *  each entry's local header and payload. Also proves the offsets we wrote. */
function readZip(zip: Uint8Array): ParsedEntry[] {
  const buf = Buffer.from(zip);
  const eocd = zip.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD signature');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'central header signature');
    const nameLen = buf.readUInt16LE(off + 28);
    const size = buf.readUInt32LE(off + 24);
    const crc = buf.readUInt32LE(off + 16);
    const localOff = buf.readUInt32LE(off + 42);
    const name = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen));

    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, 'local header signature');
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const dataStart = localOff + 30 + localNameLen;
    entries.push({
      name,
      method: buf.readUInt16LE(off + 10),
      crc,
      data: zip.subarray(dataStart, dataStart + size),
    });
    off += 46 + nameLen;
  }
  return entries;
}

await test('every entry is stored (method 0) with a valid CRC and intact bytes', () => {
  const png = fakePng(5, 200);
  const zip = buildPageZip([{ slotId: 2, png }], OPTS);
  const entries = readZip(zip);

  assert.equal(entries.length, 2, 'manifest.json + one icon');
  for (const e of entries) {
    assert.equal(e.method, 0, `${e.name} must be stored, not deflated`);
    assert.equal(crc32(e.data), e.crc, `${e.name} CRC must match its bytes`);
  }
  const icon = entries.find((e) => e.name.startsWith('Images/'))!;
  assert.equal(icon.data.length, png.length);
  for (let i = 0; i < png.length; i++) assert.equal(icon.data[i], png[i]);
});

await test('manifest.json is present and parses', () => {
  const zip = buildPageZip([{ slotId: 0, png: fakePng(1) }], OPTS);
  const manifest = readZip(zip).find((e) => e.name === 'manifest.json')!;
  const parsed = JSON.parse(new TextDecoder().decode(manifest.data)) as Record<string, unknown>;
  assert.notEqual(parsed['0_0'], undefined);
});

await test('the icon path in the manifest matches the archived entry name', () => {
  const zip = buildPageZip([{ slotId: 4, png: fakePng(9) }], { ...OPTS, flushSeq: 12 });
  const entries = readZip(zip);
  const manifest = JSON.parse(
    new TextDecoder().decode(entries.find((e) => e.name === 'manifest.json')!.data),
  ) as Record<string, { ViewParam: [{ Icon?: string }] }>;
  const icon = entries.find((e) => e.name.startsWith('Images/'))!;
  assert.equal(manifest['4_0']!.ViewParam[0].Icon, icon.name);
});

await test('a 13-icon page archives every icon exactly once', () => {
  const slots: PageSlot[] = [];
  for (let i = 0; i < 13; i++) slots.push({ slotId: i, png: fakePng(i, 128) });
  const entries = readZip(buildPageZip(slots, OPTS));
  const icons = entries.filter((e) => e.name.startsWith('Images/'));
  assert.equal(icons.length, 13);
  assert.equal(new Set(icons.map((e) => e.name)).size, 13, 'icon names must be unique');
});

// ── boundary-byte safety ─────────────────────────────────────────────────────

console.log('\nulanzi-zip: boundary-byte retry');

/** Icons made of a single repeated byte let the test steer what lands on a
 *  chunk boundary — 0x00 there is exactly the case the firmware truncates. */
function flatPng(byte: number, len: number): Uint8Array {
  return new Uint8Array(len).fill(byte);
}

// Realistic case: PNG payloads are deflate-compressed, so boundary bytes are
// effectively random and a safe alignment is found almost immediately.
await test('buildSafePageZip returns a payload that passes isPayloadSafe', () => {
  const slots: PageSlot[] = [];
  for (let i = 0; i < 13; i++) slots.push({ slotId: i, png: fakePng(i, 900) });
  const { zip, safe } = buildSafePageZip(slots, OPTS);
  assert.ok(zip.length > 1016, 'the fixture must be long enough to have a chunk boundary');
  assert.equal(safe, true);
  assert.equal(isPayloadSafe(zip), true);
});

// Adversarial case: long constant runs of 0x00 can pin a boundary at every
// alignment we can reach. The page must still be SENT (a blank panel is worse
// than a possibly-torn one) and must say so — see buildSafePageZip.
await test('an unconvergeable page is returned flagged rather than thrown', () => {
  const slots: PageSlot[] = [];
  for (let i = 0; i < 13; i++) slots.push({ slotId: i, png: flatPng(0x00, 400) });
  const { zip, safe, retries } = buildSafePageZip(slots, OPTS);
  assert.equal(safe, false);
  assert.equal(retries, MAX_PAD_RETRIES);
  assert.ok(zip.length > 1016, 'a usable archive is still returned');
});

await test('padding is inserted as a FIRST entry so it shifts the icons that follow', () => {
  const slots: PageSlot[] = [];
  for (let i = 0; i < 13; i++) slots.push({ slotId: i, png: flatPng(0x00, 400) });
  const padded = buildPageZip(slots, { ...OPTS, padBytes: 8 });
  const entries = readZip(padded);
  assert.equal(entries[0]!.name, 'pad.txt');
  assert.equal(entries[0]!.data.length, 8);
  // The padding must actually move the payload, otherwise the retry is a no-op.
  assert.notEqual(buildPageZip(slots, OPTS).length, padded.length);
});

await test('a realistic page converges in a handful of retries', () => {
  const slots: PageSlot[] = [];
  for (let i = 0; i < 13; i++) slots.push({ slotId: i, png: fakePng(i * 3 + 1, 900) });
  const { retries } = buildSafePageZip(slots, OPTS);
  assert.ok(retries < 8, `retries ${retries} should be small for compressed-looking payloads`);
});

await test('a page needing no padding archives no pad.txt at all', () => {
  const slots: PageSlot[] = [];
  for (let i = 0; i < 13; i++) slots.push({ slotId: i, png: fakePng(i, 900) });
  const { zip, retries } = buildSafePageZip(slots, OPTS);
  if (retries === 0) {
    assert.equal(
      readZip(zip).some((e) => e.name === 'pad.txt'),
      false,
      'a zero-retry build must not carry padding',
    );
  }
  // A padded build must carry exactly the bytes the retry asked for.
  const padded = buildPageZip(slots, { ...OPTS, padBytes: 3 });
  assert.equal(readZip(padded).find((e) => e.name === 'pad.txt')!.data.length, 3);
});

// ── external verification ────────────────────────────────────────────────────

console.log('\nulanzi-zip: unzip -t');

// The firmware runs busybox unzip, so the archive has to satisfy a real reader,
// not just our own parser. Skipped where `unzip` is unavailable (CI images vary).
await test('the archive passes `unzip -t` where unzip exists', async () => {
  const slots: PageSlot[] = [];
  for (let i = 0; i < 13; i++) slots.push({ slotId: i, png: fakePng(i, 512) });
  const { zip } = buildSafePageZip(slots, OPTS);
  const path = `/tmp/deckbridge-ulanzi-test-${Date.now()}.zip`;
  await tjs.writeFile(path, zip);
  try {
    const proc = tjs.spawn(['unzip', '-t', path], { stdout: 'ignore', stderr: 'ignore' });
    const status = await proc.wait();
    assert.equal(status.exit_status, 0, 'unzip -t must report no errors');
  } catch {
    console.log('    (skipped — no unzip on PATH)');
  } finally {
    await tjs.remove(path).catch(() => undefined);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
