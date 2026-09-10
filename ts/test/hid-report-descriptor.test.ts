import assert from 'tjs:assert';
import {
  parseOutputReportSize,
  probeOutputReportSize,
} from '../src/devices/hid-report-descriptor.js';
import type { HidapiSymbols } from '../src/ffi/hidapi.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}: ${String(e)}`);
  }
}

// Short-item helpers. Prefix byte = bTag<<4 | bType<<2 | bSize.
const usagePage = (v: number) => [0x06, v & 0xff, (v >> 8) & 0xff]; // Global, 2 bytes
const usage = (v: number) => [0x09, v]; // Local, 1 byte
const collection = [0xa1, 0x01];
const endCollection = [0xc0];
const reportSize = (bits: number) => [0x75, bits]; // Global 0x74 | size 1
const reportCount1 = (n: number) => [0x95, n]; // Global 0x94 | size 1
const reportCount2 = (n: number) => [0x96, n & 0xff, (n >> 8) & 0xff]; // size 2
const input = [0x81, 0x02];
const output = [0x91, 0x02];
const reportId = (n: number) => [0x85, n]; // Global 0x84 | size 1

/** The vendor-defined descriptor these Mirabox-family boards expose: one 0xffa0/1
 *  collection with a single unnumbered input and output report of `bytes` bytes. */
function vendorDescriptor(bytes: number): Uint8Array {
  return new Uint8Array([
    ...usagePage(0xffa0),
    ...usage(0x01),
    ...collection,
    ...usage(0x01),
    ...reportSize(8),
    ...reportCount2(bytes),
    ...input,
    ...usage(0x01),
    ...reportSize(8),
    ...reportCount2(bytes),
    ...output,
    ...endCollection,
  ]);
}

console.log('\nhid-report-descriptor: parseOutputReportSize');

// The whole point of the probe: tell a 512-byte board from a 1024-byte one when the
// model constant is only an inference (Fifine D6 rev. 1 vs rev. 2).
test('reads a 1024-byte output report', () => {
  assert.equal(parseOutputReportSize(vendorDescriptor(1024)), 1024);
});

test('reads a 512-byte output report', () => {
  assert.equal(parseOutputReportSize(vendorDescriptor(512)), 512);
});

test('ignores the input report when sizing the output report', () => {
  // Input 64 B, output 1024 B — a naive walker that summed both would return 1088.
  const desc = new Uint8Array([
    ...usagePage(0xffa0),
    ...usage(0x01),
    ...collection,
    ...reportSize(8),
    ...reportCount1(64),
    ...input,
    ...reportSize(8),
    ...reportCount2(1024),
    ...output,
    ...endCollection,
  ]);
  assert.equal(parseOutputReportSize(desc), 1024);
});

test('report size in bits is converted to bytes', () => {
  // 16-bit fields × 256 = 4096 bits = 512 bytes.
  const desc = new Uint8Array([
    ...usagePage(0xffa0),
    ...collection,
    ...reportSize(16),
    ...reportCount2(256),
    ...output,
    ...endCollection,
  ]);
  assert.equal(parseOutputReportSize(desc), 512);
});

// ── Refusals ────────────────────────────────────────────────────────────────
// Every one of these must return null so the caller keeps the model's packetSize.
// A half-understood descriptor must never beat a hardware-verified constant.

console.log('\nhid-report-descriptor: refuses anything ambiguous');

test('refuses a descriptor with numbered reports (Report ID changes the framing)', () => {
  const desc = new Uint8Array([
    ...usagePage(0xffa0),
    ...collection,
    ...reportId(3),
    ...reportSize(8),
    ...reportCount2(1024),
    ...output,
    ...endCollection,
  ]);
  assert.equal(parseOutputReportSize(desc), null);
});

test('refuses a descriptor using the Push/Pop global stack', () => {
  const push = [0xa4];
  const desc = new Uint8Array([
    ...usagePage(0xffa0),
    ...collection,
    ...push,
    ...reportSize(8),
    ...reportCount2(1024),
    ...output,
    ...endCollection,
  ]);
  assert.equal(parseOutputReportSize(desc), null);
});

test('refuses a split output report (two Output items)', () => {
  const desc = new Uint8Array([
    ...usagePage(0xffa0),
    ...collection,
    ...reportSize(8),
    ...reportCount2(512),
    ...output,
    ...reportSize(8),
    ...reportCount2(512),
    ...output,
    ...endCollection,
  ]);
  assert.equal(parseOutputReportSize(desc), null);
});

test('refuses a long item', () => {
  const desc = new Uint8Array([...usagePage(0xffa0), 0xfe, 0x02, 0x00, 0x00, 0x00]);
  assert.equal(parseOutputReportSize(desc), null);
});

