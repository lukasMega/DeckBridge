import { MiraboxDriver } from './mirabox.js';
import { closeSidecar, transformImageForDevice } from './translator.js';
import type { KeyEvent } from './types.js';
import { getReportDescriptor, hidSerialForPath, listHidPaths } from './ffi/hidapi.js';
import { parseOutputReportSize } from './devices/hid-report-descriptor.js';
import { FIFINE_D6_MODEL, FIFINE_D6_REV2_MODEL } from './devices/fifine/fifine-d6.js';
import type { DeviceModel } from './devices/driver.js';

// Fifine AmpliGame D6 capture probe — the "the unit goes back tomorrow" harness.
//
// Phase B of .claude/plans/2026-09-10_fifine-d6-support.md is already complete for
// rev. 2 (0x0060). What it did NOT do is record the things that can only be read off
// physical hardware and never reconstructed afterwards. This probe captures those:
//
//   S1  identity + the RAW HID report descriptor  -> ts/test/fixtures/<id>.report-descriptor.json
//       hid-report-descriptor.test.ts currently only exercises hand-built synthetic
//       descriptors (vendorDescriptor()). A real one turns the B4' packet-size probe
//       into a hardware-backed regression test.
//   S2  brightness sweep — settles the open B3 note ("is LIG visibly non-linear vs the
//       293V3, i.e. does buildLig want companion's (x/100)^0.75 gamma?").
//   S3  JPEG size ladder — `maxBytes: 10240` on this model is INHERITED from the 293V3
//       and was never measured on a D6. If the firmware takes more, key quality is
//       being left on the table; if it takes less, we are relying on luck.
//   S4  raw input-report trace — every rx report printed as hex, so key wire codes can
//       be replayed into parseAckReport() as a fixture later.
//
// Usage:  mise run d6-capture            (all stages, then S4 until Ctrl+C)
//         mise run d6-capture -- s1      (one stage; s1|s2|s3|s4, comma-separated)
//
// Read-only as far as the device's persistent state goes: every stage either reads, or
// writes images/brightness that a replug resets.

const args = (tjs.args[3] ?? 's1,s2,s3,s4').toLowerCase();
const want = (stage: string): boolean => args.includes(stage);

const FIXTURE_DIR = 'test/fixtures';
const VID = 0x3142;

/** Probe-local subclass: `device`/`hidLib` are `protected` on HidDeviceBase, which is
 *  exactly the seam a diagnostic needs — the raw descriptor must come off the SAME open
 *  handle the driver uses (re-opening it on macOS risks the IOHIDManager churn that
 *  mirabox.ts's _workerHidLib comment warns about). */
