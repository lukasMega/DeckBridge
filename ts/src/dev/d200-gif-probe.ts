import { closeImageProc } from '../ffi/image-proc.js';
import { ULANZI_D200_MODEL } from '../devices/ulanzi/ulanzi-d200.js';
import {
  CMD,
  DEFAULT_FONT,
  buildChunks,
  buildPacket,
  describeIncoming,
  describeOutgoing,
  encodeBrightness,
  encodeSmallWindow,
  formatClock,
  parseDeviceVersion,
  parseIncoming,
} from '../devices/ulanzi/ulanzi-protocol.js';
import { buildManifest, buildSafeZip, entry, slotKey } from '../devices/ulanzi/ulanzi-zip.js';
import { DEFAULT_BRIGHTNESS } from '../shared/types.js';
import { gifBytes, type GifSpec } from './d200-gif-images.js';
import { D200Link } from './d200-link.js';
import { iconBytes } from './d200-wide-images.js';
import { OPEN_REFUSED_HINTS, fail, findProbePath, initProbeLibs } from './probe-utils.js';

// Can the D200 firmware show animated GIF icons? Each step ships one page ZIP and
// logs what went out. Press a REAL key to advance; write down what you see next to
// the step id.
//
// Usage: mise run d200-gif-probe [-- --list | --dump <dir> | --from <n> | --dir <gifs>]
//   --list        print the steps and exit (no device needed)
//   --dump <dir>  write the generated GIFs there and exit (open them in a browser first)
//   --from <n>    start at step n instead of 1
//   --dir <gifs>  add a last step with up to 13 of your own .gif files (e.g. from Ulanzi Studio)

const PREFIX = '[d200-gif]';
const model = ULANZI_D200_MODEL;
const page = model.page!;
const WIDE_SLOT = page.smallWindowSlot.row * model.columns + page.smallWindowSlot.col;
const KEY_SLOTS = Array.from({ length: WIDE_SLOT }, (_, i) => i); // 0..12, the real keys
const TEST_SLOT = 0;
const REF_SLOT = 12;
const SECOND_SLOT = 1;
const WIDE_IMAGE_MODE = 2;
const CLOCK_MODE = page.smallWindowMode;
const HANDSHAKE_DRAIN_MS = 250;
const ADVANCE_DEBOUNCE_MS = 500;
const MAX_USER_GIFS = KEY_SLOTS.length;
const ASCII = new TextEncoder();

function log(...parts: unknown[]): void {
  console.log(PREFIX, ...parts);
}

// ── Steps ──────────────────────────────────────────────────────────────────

/** One icon in the page: its bytes and the extension written into the manifest path. */
interface Icon {
  bytes: Uint8Array;
  ext: 'gif' | 'png' | 'jpg';
  label: string;
}

interface Step {
  id: string;
  title: string;
  look: string;
  /** 'full' = SET_BUTTONS (replaces the grid), 'partial' = PARTIAL_UPDATE (merges). */
  send: 'full' | 'partial';
  keys: Map<number, Icon>;
  /** Mode-2 info-window image; absent = firmware clock. */
  wide?: Icon;
}

const KEY = { w: 196, h: 196 };
const gif = (spec: Partial<GifSpec>, ext: Icon['ext'] = 'gif'): Icon => {
  const full: GifSpec = { ...KEY, frames: 4, delayCs: 50, loop: true, ...spec };
  const bytes = gifBytes(full);
  const loop = full.loop ? 'loop' : 'no-loop';
  return {
    bytes,
    ext,
    label: `GIF ${full.w}x${full.h} ${full.frames}f x ${full.delayCs * 10} ms ${loop} as .${ext}`,
  };
};
const jpeg = (): Icon => ({
  bytes: iconBytes({ ...KEY, format: 'jpeg' }),
  ext: 'jpg',
  label: 'JPEG ruler',
});

