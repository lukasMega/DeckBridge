import { Akp05Driver } from '../devices/ajazz/akp05-driver.js';
import { findAkp05Device, initProbeLibs, OPEN_REFUSED_HINTS, fail } from './probe-utils.js';
import { canvasSliceToBmp, transformImageForDevice } from '../transform/translator.js';
import { closeImageProc } from '../ffi/image-proc.js';
import { gifBytes, type GifSpec } from './d200-gif-images.js';
import type { DeviceImageSpec } from '../devices/driver.js';

// Part A: raw GIF via `CRT BAT`; part B: host-side JPEG loop. Fw V3.AKP05E.02.007
// ignores the raw GIF; the JPEG loop runs ~40 frames/s per key on 10 keys.
// Usage: mise run akp05-gif-probe [-- --list | --from <n> | --dir <gifs>]
//   (--dir: up to 10 own .gif files, one per key). A REAL LCD key press advances.

const PREFIX = '[akp05-gif]';
const KEY_SIZE = 112;
const STRIP_SLOT_W = 176;
/** Wire ids of the 10 LCD keys: top row 11-15, bottom row 6-10. */
const KEY_WIRES = [11, 12, 13, 14, 15, 6, 7, 8, 9, 10];
const TEST_WIRE = 11;
const SLOT_WIRE = 2;
const ADVANCE_DEBOUNCE_MS = 500;
const SETTLE_MS = 200;
const LOOP_MS = 5000;
const HOST_FRAMES = 8;

function log(...parts: unknown[]): void {
  console.log(PREFIX, ...parts);
}

type Rgb = readonly [number, number, number];
const BACKGROUNDS: readonly Rgb[] = [
  [220, 30, 30],
  [30, 180, 30],
  [40, 80, 255],
  [230, 200, 0],
  [0, 200, 200],
  [210, 0, 210],
];

/** Same picture as the GIF frames: colour per frame, white square top-left, white bar
 *  sweeping along the bottom. The device transform turns it upright. */
function frameJpeg(n: number, frames: number): Uint8Array {
  const rgb = new Uint8Array(KEY_SIZE * KEY_SIZE * 3);
  const bg = BACKGROUNDS[n % BACKGROUNDS.length]!;
  for (let i = 0; i < KEY_SIZE * KEY_SIZE; i++) rgb.set(bg, i * 3);
  const fill = (x: number, y: number, w: number, h: number): void => {
    for (let r = y; r < y + h; r++)
      rgb.fill(255, (r * KEY_SIZE + x) * 3, (r * KEY_SIZE + x + w) * 3);
  };
  fill(8, 8, 24, 24);
  const barW = Math.floor(KEY_SIZE / frames);
  fill(n * barW, KEY_SIZE - 20, barW, 14);
  return transformImageForDevice(canvasSliceToBmp(rgb, KEY_SIZE, KEY_SIZE, 0, KEY_SIZE), spec);
}

// ── Steps ──────────────────────────────────────────────────────────────────

interface Step {
  id: string;
  title: string;
  look: string;
  run: () => Promise<string | undefined> | string | undefined;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** Busy-wait: a timer-based sleep could let the keepalive write land mid-upload. */
function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // wait
  }
}

function gif(over: Partial<GifSpec>, w = KEY_SIZE): Uint8Array {
  return gifBytes({ w, h: KEY_SIZE, frames: 4, delayCs: 50, loop: true, rotate180: true, ...over });
}

/** Upload `bytes` to `wire`; the line says what went out (BAT length is BE16, max 65535). */
function send(wire: number, bytes: Uint8Array, what: string): string {
  const t0 = Date.now();
  driver.sendImage(wire, bytes);
  spin(SETTLE_MS);
  return `wire ${wire}: ${what}, ${bytes.length} B, ${Date.now() - t0 - SETTLE_MS} ms upload`;
}

