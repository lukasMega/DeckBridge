import {
  exitOnSigint,
  initProbeLibs,
  logKeyEvents,
  openProbeDevice,
  readProbeJpegDir,
  tryProbeJpegDir,
} from './probe-utils.js';
import { transformImageForDevice } from './translator.js';
import { splashSpec } from './splash-sender.js';
import { SPLASH_STATES } from './assets/splash-states.js';
import { MIRABOX_K1PRO_MODEL } from './devices/mirabox/mirabox-k1pro.js';

// K1 Pro probe round 3+: file-driven A/B harness.
//
// Sends up to 6 JPEG files (sorted by name) from a directory to the 6 keys,
// so arbitrary encoder variants (jpegtran -optimize, 4:2:0 re-encodes, padded
// variants, ...) can be compared on hardware with everything else identical.
//
// With no directory to read, it paints the green "connected" splash checkmark on
// every key instead — a zero-setup check that enumerate → open → transform →
// upload all work on this unit.
//
// Usage: put 6 files named 0-*.jpg .. 5-*.jpg into /tmp/k1pro-probe3 (or pass
// another dir: `mise run k1pro-probe -- /path/to/dir`).
//
// History:
//   round 1 (size ladder, same pixels): single-chunk + seam-in-COM clean;
//     seam-in-DQT -> greyscale, seam-in-SOS -> artifact (header/seam rule).
//   round 2 (same 1591B bitstream shifted +4..+64): artifact at EVERY
//     alignment; 1793B re-encode of the same image clean -> scan failures are
//     bitstream-content-dependent, not alignment/size-dependent.

const PREFIX = '[probe]';

// args: [tjs, 'run', script, dir?]
const dirArg = tjs.args[3];
// eslint-disable-next-line sonarjs/publicly-writable-directories -- diagnostic probe, dev machine only
const DEFAULT_DIR = '/tmp/k1pro-probe3';

await initProbeLibs();

const model = MIRABOX_K1PRO_MODEL;
const POS = ['top-left', 'top-mid', 'top-right', 'bot-left', 'bot-mid', 'bot-right'];

interface ProbeImage {
  label: string;
  bytes: Uint8Array;
  /** Inter-chunk pacing for timing experiments; 0 = send as fast as the wire allows. */
  delayMs: number;
}

/** The checked-in green checkmark the driver paints on connect, run through the
 *  model's splash spec — its sources are upright, not Mini-oriented, so `model.image`
 *  would rotate them wrong. Same bytes on every key: one glance says whether the
 *  upload path is healthy end to end. */
function builtinImages(): ProbeImage[] {
  const spec = splashSpec(model);
  const bytes = transformImageForDevice(Buffer.from(SPLASH_STATES.connected, 'base64'), spec);
  return POS.slice(0, model.keyCount).map(() => ({
    label: 'builtin splash "connected"',
    bytes,
    delayMs: 0,
  }));
}

async function imagesFromDir(dir: string, names: string[]): Promise<ProbeImage[]> {
  const images: ProbeImage[] = [];
  for (const name of names) {
    // Optional inter-chunk pacing for timing experiments: a `delay<N>` token in
    // the filename (e.g. `2-key4q60-delay20.jpg`) sets N ms between chunks.
    const delayMs = Number(/delay(\d+)/.exec(name)?.[1] ?? 0);
    images.push({ label: name, bytes: await tjs.readFile(`${dir}/${name}`), delayMs });
  }
  return images;
}

// An explicitly named directory must exist; the default one is allowed to be absent.
let images: ProbeImage[];
let source: string;
if (dirArg !== undefined) {
  images = await imagesFromDir(dirArg, await readProbeJpegDir(dirArg, PREFIX, model.keyCount));
  source = dirArg;
} else {
  const names = await tryProbeJpegDir(DEFAULT_DIR, PREFIX, model.keyCount);
  images = names === null ? builtinImages() : await imagesFromDir(DEFAULT_DIR, names);
  source = names === null ? 'the built-in splash images' : DEFAULT_DIR;
}

const driver = await openProbeDevice(model, PREFIX);
console.log(`${PREFIX} K1 Pro connected — sending ${images.length} images from ${source}`);

const wireIds = model.keyMap.coraToWireImage!;
const maxBytes = model.image.maxBytes;

for (let cora = 0; cora < images.length; cora++) {
  const { label, bytes, delayMs } = images[cora]!;
  driver.sendImage(wireIds[cora]!, bytes, delayMs);
  const tag = delayMs > 0 ? ` delay=${delayMs}ms` : '';
  console.log(
    `${PREFIX} ${POS[cora]!.padEnd(9)} (cora=${cora}): ${bytes.length}B${tag} — ${label}`,
  );
  // Past maxBytes the firmware drops or garbles the upload, which reads as an
  // encoder artifact in the A/B — call it out so it isn't scored as one.
  if (bytes.length > maxBytes) {
    console.log(`${PREFIX}   ⚠ over the model's ${maxBytes}B limit — expect a drop, not a verdict`);
  }
  await new Promise((r) => setTimeout(r, 100));
}

console.log(`${PREFIX} sent — note per position: CLEAN or ARTIFACT (and how it looks).`);
console.log(`${PREFIX} Ctrl+C to exit.`);

logKeyEvents(driver);

exitOnSigint(driver);