class CaptureDriver extends MiraboxDriver {
  /** The descriptor bytes hidapi reports for the open interface, or null if this build
   *  of hidapi predates hid_get_report_descriptor. */
  captureDescriptor(): Uint8Array | null {
    if (!this.device || !this.hidLib) return null;
    return getReportDescriptor(this.hidLib.symbols, this.device, 4096);
  }
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One random channel byte. Noise is the only 112x112 content that reliably encodes to a
 *  large JPEG, which is what the S3 size ladder needs. */
// eslint-disable-next-line sonarjs/pseudo-random -- visual test pattern, not a secret
const rnd = (): number => (Math.random() * 256) | 0;

// ── S1: which unit is this, and what does it say about itself? ───────────────────────
// PID decides the model (and with it the packet size), so resolve it by enumeration
// before opening anything — exactly the order the B0 runbook step prescribes.
let model: DeviceModel | null = null;
const serials: string[] = [];
for (const candidate of [FIFINE_D6_REV2_MODEL, FIFINE_D6_MODEL]) {
  const pid = candidate.usbProductIds[0]!;
  const paths = listHidPaths(VID, candidate.usagePage!, candidate.usage!, pid);
  if (paths.length === 0) continue;
  model = candidate;
  console.log(`[s1] model:   ${candidate.id} (${candidate.name})`);
  console.log(`[s1] usb:     VID=0x${VID.toString(16)} PID=0x${pid.toString(16).padStart(4, '0')}`);
  console.log(`[s1] paths:   ${paths.length} matching usage 0xffa0/1`);
  for (const p of paths) {
    // A shared serial (mirajazz's hardcoded 355499441494) is the one thing that would
    // force sharedSerial: true on this model — open question O3.
    const serial = hidSerialForPath(p);
    // The fixture is checked in, so only the vendor-prefix half goes into it: the
    // interesting fact is "per-unit tail, not mirajazz's shared 355499441494", which the
    // prefix already shows. The full value stays in this console line.
    if (serial) serials.push(`${serial.slice(0, 8)}…`);
    console.log(`[s1]   ${p}  serial=${serial ?? '(none)'}`);
  }
  break;
}

if (!model) {
  console.log(`[s1] no Fifine D6 found on VID 0x${VID.toString(16)} usage 0xffa0/1.`);
  console.log('[s1] check the cable, and grant Input Monitoring (System Settings →');
  console.log('[s1] Privacy & Security) to this terminal before the first open.');
  tjs.exit(1);
}

const driver = new CaptureDriver(model);
await driver.open();
console.log(`[s1] opened — hidPath=${driver.hidPath ?? '(vid/pid fallback)'}`);

if (want('s1')) {
  const desc = driver.captureDescriptor();
  if (!desc) {
    console.log('[s1] report descriptor unavailable (hidapi too old) — nothing to save.');
  } else {
    const parsed = parseOutputReportSize(desc);
    console.log(`[s1] report descriptor: ${desc.length} B`);
    for (let i = 0; i < desc.length; i += 16) {
      console.log(`[s1]   ${i.toString(16).padStart(4, '0')}  ${hex(desc.subarray(i, i + 16))}`);
    }
    const parsedText = parsed === null ? 'null (refused)' : `${parsed} B`;
    console.log(
      `[s1] parseOutputReportSize -> ${parsedText}   model says ${model.wire!.packetSize} B`,
    );
    const out = `${FIXTURE_DIR}/${model.id}.report-descriptor.json`;
    await tjs.writeFile(
      out,
      new TextEncoder().encode(
        `${JSON.stringify(
          {
            _comment:
              'Captured off real hardware by src/d6-capture.ts (mise run d6-capture). ' +
              'Raw hid_get_report_descriptor bytes for the vendor (0xffa0/1) interface.',
            deviceId: model.id,
            usb: `0x${VID.toString(16)}:0x${model.usbProductIds[0]!.toString(16).padStart(4, '0')}`,
            serialsSeen: serials,
            platform: 'macOS',
            capturedAt: new Date().toISOString().slice(0, 10),
            parsedOutputReportSize: parsed,
            modelPacketSize: model.wire!.packetSize,
            modelInSize: model.wire!.inSize,
            descriptorHex: hex(desc),
          },
          null,
          2,
        )}\n`,
      ),
    );
    console.log(`[s1] saved -> ts/${out}`);
  }
}

// ── S2: brightness linearity (B3) ────────────────────────────────────────────────────
// All 15 keys are painted mid-grey first so the panel has something to dim; a black
// panel tells you nothing about a brightness curve.
const wireIds = model.keyMap.coraToWireImage!;

/** A 24-bit bottom-up BMP the Rust transform can decode (image::load_from_memory
 *  sniffs the format). `fill(x, y)` returns [r, g, b]. 112*3 = 336 bytes per row, so
 *  the 4-byte row stride needs no padding at this size. */
function bmp(
  w: number,
  h: number,
  fill: (x: number, y: number) => [number, number, number],
): Uint8Array {
  const stride = w * 3;
  const size = 54 + stride * h;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x42; // 'B'
  buf[1] = 0x4d; // 'M'
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true); // pixel data offset
  dv.setUint32(14, 40, true); // BITMAPINFOHEADER
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true); // positive = bottom-up
  dv.setUint16(26, 1, true); // planes
  dv.setUint16(28, 24, true); // bpp
  dv.setUint32(34, stride * h, true);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * stride; // bottom-up
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      buf[row + x * 3] = b;
      buf[row + x * 3 + 1] = g;
      buf[row + x * 3 + 2] = r;
    }
  }
  return buf;
}

const W = model.image.width;
const H = model.image.height;

if (want('s2')) {
  const grey = transformImageForDevice(
    bmp(W, H, () => [128, 128, 128]),
    { ...model.image, maxBytes: 0 },
  );
  for (const id of wireIds) driver.sendImage(id, grey);
  await sleep(600);
  console.log('[s2] brightness sweep — note how each step LOOKS vs the number:');
  for (const level of [100, 75, 50, 25, 10, 100]) {
    driver.setBrightness(level);
    console.log(`[s2]   brightness=${level}%  (2 s)`);
    await sleep(2000);
  }
  console.log('[s2] if 50% looks much brighter than half of 100%, buildLig wants a gamma.');
}

