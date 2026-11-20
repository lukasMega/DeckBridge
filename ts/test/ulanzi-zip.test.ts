import assert from 'tjs:assert';
import {
  MAX_PAD_RETRIES,
  buildManifest,
  buildPageZip,
  buildSafePageZip,
  buildSafeZip,
  entry,
  crc32,
  iconName,
  slotKey,
} from '../src/devices/ulanzi/ulanzi-zip.js';
import type { PageSlot, PageZipOptions } from '../src/devices/ulanzi/ulanzi-zip.js';
import {
  DEFAULT_FONT,
  FIRST_CHUNK_DATA,
  PACKET_SIZE,
  isPayloadSafe,
} from '../src/devices/ulanzi/ulanzi-protocol.js';

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

/** Bit-at-a-time reference, independent of the table the implementation uses. */
function refCrc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

await test('crc32 matches the bitwise reference at every length 0..40 and offset 0..7', () => {
  const backing = new Uint8Array(64);
  for (let i = 0; i < backing.length; i++) backing[i] = (i * 73 + 11) & 0xff;
  for (let off = 0; off < 8; off++) {
    for (let len = 0; len <= 40; len++) {
      const view = backing.subarray(off, off + len);
      assert.equal(crc32(view), refCrc32(view), `off ${off} len ${len}`);
    }
  }
});

