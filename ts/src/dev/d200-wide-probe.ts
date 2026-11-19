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
import {
  buildManifest,
  buildSafeZip,
  entry,
  iconName,
  slotKey,
  type ZipEntry,
} from '../devices/ulanzi/ulanzi-zip.js';
import { DEFAULT_BRIGHTNESS } from '../shared/types.js';
import { D200Link } from './d200-link.js';
import { iconBytes, type IconSpec } from './d200-wide-images.js';
import { OPEN_REFUSED_HINTS, fail, findProbePath, initProbeLibs } from './probe-utils.js';

// Phase 0 of .claude/plans/2026-11-18_ulanzi-d200-wide-key.md (questions P1-P8).
//
// Drives the wide info window ("3_2") by hand: each step sends one manifest and/or
// SMALL_WINDOW frame and logs exactly what went out. Press a REAL key to advance;
// a press on the wide window itself is only logged (P4). Write what you see next
// to the step id and paste it into plan section 9.
//
// Usage: mise run d200-wide-probe [-- --list | --dump <dir> | --from <n>]
//   --list       print the steps and exit (no device needed)
//   --dump <dir> write the generated test images there and exit (no device needed)
//   --from <n>   start at step n instead of 1

const PREFIX = '[d200]';
const model = ULANZI_D200_MODEL;
const page = model.page!;
const WIDE_SLOT = page.smallWindowSlot.row * model.columns + page.smallWindowSlot.col;
const WIDE_KEY = slotKey(WIDE_SLOT, model.columns);
const READ_POLL_MS = 5;
// Same drain the driver uses before the first page (ulanzi-driver.ts HANDSHAKE_DRAIN_MS).
const HANDSHAKE_DRAIN_MS = 250;
const ADVANCE_DEBOUNCE_MS = 500;
// After a wide press, mode frames pause this long so a firmware-side mode change
// is not immediately overwritten by our keepalive (P4).
const WIDE_PRESS_QUIET_MS = 4000;
const AUTO_SUFFIX = 'auto';
const ASCII = new TextEncoder();

function log(...parts: unknown[]): void {
  console.log(PREFIX, ...parts);
}

// ── Steps ──────────────────────────────────────────────────────────────────

interface WindowState {
  mode: number;
  cpu: number;
  mem: number;
  gpu: number;
  hourFormat: string;
  /** AUTO_SUFFIX = AM/PM from the local time. */
  suffix: string;
  /** Send the frame's clock as 12-hour text; the firmware may or may not convert. */
  time12: boolean;
  /** Mode-2 background, sent as the `Icon` of the wide manifest entry. */
  icon: IconSpec | null;
  /** Verbatim frame for values encodeSmallWindow would round. */
  raw?: (time: string) => string;
}

/** 'full' = SET_BUTTONS page, 'partial' = PARTIAL_UPDATE page, 'frame' = SMALL_WINDOW. */
type Send = 'full' | 'partial' | 'frame';

interface Step {
  id: string;
  title: string;
  look: string;
  state: WindowState;
  send: Send[];
  /** 'neutral' feeds the watchdog with a brightness write, so only `send` can change the window. */
  keepalive: 'frame' | 'neutral';
}

const BASE: WindowState = {
  mode: 203,
  cpu: 0,
  mem: 0,
  gpu: 0,
  hourFormat: '24H',
  suffix: '',
  time12: false,
  icon: null,
};

function step(
  id: string,
  title: string,
  look: string,
  state: Partial<WindowState>,
  opts: { send?: Send[]; keepalive?: 'frame' | 'neutral' } = {},
): Step {
  return {
    id,
    title,
    look,
    state: { ...BASE, ...state },
    send: opts.send ?? ['full', 'frame'],
    keepalive: opts.keepalive ?? 'frame',
  };
}