// ── S3: JPEG size ladder — what does the firmware actually accept? ───────────────────
// Random noise is the only content that reliably produces a LARGE jpeg at 112x112, but
// noise ALONE is useless as a verdict: colourful static is exactly what a "broken image"
// looks like, so the observer cannot tell a clean 22 KB render from a corrupt one.
//
// So each key is noise PLUS three landmarks that only survive a fully-received image:
//   - a 4 px white frame on all four edges  (a truncated/torn JPEG loses the bottom edge)
//   - a solid colour band across the top    (per-key identity)
//   - N black tally squares in that band    (N = key number, so keys can't be confused)
// Verdict: frame closed on all four sides + right tally count = that size rendered clean.
//
// Every step is capped by maxBytes so the sizes land near the targets instead of wherever
// q=100 happens to fall (the encoder's own ceiling here is ~21.8 KB at 112x112).
if (want('s3')) {
  const BANDS: [number, number, number][] = [
    [255, 255, 255],
    [255, 64, 64],
    [64, 255, 64],
    [64, 128, 255],
    [255, 255, 64],
  ];
  const TARGETS = [8192, 12288, 16384, 24576, 32768]; // 8 K control, then past maxBytes 10240
  const FRAME = 4;
  const BAND_H = 30;

  console.log('[s3] clearing panel, then painting the TOP ROW left → right:');
  for (const id of wireIds) driver.clearKey(id);
  await sleep(400);

  for (let cora = 0; cora < TARGETS.length; cora++) {
    const band = BANDS[cora]!;
    const tally = cora + 1;
    const src = bmp(W, H, (x, y) => {
      const edge = x < FRAME || x >= W - FRAME || y < FRAME || y >= H - FRAME;
      if (edge) return [255, 255, 255];
      if (y >= BAND_H) return [rnd(), rnd(), rnd()];
      // Tally squares: `tally` black blocks, 12 px wide on a 20 px pitch, inside the band.
      const slot = Math.floor((x - 8) / 20);
      const inSquare = x >= 8 && slot < tally && (x - 8) % 20 < 12 && y >= 10 && y < 24;
      return inSquare ? [0, 0, 0] : band;
    });
    const jpeg = transformImageForDevice(src, {
      ...model.image,
      quality: 100,
      sharpen: 0,
      maxBytes: TARGETS[cora]!,
    });
    driver.sendImage(wireIds[cora]!, jpeg);
    console.log(
      `[s3]   key ${cora + 1} (target ${TARGETS[cora]!} B): sent ${jpeg.length} B — ` +
        `band rgb(${band.join(',')}), ${tally} tally square(s)`,
    );
    await sleep(400);
  }
  console.log('[s3] REPORT per key 1..5, checking THREE things each:');
  console.log('[s3]   (a) white frame closed on all four edges — esp. the BOTTOM edge');
  console.log('[s3]   (b) tally squares: key 1 has 1, key 2 has 2, … key 5 has 5');
  console.log('[s3]   (c) static fills the middle evenly — no grey/black half, no smear');
  console.log(`[s3] static in the middle is CORRECT (it is random noise, the only 112x112`);
  console.log('[s3] content that encodes large enough to probe past the cap).');
  console.log(`[s3] model cap is maxBytes ${model.image.maxBytes} — keys above it that`);
  console.log('[s3] pass (a)+(b)+(c) mean the cap can be raised (better key quality).');
  console.log('[s3] a wedged panel recovers with a replug; nothing persists.');
}

// ── S4: raw input trace ──────────────────────────────────────────────────────────────
// Both the decoded event and the raw rx bytes, so a future parseAckReport fixture can
// be built from a real wire capture rather than a reconstruction.
if (want('s4')) {
  console.log('[s4] press every key (and hold one) — down AND up are expected on rev. 2.');
  driver.on('comm', (e: { direction: string; human: string; hex: string }) => {
    if (e.direction === 'rx') console.log(`[s4] rx  ${e.human.padEnd(24)} ${e.hex}`);
  });
  driver.on('key', (e: KeyEvent) => {
    console.log(`[s4] key code=0x${e.keyIndex.toString(16).padStart(2, '0')} state=${e.state}`);
  });
}

// Without the key trace there is nothing left to wait for, so close instead of parking
// on the event loop — that makes `mise run d6-capture -- s1` a plain one-shot capture.
if (!want('s4')) {
  await driver.close();
  closeSidecar();
  console.log('[done] closed.');
  tjs.exit(0);
}

console.log('[done] Ctrl+C to close the device cleanly.');

tjs.addSignalListener('SIGINT', () => {
  void driver.close().then(() => {
    closeSidecar();
    tjs.exit(0);
    return undefined;
  });
});