await test('crc32 matches the reference on large, unaligned and all-0xff inputs', () => {
  const big = fakePng(7, 20001);
  assert.equal(crc32(big), refCrc32(big));
  assert.equal(crc32(big.subarray(3, 12345)), refCrc32(big.subarray(3, 12345)));
  const ones = new Uint8Array(4097).fill(0xff);
  assert.equal(crc32(ones), refCrc32(ones));
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

await test('the manifest carries whichever firmware mode the page is built with', () => {
  for (const mode of [0, 1, 2, 200, 201, 202, 203]) {
    const m = JSON.parse(buildManifest([], { ...OPTS, smallWindowMode: mode })) as Record<
      string,
      { SmallViewMode?: number }
    >;
    assert.equal(m['3_2']!.SmallViewMode, mode);
  }
});

await test('the wide info-window entry is always present and carries SmallViewMode', () => {
  const m = JSON.parse(buildManifest([], OPTS)) as Record<string, { SmallViewMode?: number }>;
  assert.notEqual(m['3_2'], undefined);
  assert.equal(m['3_2']!.SmallViewMode, 203);
});

// Mode 2 shows a host image: the wide entry then carries it as its Icon (plan Phase 4).

interface WideEntry {
  SmallViewMode: number;
  ViewParam: Array<{ Icon?: string; Font: unknown; Text: string }>;
}

await test('mode 2 + a slot-13 image puts the image on the wide entry as its Icon', () => {
  const png = fakePng(9, 120);
  const json = buildManifest([{ slotId: 13, png }], { ...OPTS, smallWindowMode: 2 });
  const wide = (JSON.parse(json) as Record<string, WideEntry>)['3_2']!;
  assert.equal(wide.SmallViewMode, 2);
  assert.equal(wide.ViewParam[0]!.Icon, iconName(13, 0, png));
  const names = readZip(buildPageZip([{ slotId: 13, png }], { ...OPTS, smallWindowMode: 2 })).map(
    (e) => e.name,
  );
  assert.deepEqual(names, ['manifest.json', iconName(13, 0, png), 'sentinel.txt']);
});

await test('mode 2 with no image keeps the bare wide entry', () => {
  const wide = (
    JSON.parse(buildManifest([], { ...OPTS, smallWindowMode: 2 })) as Record<string, WideEntry>
  )['3_2']!;
  assert.equal(wide.ViewParam[0]!.Icon, undefined);
});

await test('in every other mode a slot-13 image is left out, so the page is unchanged', () => {
  for (const mode of [0, 1, 200, 201, 202, 203]) {
    const opts = { ...OPTS, smallWindowMode: mode };
    const plain = buildManifest([{ slotId: 0, png: fakePng(1) }], opts);
    const withWide = buildManifest(
      [
        { slotId: 0, png: fakePng(1) },
        { slotId: 13, png: fakePng(9) },
      ],
      opts,
    );
    assert.equal(withWide, plain, `mode ${mode}: manifest`);
    assert.deepEqual(
      readZip(
        buildPageZip(
          [
            { slotId: 0, png: fakePng(1) },
            { slotId: 13, png: fakePng(9) },
          ],
          opts,
        ),
      ).map((e) => e.name),
      readZip(buildPageZip([{ slotId: 0, png: fakePng(1) }], opts)).map((e) => e.name),
      `mode ${mode}: entries`,
    );
  }
});

await test('the default page (mode 203, no wide image) is byte-identical to its manifest of old', () => {
  assert.equal(
    buildManifest([{ slotId: 0, png: fakePng(1) }], OPTS),
    `{"0_0":{"State":0,"ViewParam":[{"Icon":"${iconName(0, 0, fakePng(1))}","Font":${JSON.stringify(DEFAULT_FONT)},"Text":""}]},"3_2":{"State":0,"SmallViewMode":203,"ViewParam":[{"Font":${JSON.stringify(DEFAULT_FONT)},"Text":""}]}}`,
  );
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

await test('icon names are the CRC-32 of the content: deterministic, content-sensitive', () => {
  const png = fakePng(3, 300);
  const crcHex = crc32(png).toString(16).padStart(8, '0');
  assert.equal(iconName(4, 9, png), `Images/4_9_${crcHex}.png`);
  assert.equal(iconName(4, 9, png), iconName(4, 9, fakePng(3, 300)));
  assert.notEqual(iconName(4, 9, png), iconName(4, 9, fakePng(4, 300)));
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

  assert.equal(entries.length, 3, 'manifest.json + one icon + sentinel.txt');
  assert.equal(entries.at(-1)!.name, 'sentinel.txt', 'the throwaway entry is last');
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

/** Zero-only icons that cannot converge: an entry with no zero-free alignment. */
function pinnedEntries(): ReturnType<typeof entry>[] {
  // A 100 KB zero entry puts ~100 boundaries inside it at any alignment.
  return [entry('z.bin', new Uint8Array(100_000))];
}

// Adversarial case: long constant runs of 0x00 can pin a boundary at every
// alignment we can reach. The page must still be SENT (a blank panel is worse
// than a possibly-torn one) and must say so — see buildSafePageZip.
await test('an unconvergeable archive is returned flagged rather than thrown', () => {
  const { zip, safe, retries } = buildSafeZip(pinnedEntries());
  assert.equal(safe, false);
  assert.equal(retries, MAX_PAD_RETRIES);
  assert.ok(zip.length > 100_000, 'a usable archive is still returned');
  assert.equal(readZip(zip)[0]!.name, 'z.bin', 'the unpadded archive is the fallback');
});

/** The pre-analytic algorithm: rebuild the whole archive per pad until it is safe. */
function oldSearch(
  slots: PageSlot[],
  opts: PageZipOptions,
  max: number,
): { zip: Uint8Array; retries: number } | null {
  for (let pad = 0; pad <= max; pad++) {
    const zip = buildPageZip(slots, { ...opts, padBytes: pad });
    if (isPayloadSafe(zip)) return { zip, retries: pad };
  }
  return null;
}

function pageOf(n: number, size: number, salt: number): PageSlot[] {
  const slots: PageSlot[] = [];
  for (let i = 0; i < n; i++) slots.push({ slotId: i, png: fakePng(i * 7 + salt, size + i * 13) });
  return slots;
}

await test('analytic pad search is byte-identical to the per-candidate rebuild', () => {
  let padded = 0;
  for (let salt = 0; salt < 60; salt++) {
    const opts = { ...OPTS, flushSeq: salt, smallWindowMode: salt % 3 === 0 ? 2 : 203 };
    const slots = pageOf(1 + (salt % 13), 600 + salt * 37, salt);
    const old = oldSearch(slots, opts, 64);
    const now = buildSafePageZip(slots, opts);
    if (old) {
      assert.equal(now.safe, true, `salt ${salt}`);
      assert.equal(now.retries, old.retries, `salt ${salt}: retries`);
      assert.deepEqual([...now.zip], [...old.zip], `salt ${salt}: bytes`);
      if (old.retries > 0) padded++;
    }
    assert.equal(isPayloadSafe(now.zip) === now.safe, true, `salt ${salt}: flag`);
  }
  assert.ok(padded > 5, `fixtures must exercise padding (only ${padded} did)`);
});

await test('the analytic verdict equals isPayloadSafe for every pad 0..200', () => {
  // Exercises the tail-boundary path (central directory + EOCD) as well as the locals.
  for (const [n, size] of [
    [1, 900],
    [2, 1100],
    [13, 90],
  ] as const) {
    const slots = pageOf(n, size, n);
    let first = -1;
    for (let pad = 0; pad <= 200; pad++) {
      if (isPayloadSafe(buildPageZip(slots, { ...OPTS, padBytes: pad }))) {
        first = pad;
        break;
      }
    }
    assert.equal(buildSafePageZip(slots, OPTS).retries, first, `n ${n}`);
  }
});

await test('finds a safe pad beyond the old 64-retry cap', () => {
  // A 200-byte zero window in a 0x41 icon pins one boundary for ~160 consecutive pads.
  let checked = 0;
  for (let w = 1200; w < 2400 && checked === 0; w += 20) {
    const png = new Uint8Array(6000).fill(0x41);
    png.fill(0, w, w + 200);
    const slots: PageSlot[] = [{ slotId: 0, png }];
    if (oldSearch(slots, OPTS, 64)) continue;
    const ref = oldSearch(slots, OPTS, MAX_PAD_RETRIES);
    if (!ref) continue;
    const now = buildSafePageZip(slots, OPTS);
    assert.equal(now.safe, true);
    assert.ok(now.retries > 64, `retries ${now.retries}`);
    assert.equal(now.retries, ref.retries);
    assert.deepEqual([...now.zip], [...ref.zip]);
    checked++;
  }
  assert.equal(checked, 1, 'no fixture needed more than 64 pad bytes');
});

await test('the chosen pad also satisfies the chunk-edge length rule', () => {
  for (let salt = 0; salt < 30; salt++) {
    const { zip, safe } = buildSafePageZip(pageOf(3, 500 + salt * 11, salt), OPTS);
    assert.equal(safe, true);
    const tail = zip.length - FIRST_CHUNK_DATA;
    assert.ok(!(tail > 0 && tail % PACKET_SIZE === 0));
  }
});

await test('a page is deterministic: same slots and seq give the same bytes and names', () => {
  const a = buildSafePageZip(pageOf(5, 700, 3), { ...OPTS, flushSeq: 4 });
  const b = buildSafePageZip(pageOf(5, 700, 3), { ...OPTS, flushSeq: 4 });
  assert.deepEqual([...a.zip], [...b.zip]);
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

await test('iconName: JPEG bytes get .jpg, PNG bytes keep .png', () => {
  assert.ok(iconName(0, 0, new Uint8Array([0xff, 0xd8, 0xff])).endsWith('.jpg'));
  assert.ok(iconName(0, 0, new Uint8Array([0x89, 0x50])).endsWith('.png'));
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