const REF_LOOK = 'Key 12 (bottom row, middle) shows the JPEG ruler = the page was applied.';
const ANIM_LOOK =
  'Key 0 (top-left): animates (number + colour change, bar moves), shows only frame 1 ' +
  '(red, "1"), blank/black, solid colour square, or the old image? White square top-left = upright.';

function withRef(keys: Array<[number, Icon]>): Map<number, Icon> {
  return new Map([...keys, [REF_SLOT, jpeg()]]);
}

function step(
  id: string,
  title: string,
  look: string,
  keys: Map<number, Icon>,
  opts: { send?: Step['send']; wide?: Icon } = {},
): Step {
  return { id, title, look: `${look} ${REF_LOOK}`, send: opts.send ?? 'full', keys, ...opts };
}

const STEPS: Step[] = [
  step(
    'G1',
    'baseline: JPEG on key 0',
    'Key 0 shows the ruler (same as key 12)?',
    withRef([[TEST_SLOT, jpeg()]]),
  ),
  step(
    'G2',
    'static GIF (1 frame) on key 0',
    'Red square, white "1", bar bottom-left? Then the firmware decodes GIF at all.',
    withRef([[TEST_SLOT, gif({ frames: 1 })]]),
  ),
  step(
    'G3',
    'animated GIF, 4 frames x 500 ms, looping',
    ANIM_LOOK,
    withRef([[TEST_SLOT, gif({})]]),
  ),
  step(
    'G4',
    'animated GIF without the NETSCAPE loop block',
    `${ANIM_LOOK} Does it stop on "4" after one pass, or loop anyway?`,
    withRef([[TEST_SLOT, gif({ loop: false })]]),
  ),
  step(
    'G5',
    'animated GIF bytes named .png',
    `${ANIM_LOOK} Same as G3 = firmware sniffs content; different = it trusts the extension.`,
    withRef([[TEST_SLOT, gif({}, 'png')]]),
  ),
  step(
    'G6',
    'fast GIF, 10 frames x 100 ms',
    'Key 0: bar sweeps in ~1 s, all 10 numbers visible? Stutter or skipped numbers?',
    withRef([[TEST_SLOT, gif({ frames: 10, delayCs: 10 })]]),
  ),
  step(
    'G7',
    'very fast GIF, 10 frames x 20 ms',
    'Key 0: sweep in ~0.2 s (honored) or ~1 s (clamped to 100 ms like browsers)?',
    withRef([[TEST_SLOT, gif({ frames: 10, delayCs: 2 })]]),
  ),
  step(
    'G8',
    'animated GIF on all 13 keys, staggered phases',
    'All 13 keys animate? Frame rate lower than G6? Panel lag, freeze, or keys going blank? ' +
      'Watch the heartbeat count in the next step line (it should keep rising).',
    new Map(
      KEY_SLOTS.map((s) => [s, gif({ frames: 10, delayCs: 10, phase: s })] as [number, Icon]),
    ),
  ),
  step(
    'G9',
    'reset: animated GIF on key 0 (SET_BUTTONS)',
    `${ANIM_LOOK} Then press a key for the partial update.`,
    withRef([[TEST_SLOT, gif({})]]),
  ),
  step(
    'G10',
    'PARTIAL_UPDATE: key 1 -> JPEG only',
    'Key 1 shows the ruler. Does key 0 KEEP animating, freeze, restart or go blank? ' +
      '(DeckBridge updates keys this way.)',
    new Map([[SECOND_SLOT, jpeg()]]),
    { send: 'partial' },
  ),
  step(
    'G11',
    'info window mode 2 with an animated GIF 458x196',
    'Info window (bottom right) animates? Only frame 1? Blank? Clock?',
    withRef([[TEST_SLOT, gif({})]]),
    { wide: gif({ w: 458, h: 196, frames: 4, delayCs: 50 }) },
  ),
  step(
    'G12',
    'reset: JPEG on key 0, clock in the info window',
    'Back to G1. Key 0 animation stopped?',
    withRef([[TEST_SLOT, jpeg()]]),
  ),
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
  names.length = Math.min(names.length, MAX_USER_GIFS);
  const keys = new Map<number, Icon>();
  for (const [i, name] of names.entries()) {
    const bytes = await tjs.readFile(`${dir}/${name}`);
    keys.set(i, { bytes, ext: 'gif', label: `${name} (${bytes.length} B)` });
  }
  return step(
    'G13',
    `your GIFs: ${names.join(', ')}`,
    'Keys 0.. (row by row) animate like in Ulanzi Studio? Note any blank or still key.',
    keys,
  );
}