const MODES: ReadonlyArray<readonly [number, string]> = [
  [0, 'stats'],
  [1, 'dial'],
  [2, 'background image, no Icon'],
  [200, 'digital 200'],
  [201, 'digital 201'],
  [202, 'digital 202'],
  [203, 'digital 203, the current default'],
];
const IMAGE_LOOK =
  'Highest ruler number visible, which corner squares show (TL red, TR green, BL blue, ' +
  'BR yellow), white border on all 4 sides, cyan line (x=196) / magenta line (x=392), ' +
  'digits upright or rotated, scaled / cropped / centered / solid color?';
const PRESS_LOOK =
  'PRESS THE WIDE WINDOW 2-3 times and watch for ~4 s. Does the panel change mode on its own? ' +
  'Check the rx lines for the press report.';

function iconStep(id: string, w: number, format: IconSpec['format']): Step {
  const label = format === 'png' ? 'PNG' : 'JPEG';
  return step(id, `mode 2 + Icon ${w}x196 ${label}`, IMAGE_LOOK, {
    mode: 2,
    icon: { w, h: 196, format },
  });
}

const statsStep = (title: string, state: Partial<WindowState>): Step =>
  step('P5', `mode 0 ${title}`, 'Which field shows what, number format, "%" sign, clipping.', {
    mode: 0,
    ...state,
  });

const clockStep = (title: string, state: Partial<WindowState>): Step =>
  step('P6', `mode 203 ${title}`, 'Clock text: 24h or 12h, is the suffix drawn, where?', state);

const resetStep = (): Step =>
  step('P7', 'reset: mode 203 (SET_BUTTONS + SMALL_WINDOW)', 'Digital clock shown.', {});

const modeChangeStep = (via: string, send: Send): Step =>
  step(
    'P7',
    `${via} only -> mode 1 (dial), keepalive neutral`,
    'Does the window switch to the dial? If it stays a clock, this opcode did not apply the mode.',
    { mode: 1 },
    { send: [send], keepalive: 'neutral' },
  );

const STEPS: Step[] = [
  ...MODES.map(([mode, name]) =>
    step('P1', `SmallViewMode ${mode} (${name})`, 'What renders? Does it tick / update live?', {
      mode,
    }),
  ),
  step('P4', 'press the wide window in mode 203 (clock)', PRESS_LOOK, { mode: 203 }),
  step('P4', 'press the wide window in mode 1 (dial)', PRESS_LOOK, { mode: 1 }),
  step('P4', 'press the wide window in mode 0 (stats)', PRESS_LOOK, { mode: 0 }),
  iconStep('P2', 392, 'png'),
  iconStep('P2', 458, 'png'),
  iconStep('P2', 196, 'png'),
  iconStep('P3', 392, 'jpeg'),
  iconStep('P3', 458, 'jpeg'),
  step('P4', 'press the wide window in mode 2 (392x196 PNG)', PRESS_LOOK, {
    mode: 2,
    icon: { w: 392, h: 196, format: 'png' },
  }),
  statsStep('cpu/mem/gpu = 12/34/56', { cpu: 12, mem: 34, gpu: 56 }),
  statsStep('cpu/mem/gpu = 100/100/100', { cpu: 100, mem: 100, gpu: 100 }),
  statsStep('raw decimals 12.5/34.5/56.5', { raw: (t) => `0|12.5|34.5|${t}|56.5|24H|` }),
  clockStep('24H, suffix ""', { hourFormat: '24H' }),
  clockStep('12H, suffix ""', { hourFormat: '12H' }),
  clockStep('12H, suffix AM', { hourFormat: '12H', suffix: 'AM' }),
  clockStep('12H, suffix PM', { hourFormat: '12H', suffix: 'PM' }),
  clockStep('24H, suffix AM (does the suffix leak into 24H?)', { suffix: 'AM' }),
  clockStep('12H, 12-hour clock text + matching suffix', {
    hourFormat: '12H',
    suffix: AUTO_SUFFIX,
    time12: true,
  }),
  resetStep(),
  modeChangeStep('PARTIAL_UPDATE', 'partial'),
  resetStep(),
  modeChangeStep('SET_BUTTONS', 'full'),
  resetStep(),
  modeChangeStep('SMALL_WINDOW', 'frame'),
  resetStep(),
];