test('refuses a truncated descriptor', () => {
  // Report Count declares 2 data bytes but only 1 follows.
  const desc = new Uint8Array([...usagePage(0xffa0), ...collection, 0x96, 0x00]);
  assert.equal(parseOutputReportSize(desc), null);
});

test('refuses an Output item with no preceding Report Size/Count', () => {
  const desc = new Uint8Array([...usagePage(0xffa0), ...collection, ...output, ...endCollection]);
  assert.equal(parseOutputReportSize(desc), null);
});

test('refuses a bit count that is not a whole number of bytes', () => {
  const desc = new Uint8Array([
    ...usagePage(0xffa0),
    ...collection,
    ...reportSize(1),
    ...reportCount1(12), // 12 bits
    ...output,
    ...endCollection,
  ]);
  assert.equal(parseOutputReportSize(desc), null);
});

test('refuses a descriptor with no output report at all (input-only device)', () => {
  const desc = new Uint8Array([
    ...usagePage(0xffa0),
    ...collection,
    ...reportSize(8),
    ...reportCount1(64),
    ...input,
    ...endCollection,
  ]);
  assert.equal(parseOutputReportSize(desc), null);
});

test('refuses an empty descriptor', () => {
  assert.equal(parseOutputReportSize(new Uint8Array(0)), null);
});

// A 4-byte data payload must stay unsigned — `<< 24` would sign-flip it negative and
// yield a bogus (negative) report size instead of a refusal.
test('a 4-byte report count does not sign-flip', () => {
  const desc = new Uint8Array([
    ...usagePage(0xffa0),
    ...collection,
    ...reportSize(8),
    0x97,
    0x00,
    0x00,
    0x00,
    0x80, // Report Count = 0x80000000
    ...output,
    ...endCollection,
  ]);
  const size = parseOutputReportSize(desc);
  assert.ok(size === null || size > 0, `expected null or a positive size, got ${String(size)}`);
});

// ── probeOutputReportSize ───────────────────────────────────────────────────
// The candidate whitelist is what lets the probe overrule a model constant at all:
// it can only ever pick between sizes the model already declared valid, so a
// descriptor we misread (or one Windows reconstructed oddly) can't invent a new size.

console.log('\nhid-report-descriptor: probeOutputReportSize');

/** Minimal HidapiSymbols stub — only the descriptor call is ever reached. */
function fakeHid(
  impl: ((buf: Uint8Array) => number) | null,
): Pick<HidapiSymbols, 'hid_get_report_descriptor'> {
  if (impl === null) return {};
  return { hid_get_report_descriptor: (_dev, buf) => impl(buf) };
}

function hidReturning(desc: Uint8Array): Pick<HidapiSymbols, 'hid_get_report_descriptor'> {
  return fakeHid((buf) => {
    buf.set(desc);
    return desc.length;
  });
}

const DEV = {}; // opaque device pointer — never dereferenced by the stub

test('adopts a descriptor size that is on the candidate list', () => {
  const hid = hidReturning(vendorDescriptor(1024)) as HidapiSymbols;
  assert.equal(probeOutputReportSize(hid, DEV, [512, 1024]), 1024);
});

test('adopts the other candidate just as readily', () => {
  const hid = hidReturning(vendorDescriptor(512)) as HidapiSymbols;
  assert.equal(probeOutputReportSize(hid, DEV, [512, 1024]), 512);
});

test('REFUSES a size that is not on the candidate list', () => {
  // 64 B parses perfectly well — it is simply not a size this family is known to use,
  // so the model constant must win.
  const hid = hidReturning(vendorDescriptor(64)) as HidapiSymbols;
  assert.equal(probeOutputReportSize(hid, DEV, [512, 1024]), null);
});

test('refuses when hidapi is too old to expose the descriptor', () => {
  assert.equal(probeOutputReportSize(fakeHid(null) as HidapiSymbols, DEV, [512, 1024]), null);
});

test('refuses when the descriptor call reports an error', () => {
  const hid = fakeHid(() => -1) as HidapiSymbols;
  assert.equal(probeOutputReportSize(hid, DEV, [512, 1024]), null);
});

test('refuses when the descriptor comes back empty', () => {
  const hid = fakeHid(() => 0) as HidapiSymbols;
  assert.equal(probeOutputReportSize(hid, DEV, [512, 1024]), null);
});

test('refuses (does not throw) when the descriptor call throws', () => {
  const hid = fakeHid(() => {
    throw new Error('ffi boom');
  }) as HidapiSymbols;
  assert.equal(probeOutputReportSize(hid, DEV, [512, 1024]), null);
});

test('refuses an unparseable descriptor even when hidapi returns bytes', () => {
  const hid = hidReturning(new Uint8Array([0xfe, 0x02, 0x00, 0x00, 0x00])) as HidapiSymbols;
  assert.equal(probeOutputReportSize(hid, DEV, [512, 1024]), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