/** Re-upload JPEG frames round-robin over `wires` for LOOP_MS, as fast as the link goes. */
async function hostLoop(wires: readonly number[]): Promise<string> {
  const frames = Array.from({ length: HOST_FRAMES }, (_, n) => frameJpeg(n, HOST_FRAMES));
  const bytes = frames.reduce((sum, f) => sum + f.length, 0) / frames.length;
  const start = Date.now();
  let sent = 0;
  while (Date.now() - start < LOOP_MS) {
    for (const wire of wires) driver.sendImage(wire, frames[sent % HOST_FRAMES]!);
    sent++;
    await tick(); // lets key events and the keepalive run
  }
  const secs = (Date.now() - start) / 1000;
  return `${sent} frames x ${wires.length} key(s) in ${secs.toFixed(1)} s = ${(sent / secs).toFixed(1)} frames/s per key, avg ${Math.round(bytes)} B/frame`;
}

const STEPS: Step[] = [
  {
    id: 'A1',
    title: 'baseline: JPEG on the top-left key',
    look: 'Top-left key shows the colour test picture upright (white square top-left)?',
    run: () => send(TEST_WIRE, frameJpeg(0, HOST_FRAMES), 'JPEG frame'),
  },
  {
    id: 'A2',
    title: 'static GIF (1 frame) via BAT on the top-left key',
    look: 'Solid colour, white square top-left, big "1", bar at the bottom, upright? Blank, black, garbage, or the A1 image still there = firmware does not decode GIF.',
    run: () => send(TEST_WIRE, gif({ frames: 1 }), 'GIF 1 frame'),
  },
  {
    id: 'A3',
    title: 'animated GIF, 4 frames x 500 ms, looping',
    look: 'Key changes colour red/green/blue/yellow every 0.5 s and keeps looping? Or stuck on one frame, blank, old image?',
    run: () => send(TEST_WIRE, gif({}), 'GIF 4 frames x 500 ms'),
  },
  {
    id: 'A4',
    title: 'wait: same GIF, no new write',
    look: 'Still animating after 15 s (the 10 s keepalive passed)? Keepalive DIS/LIG/CONNECT must not stop it.',
    run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return 'waited 15 s';
    },
  },
  {
    id: 'A5',
    title: 'fast GIF, 10 frames x 100 ms',
    look: 'Bar sweeps across in ~1 s, smooth? Stutter or skipped frames?',
    run: () => send(TEST_WIRE, gif({ frames: 10, delayCs: 10 }), 'GIF 10 frames x 100 ms'),
  },
  {
    id: 'A6',
    title: 'animated GIF on all 10 keys, staggered',
    look: 'All 10 keys animate? Any blank key, lag, or panel freeze? Press another key; do key presses still advance this probe?',
    run: () =>
      KEY_WIRES.map((wire, i) =>
        send(wire, gif({ frames: 10, delayCs: 10, phase: i }), `GIF phase ${i}`),
      ).join('\n   '),
  },
  {
    id: 'A7',
    title: 'animated GIF on touch-strip slot wire 2 (176x112)',
    look: 'Second strip block (above encoder 2) animates? Only frame 1? Blank?',
    run: () => send(SLOT_WIRE, gif({}, STRIP_SLOT_W), 'GIF 176x112 on strip slot'),
  },
  {
    id: 'A8',
    title: 'recovery: JPEG on every key and strip slot',
    look: 'All animations stop and keys show the static picture? Panel still takes images after the GIF writes?',
    run: () =>
      [...KEY_WIRES, SLOT_WIRE]
        .map((wire) => send(wire, wire === SLOT_WIRE ? frameJpeg(1, 8) : frameJpeg(0, 8), 'JPEG'))
        .join('\n   '),
  },
  {
    id: 'B1',
    title: `host loop: ${HOST_FRAMES} JPEG frames on the top-left key, ${LOOP_MS / 1000} s`,
    look: 'Smooth animation, flicker, or tearing? Frames/s is in the line above; compare it with what you see. Reference: the Mirabox SDK uses JPEG frames <= ~3 KB for animation.',
    run: () => hostLoop([TEST_WIRE]),
  },
  {
    id: 'B2',
    title: `host loop on all 10 keys, ${LOOP_MS / 1000} s`,
    look: 'Do all 10 keys animate together? Frames/s per key is the real ceiling of the fallback. Any key lagging or blank? Does a key press during the loop still register?',
    run: () => hostLoop(KEY_WIRES),
  },
  {
    id: 'B3',
    title: 'reset: CLE all keys',
    look: 'All keys blank. Done; Ctrl+C to quit.',
    run: () => {
      for (const wire of [...KEY_WIRES, SLOT_WIRE]) driver.clearKey(wire);
      spin(SETTLE_MS);
      return `cleared ${KEY_WIRES.length} keys + strip slot`;
    },
  },
];