// ── Probe state ────────────────────────────────────────────────────────────

let link: D200Link;
let firmware: string | undefined;
let heartbeats = 0;
let flushSeq = 0;
let stepIdx = 0;
let quietUntil = 0;
let lastAdvanceAt = 0;

const hex = (data: Uint8Array): string =>
  Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');

function clockText(twelve: boolean): string {
  const now = new Date();
  if (!twelve) return formatClock(now);
  return `${String(now.getHours() % 12 || 12).padStart(2, '0')}${formatClock(now).slice(2)}`;
}

function frameBytes(s: WindowState): Uint8Array {
  const time = clockText(s.time12);
  if (s.raw) return ASCII.encode(s.raw(time));
  const amPm = new Date().getHours() < 12 ? 'AM' : 'PM';
  const suffix = s.suffix === AUTO_SUFFIX ? amPm : s.suffix;
  return encodeSmallWindow({
    mode: s.mode,
    cpu: s.cpu,
    mem: s.mem,
    gpu: s.gpu,
    time,
    hourFormat: s.hourFormat,
    suffix,
  });
}

function sendFrame(s: WindowState, verbose: boolean): void {
  const payload = frameBytes(s);
  const pkt = buildPacket(CMD.SMALL_WINDOW, payload.length, payload);
  link.write(pkt);
  if (verbose) log(`tx ${describeOutgoing(pkt)}`);
}

/** One page archive holding only the wide entry (plus its Icon in mode 2). */
function sendPage(full: boolean, s: WindowState): void {
  const seq = flushSeq++;
  const manifest = JSON.parse(
    buildManifest([], {
      columns: model.columns,
      smallWindowMode: s.mode,
      smallWindowSlot: page.smallWindowSlot,
      font: DEFAULT_FONT,
      flushSeq: seq,
    }),
  ) as Record<string, { ViewParam: Array<Record<string, unknown>> }>;
  const files: ZipEntry[] = [];
  let iconNote = 'no Icon';
  if (s.icon) {
    const bytes = iconBytes(s.icon);
    const name = iconName(WIDE_SLOT, seq, bytes);
    manifest[WIDE_KEY]!.ViewParam[0]!.Icon = name;
    files.push(entry(name, bytes));
    iconNote = `Icon ${name} (${bytes.length} B)`;
  }
  const manifestText = JSON.stringify(manifest);
  const { zip, retries } = buildSafeZip([
    entry('manifest.json', ASCII.encode(manifestText)),
    ...files,
    entry('sentinel.txt', new Uint8Array(0)),
  ]);
  const cmd = full ? CMD.SET_BUTTONS : CMD.PARTIAL_UPDATE;
  const packets = buildChunks(cmd, zip);
  let failed = 0;
  for (const pkt of packets) if (!link.write(pkt)) failed++;
  const failNote = failed > 0 ? `, ${failed} WRITES FAILED` : '';
  log(
    `tx ${describeOutgoing(packets[0]!)} ${packets.length} packets, ${iconNote}, ` +
      `pad retries ${retries}${failNote}`,
  );
  log(`   manifest ${manifestText}`);
}