// ── Probe state ────────────────────────────────────────────────────────────

let link: D200Link;
let firmware: string | undefined;
let heartbeats = 0;
let flushSeq = 0;
let stepIdx = 0;
let lastAdvanceAt = 0;
let windowMode = CLOCK_MODE;

function sendFrame(): void {
  const payload = encodeSmallWindow({
    mode: windowMode,
    time: formatClock(new Date()),
    hourFormat: '24H',
    suffix: '',
  });
  link.write(buildPacket(CMD.SMALL_WINDOW, payload.length, payload));
}

function iconPath(slot: number, seq: number, icon: Icon): string {
  return `Images/${slot}_${seq}_${icon.ext}.${icon.ext}`;
}

function sendPage(s: Step): void {
  const seq = flushSeq++;
  windowMode = s.wide ? WIDE_IMAGE_MODE : CLOCK_MODE;
  const icons = new Map(s.keys);
  if (s.wide) icons.set(WIDE_SLOT, s.wide);
  const slots = [...icons].map(([slotId, icon]) => ({ slotId, png: icon.bytes }));
  // buildManifest keeps the driver's dialect; only the Icon paths are swapped for ours.
  const manifest = JSON.parse(
    buildManifest(slots, {
      columns: model.columns,
      smallWindowMode: windowMode,
      smallWindowSlot: page.smallWindowSlot,
      font: DEFAULT_FONT,
      flushSeq: seq,
    }),
  ) as Record<string, { ViewParam: Array<Record<string, unknown>> }>;
  const files = [...icons].map(([slot, icon]) => {
    const name = iconPath(slot, seq, icon);
    manifest[slotKey(slot, model.columns)]!.ViewParam[0]!.Icon = name;
    return entry(name, icon.bytes);
  });
  const manifestText = JSON.stringify(manifest);
  const { zip, retries } = buildSafeZip([
    entry('manifest.json', ASCII.encode(manifestText)),
    ...files,
    entry('sentinel.txt', new Uint8Array(0)),
  ]);
  const packets = buildChunks(s.send === 'full' ? CMD.SET_BUTTONS : CMD.PARTIAL_UPDATE, zip);
  let failed = 0;
  for (const pkt of packets) if (!link.write(pkt)) failed++;
  sendFrame();
  const failNote = failed > 0 ? `, ${failed} WRITES FAILED` : '';
  log(
    `tx ${describeOutgoing(packets[0]!)} ${packets.length} packets, zip ${zip.length} B, ` +
      `pad retries ${retries}${failNote}`,
  );
  if (zip.length > page.maxZipBytes) {
    log(`   WARNING zip over ${page.maxZipBytes} B: the firmware may drop it silently`);
  }
  for (const [slot, icon] of icons) {
    log(`   slot ${slot}: ${icon.label}, ${icon.bytes.length} B`);
  }
}

function runStep(i: number): void {
  stepIdx = i;
  const s = STEPS[i]!;
  log('----------------------------------------------------------------');
  log(`STEP ${i + 1}/${STEPS.length}  ${s.id}  ${s.title}`);
  log(`   look: ${s.look}`);
  sendPage(s);
  log(
    `   Dversion=${firmware ?? '(not reported)'}  heartbeats=${heartbeats}.  ` +
      'Note the result, then press a REAL key for the next step.',
  );
}