async function userGifStep(dir: string): Promise<Step> {
  const names: string[] = [];
  try {
    for await (const ent of await tjs.readDir(dir)) {
      if (/\.gif$/i.test(ent.name)) names.push(ent.name);
    }
  } catch (e) {
    fail(PREFIX, `cannot read ${dir}: ${(e as Error).message}`);
  }
  if (names.length === 0) fail(PREFIX, `no .gif files in ${dir}`);
  names.sort((a, b) => a.localeCompare(b));
  names.length = Math.min(names.length, KEY_WIRES.length);
  const files = await Promise.all(names.map((name) => tjs.readFile(`${dir}/${name}`)));
  return {
    id: 'A9',
    title: `your GIFs: ${names.join(', ')}`,
    look: 'Keys (top row 11-15 first, then bottom) animate? A GIF made by the vendor app may be pre-rotated; note any upside-down or still key.',
    run: () => files.map((bytes, i) => send(KEY_WIRES[i]!, bytes, names[i]!)).join('\n   '),
  };
}

// ── Entry ──────────────────────────────────────────────────────────────────

let stepIdx = 0;
let lastAdvanceAt = 0;
let running = false;

async function runStep(i: number): Promise<void> {
  stepIdx = i;
  const s = STEPS[i]!;
  running = true;
  log('----------------------------------------------------------------');
  log(`STEP ${i + 1}/${STEPS.length}  ${s.id}  ${s.title}`);
  log(`   look: ${s.look}`);
  try {
    const detail = await s.run();
    if (detail) log(`   tx ${detail}`);
  } catch (e) {
    log(`   step failed: ${(e as Error).message}`);
  }
  running = false;
  log('   Note the result, then press a REAL LCD key for the next step.');
}

function advance(): void {
  const now = Date.now();
  if (running || now - lastAdvanceAt < ADVANCE_DEBOUNCE_MS) return;
  lastAdvanceAt = now;
  if (stepIdx === STEPS.length - 1) log('end of steps, wrapping to step 1 (Ctrl+C to quit)');
  void runStep((stepIdx + 1) % STEPS.length);
}

function argValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const v = args[at + 1];
  if (v === undefined) fail(PREFIX, `usage: ${flag} <value>`);
  return v;
}

const args = tjs.args.slice(3);
await initProbeLibs();
const userDir = argValue(args, '--dir');
if (userDir !== undefined) STEPS.push(await userGifStep(userDir));

if (args.includes('--list')) {
  STEPS.forEach((s, i) => console.log(`${String(i + 1).padStart(3)}  ${s.id}  ${s.title}`));
  closeImageProc();
  tjs.exit(0);
}
const start = Number(argValue(args, '--from') ?? '1') - 1;
if (!Number.isInteger(start) || start < 0 || start >= STEPS.length) {
  fail(PREFIX, `--from needs a step number 1-${STEPS.length} (see --list)`);
}

const found = findAkp05Device(PREFIX);
const spec: DeviceImageSpec = {
  ...found.model.image,
  maxBytes: 0,
  sharpen: 0,
  resizeFilter: 'nearest',
};
const driver = new Akp05Driver(found.model);
try {
  await driver.open(found.hidPath);
} catch (e) {
  fail(PREFIX, `open failed: ${(e as Error).message}`, ...OPEN_REFUSED_HINTS);
}
driver.on('error', (e: Error) => log(`error: ${e.message}`));
driver.on('key', (e: { state: string }) => {
  if (e.state === 'down') advance();
});
tjs.addSignalListener('SIGINT', () => {
  void (async () => {
    await driver.close();
    closeImageProc();
    tjs.exit(0);
  })();
});

log(
  `AKP05 open (firmware ${driver.firmware ?? 'unknown'}). ${STEPS.length} steps; press a REAL LCD key to advance.`,
);
await runStep(start);