function runStep(i: number): void {
  stepIdx = i;
  const s = STEPS[i]!;
  quietUntil = 0;
  log('----------------------------------------------------------------');
  log(`STEP ${i + 1}/${STEPS.length}  ${s.id}  ${s.title}`);
  log(`   look: ${s.look}`);
  for (const how of s.send) {
    if (how === 'frame') sendFrame(s.state, true);
    else sendPage(how === 'full', s.state);
  }
  log(
    `   Dversion=${firmware ?? '(not reported)'}  heartbeats=${heartbeats}  ` +
      `keepalive=${s.keepalive}.  Note the result, then press a REAL key for the next step.`,
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

function keepaliveTick(): void {
  const s = STEPS[stepIdx]!;
  if (s.keepalive === 'frame' && Date.now() >= quietUntil) {
    sendFrame(s.state, false);
    return;
  }
  // Any outbound write feeds the firmware watchdog; brightness changes nothing visible.
  const level = encodeBrightness(DEFAULT_BRIGHTNESS);
  link.write(buildPacket(CMD.BRIGHTNESS, level.length, level));
}

function onReport(data: Uint8Array): void {
  const parsed = parseIncoming(data);
  if (parsed?.kind === 'heartbeat') {
    heartbeats++;
    return;
  }
  log(`rx ${describeIncoming(parsed)}   raw ${hex(data.subarray(0, 16))}`);
  if (parsed?.kind === 'info') {
    firmware = parseDeviceVersion(parsed.json) ?? firmware;
    log(`P8 Dversion=${firmware ?? '(no Dversion in the reply)'}`);
    return;
  }
  if (parsed?.kind !== 'button' || !parsed.pressed) return;
  if (parsed.slotId === WIDE_SLOT) {
    quietUntil = Date.now() + WIDE_PRESS_QUIET_MS;
    const s = STEPS[stepIdx]!;
    log(
      `P4 WIDE WINDOW PRESS during step ${stepIdx + 1} (${s.id} ${s.title}) - look at the ` +
        `panel now; mode frames paused for ${WIDE_PRESS_QUIET_MS / 1000} s`,
    );
    return;
  }
  advance();
}

// ── Entry ──────────────────────────────────────────────────────────────────

function printSteps(): void {
  STEPS.forEach((s, i) => {
    console.log(`${String(i + 1).padStart(3)}  ${s.id}  ${s.title}`);
  });
}

async function dumpImages(dir: string): Promise<void> {
  await tjs.makeDir(dir, { recursive: true });
  const specs: IconSpec[] = [
    { w: 392, h: 196, format: 'png' },
    { w: 458, h: 196, format: 'png' },
    { w: 196, h: 196, format: 'png' },
    { w: 392, h: 196, format: 'jpeg' },
    { w: 458, h: 196, format: 'jpeg' },
  ];
  for (const spec of specs) {
    const bytes = iconBytes(spec);
    const file = `${dir}/ruler-${spec.w}x${spec.h}.${spec.format === 'png' ? 'png' : 'jpg'}`;
    await tjs.writeFile(file, bytes);
    log(`wrote ${file} (${bytes.length} B)`);
  }
}

async function handshake(): Promise<void> {
  // Same order as UlanziDriver.handshake(): frame, device info, drain, unlock, brightness, page.
  sendFrame(BASE, false);
  link.write(buildPacket(CMD.GET_DEVICE_INFO, 0));
  await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_DRAIN_MS));
  link.write(buildPacket(CMD.UNLOCK, 0));
  const level = encodeBrightness(DEFAULT_BRIGHTNESS);
  link.write(buildPacket(CMD.BRIGHTNESS, level.length, level));
  sendPage(true, BASE);
}

async function main(): Promise<void> {
  const args = tjs.args.slice(3);
  await initProbeLibs();

  if (args.includes('--list')) {
    printSteps();
    return;
  }
  const dumpAt = args.indexOf('--dump');
  if (dumpAt >= 0) {
    const dir = args[dumpAt + 1];
    if (dir === undefined) fail(PREFIX, 'usage: --dump <dir>');
    await dumpImages(dir);
    closeImageProc();
    return;
  }
  const fromAt = args.indexOf('--from');
  const start = fromAt >= 0 ? Number(args[fromAt + 1]) - 1 : 0;
  if (!Number.isInteger(start) || start < 0 || start >= STEPS.length) {
    fail(PREFIX, `--from needs a step number 1-${STEPS.length} (see --list)`);
  }

  const hidPath = findProbePath(model, PREFIX);
  link = new D200Link(onReport, READ_POLL_MS);
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
  setInterval(keepaliveTick, page.keepaliveMs);

  log(`D200 open. ${STEPS.length} steps; press a REAL key (not the wide window) to advance.`);
  log('Wide-window presses are only logged (P4). rx = every report except heartbeats.');
  log(`Dversion=${firmware ?? '(not reported yet)'} (P8: note it next to the P4 results)`);
  runStep(start);
}

await main();