function advance(): void {
  const now = Date.now();
  if (now - lastAdvanceAt < ADVANCE_DEBOUNCE_MS) return;
  lastAdvanceAt = now;
  if (stepIdx === STEPS.length - 1)
    log('end of steps - wrapping around to step 1 (Ctrl+C to quit)');
  runStep((stepIdx + 1) % STEPS.length);
}

function onReport(data: Uint8Array): void {
  const parsed = parseIncoming(data);
  if (parsed?.kind === 'heartbeat') {
    heartbeats++;
    return;
  }
  if (parsed?.kind === 'ack') return;
  log(`rx ${describeIncoming(parsed)}`);
  if (parsed?.kind === 'info') {
    firmware = parseDeviceVersion(parsed.json) ?? firmware;
    log(`Dversion=${firmware ?? '(no Dversion in the reply)'}  info ${parsed.json}`);
    return;
  }
  if (parsed?.kind === 'button' && parsed.pressed && parsed.slotId !== WIDE_SLOT) advance();
}

// ── Entry ──────────────────────────────────────────────────────────────────

function argValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const v = args[at + 1];
  if (v === undefined) fail(PREFIX, `usage: ${flag} <value>`);
  return v;
}

async function dumpGifs(dir: string): Promise<void> {
  await tjs.makeDir(dir, { recursive: true });
  const seen = new Set<Uint8Array>();
  for (const s of STEPS) {
    for (const icon of [...s.keys.values(), ...(s.wide ? [s.wide] : [])]) {
      if (icon.ext === 'jpg' || seen.has(icon.bytes)) continue;
      seen.add(icon.bytes);
      const file = `${dir}/${s.id}-${seen.size}.gif`;
      await tjs.writeFile(file, icon.bytes);
      log(`wrote ${file}: ${icon.label}, ${icon.bytes.length} B`);
    }
  }
}

async function handshake(): Promise<void> {
  // Same order as UlanziDriver.handshake(): frame, device info, drain, unlock, brightness.
  sendFrame();
  link.write(buildPacket(CMD.GET_DEVICE_INFO, 0));
  await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_DRAIN_MS));
  link.write(buildPacket(CMD.UNLOCK, 0));
  const level = encodeBrightness(DEFAULT_BRIGHTNESS);
  link.write(buildPacket(CMD.BRIGHTNESS, level.length, level));
}

async function main(): Promise<void> {
  const args = tjs.args.slice(3);
  await initProbeLibs();
  const userDir = argValue(args, '--dir');
  if (userDir !== undefined) STEPS.push(await userGifStep(userDir));

  if (args.includes('--list')) {
    STEPS.forEach((s, i) => console.log(`${String(i + 1).padStart(3)}  ${s.id}  ${s.title}`));
    return;
  }
  const dumpDir = argValue(args, '--dump');
  if (dumpDir !== undefined) {
    await dumpGifs(dumpDir);
    closeImageProc();
    return;
  }
  const start = Number(argValue(args, '--from') ?? '1') - 1;
  if (!Number.isInteger(start) || start < 0 || start >= STEPS.length) {
    fail(PREFIX, `--from needs a step number 1-${STEPS.length} (see --list)`);
  }

  const hidPath = findProbePath(model, PREFIX);
  link = new D200Link(onReport);
  try {
    link.open(hidPath);
  } catch (e) {
    fail(PREFIX, `open failed: ${(e as Error).message}`, ...OPEN_REFUSED_HINTS);
  }
  link.on('error', (e: Error) => log(`error: ${e.message}`));
  link.on('disconnect', () => {
    log('device disconnected');
    tjs.exit(1);
  });
  tjs.addSignalListener('SIGINT', () => {
    link.close();
    closeImageProc();
    tjs.exit(0);
  });

  await handshake();
  // Any outbound write feeds the firmware watchdog; the frame also keeps the window mode.
  setInterval(sendFrame, page.keepaliveMs);

  log(`D200 open. ${STEPS.length} steps; press a REAL key (not the info window) to advance.`);
  runStep(start);
}

await main();
