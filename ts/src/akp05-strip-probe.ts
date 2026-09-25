import { Akp05Driver } from './devices/ajazz/akp05-driver.js';
import { AKP05_CLEAR_ALL, buildCle, buildDis, buildStp } from './devices/ajazz/akp05-protocol.js';
import { findAkp05Device, initProbeLibs } from './probe-utils.js';
import { canvasSliceToBmp, closeSidecar, transformImageForDevice } from './translator.js';
import type { DeviceImageSpec } from './devices/driver.js';
import page from './akp05-strip-probe.html';

// AKP05/AKP05E touch-strip output, round 4: where exactly is the upload byte cap, where
// does each wire id's slot sit and how big is it, and do the keys survive a feature
// report 0x01 read. Findings and the stage design:
// .claude/plans/2026-09-23_akp05-strip-probe-findings.md.
// Usage: mise run akp05-strip-probe, then answer in the browser page it opens
// (http://127.0.0.1:3077/). Answers are saved to ts/dist/akp05-strip-probe-answers.json.

const PREFIX = '[akp05-strip]';
const STRIP_WIDTH = 800;
const STRIP_HEIGHT = 112;
const BAND_HEIGHT = 16;

type Rgb = readonly [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const GREY: Rgb = [90, 90, 90];
const GREEN: Rgb = [0, 255, 0];
const YELLOW: Rgb = [255, 220, 0];
const NAVY: Rgb = [0, 0, 110];
const MARKER_COLORS: readonly Rgb[] = [
  [255, 60, 60],
  [255, 150, 0],
  [0, 220, 220],
  [230, 110, 255],
];

// 3×5 digit glyphs, one row per string.
const DIGITS: readonly (readonly string[])[] = [
  ['111', '101', '101', '101', '111'],
  ['010', '110', '010', '010', '111'],
  ['111', '001', '111', '100', '111'],
  ['111', '001', '111', '001', '111'],
  ['101', '101', '111', '001', '001'],
  ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'],
  ['111', '001', '001', '001', '001'],
  ['111', '101', '111', '101', '111'],
  ['111', '101', '111', '001', '111'],
];

class Canvas {
  readonly rgb: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgb = new Uint8Array(width * height * 3);
  }

  fill(x: number, y: number, w: number, h: number, color: Rgb): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let row = y0; row < y1; row++) {
      for (let col = x0; col < x1; col++) this.rgb.set(color, (row * this.width + col) * 3);
    }
  }

  text(x: number, y: number, digits: string, scale: number, color: Rgb): void {
    for (let i = 0; i < digits.length; i++) {
      const glyph = DIGITS[Number(digits[i])]!;
      const gx = x + i * 4 * scale;
      glyph.forEach((bits, row) => {
        for (let col = 0; col < 3; col++) {
          if (bits[col] === '1') this.fill(gx + col * scale, y + row * scale, scale, scale, color);
        }
      });
    }
  }

  toBmp(): Uint8Array {
    return canvasSliceToBmp(this.rgb, this.width, this.height, 0, this.width);
  }
}

/** Round 3: 7.6 KB showed in full, 40.8 KB only its first ~2 of 7 label rows. */
const SAFE_JPEG_BYTES = 9500;
/** Ladder targets bracketing 10 and 12 chunks of 1024 B, the likeliest buffer sizes. */
const LADDER_TARGETS = [9000, 10000, 10200, 10300, 11000, 12200, 12400, 14000];
/** Lets one upload finish decoding before the next BAT, so uploads don't race. */
const SETTLE_MS = 200;
/** How long the key check waits for presses after the feature report read. */
const KEY_WATCH_MS = 8000;

/** x ruler with the labels repeated in every 16-row band, so they show whichever
 *  rows are visible: ticks every 10 px, a grey line and a label every 100 px, green
 *  left and yellow right edge. */
function xRuler(): Canvas {
  const c = new Canvas(STRIP_WIDTH, STRIP_HEIGHT);
  for (let x = 0; x < STRIP_WIDTH; x += 100) c.fill(x, 0, 1, STRIP_HEIGHT, GREY);
  for (let y = 0; y < STRIP_HEIGHT; y += BAND_HEIGHT) {
    for (let x = 0; x < STRIP_WIDTH; x += 10) c.fill(x, y, 1, x % 50 === 0 ? 6 : 3, WHITE);
    for (let x = 0; x < STRIP_WIDTH; x += 100) c.text(x + 3, y + 4, String(x), 2, WHITE);
  }
  c.fill(0, 0, 2, STRIP_HEIGHT, GREEN);
  c.fill(STRIP_WIDTH - 2, 0, 2, STRIP_HEIGHT, YELLOW);
  return c;
}

function solid(color: Rgb): Canvas {
  const c = new Canvas(STRIP_WIDTH, STRIP_HEIGHT);
  c.fill(0, 0, STRIP_WIDTH, STRIP_HEIGHT, color);
  return c;
}

/** Solid block with the wire id as a big black digit, green left and yellow right edge. */
function slotMarker(wireId: number, width: number, height: number): Canvas {
  const c = new Canvas(width, height);
  c.fill(0, 0, width, height, MARKER_COLORS[wireId - 1]!);
  c.text((width - 24) / 2, 8, String(wireId), 8, BLACK);
  c.fill(0, 0, 3, height, GREEN);
  c.fill(width - 3, 0, 3, height, YELLOW);
  return c;
}

/** Busy-wait: an awaited sleep would let the keepalive timer write mid-sequence. */
function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // wait
  }
}

class ProbeDriver extends Akp05Driver {
  private readonly scratch = Buffer.alloc(1025);

  writePacket(packet: Buffer): void {
    this.scratch[0] = 0;
    this.scratch.set(packet, 1);
    const n = this._writeRaw(this.scratch, 'hid', (r, e) => `probe write ${r}: ${e}`);
    if (n < 0) console.log(`${PREFIX} hid_write failed (${n})`);
  }

  /** mirajazz reads the firmware version from feature report 0x01 into 20 bytes.
   *  Returns the reply as hex + printable ASCII, or the error. */
  readFeatureReport(reportId: number, size: number): string {
    if (!this.device || !this.hidLib) return 'device not open';
    const buf = new Uint8Array(size);
    buf[0] = reportId;
    const n = this.hidLib.symbols.hid_get_feature_report(this.device, buf, buf.length);
    if (n < 0) return `hid_get_feature_report returned ${n}`;
    const report = buf.subarray(0, n);
    const ascii = String.fromCharCode(...report).replace(/[^\x20-\x7e]/g, '.');
    return `${n} B: ${Buffer.from(report).toString('hex')}  "${ascii}"`;
  }
}

await initProbeLibs();

const { model, hidPath } = findAkp05Device(PREFIX);
const driver = new ProbeDriver(model);
try {
  await driver.open(hidPath);
} catch (e) {
  console.log(`${PREFIX} open failed: ${(e as Error).message}`);
  console.log(`${PREFIX} on macOS grant Input Monitoring to this terminal, then reopen it.`);
  tjs.exit(1);
}

const baseSpec: DeviceImageSpec = {
  ...model.image,
  rotate: 180,
  maxBytes: 0,
  sharpen: 0,
  resizeFilter: 'nearest',
};

/** `maxBytes` > 0 makes the transform step the quality down until the JPEG fits. */
function encode(c: Canvas, maxBytes = 0, quality = baseSpec.quality): Buffer {
  return transformImageForDevice(c.toBmp(), {
    ...baseSpec,
    width: c.width,
    height: c.height,
    maxBytes,
    quality,
  });
}

/** The ruler at every quality 1..100; per target, the encoding closest in size. The
 *  driver's own maxBytes loop steps quality by 5, too coarse to hit these sizes. */
function rulerLadder(): Buffer[] {
  const bmp = xRuler();
  const all: Buffer[] = [];
  for (let q = 1; q <= 100; q++) all.push(encode(bmp, 0, q / 100));
  const picked = LADDER_TARGETS.map((target) =>
    all.reduce(
      (best, jpeg) =>
        Math.abs(jpeg.length - target) < Math.abs(best.length - target) ? jpeg : best,
      all[0]!,
    ),
  );
  return [...new Set(picked)].toSorted((a, b) => a.length - b.length);
}

const wipeJpeg = encode(solid(NAVY));
const smallRuler = encode(xRuler(), SAFE_JPEG_BYTES);
const ladder = rulerLadder();

/** Navy strip, then the under-cap ruler: the backdrop every stage reads against. */
function wipe(withRuler: boolean): void {
  driver.sendImage(1, wipeJpeg);
  spin(SETTLE_MS);
  if (!withRuler) return;
  driver.sendImage(1, smallRuler);
  spin(SETTLE_MS);
}

function sendMarkers(wireIds: readonly number[], width: number, height: number): string {
  const sizes = wireIds.map((wireId) => {
    const jpeg = encode(slotMarker(wireId, width, height), SAFE_JPEG_BYTES);
    driver.sendImage(wireId, jpeg);
    spin(SETTLE_MS);
    return jpeg.length;
  });
  return sizes.map((n) => `${n} B`).join(', ');
}

interface Question {
  text: string;
  kind: 'yesno' | 'number';
  min?: number;
  max?: number;
}

interface Stage {
  label: string;
  ask: Question[];
  run: () => string | undefined;
}

const yesNo = (text: string): Question => ({ text, kind: 'yesno' });

function ladderStage(jpeg: Buffer): Stage {
  return {
    label: `x ruler, ${jpeg.length} B (${Math.ceil(jpeg.length / 1024)} chunks), wire id 1`,
    ask: [
      { text: 'How many rows of ruler numbers can you read?', kind: 'number', min: 0, max: 7 },
      yesNo('Any colour noise or garbage on the strip?'),
    ],
    run: () => {
      wipe(false);
      driver.sendImage(1, jpeg);
      return undefined;
    },
  };
}

const stages: Stage[] = [
  { label: 'init only', ask: [yesNo('Is the strip black?')], run: () => undefined },
  ...ladder.map(ladderStage),
  {
    label: 'four 176×56 blocks at wire ids 1–4, over the ruler',
    ask: [
      yesNo('Do you see 4 blocks, digits 1, 2, 3, 4 from left to right?'),
      yesNo('Does block 1 start at the left end of the strip?'),
      yesNo('Does block 2 start just right of the 200 line?'),
      yesNo('Does block 3 start just right of the 400 line?'),
      yesNo('Does block 4 start just right of the 600 line?'),
      yesNo('Does block 4 end at the right end of the strip?'),
      yesNo('Can you see the ruler in the gaps between the blocks?'),
      yesNo('Does each block sit above one encoder?'),
    ],
    run: () => {
      wipe(true);
      return sendMarkers([1, 2, 3, 4], 176, 56);
    },
  },
  {
    label: 'four 176×112 blocks at wire ids 1–4, over the ruler',
    ask: [
      yesNo('Does each block fill the full strip height, top to bottom?'),
      yesNo('Can you see any ruler numbers above the blocks?'),
    ],
    run: () => {
      wipe(true);
      return sendMarkers([1, 2, 3, 4], 176, 112);
    },
  },
  {
    label: 'one 200×112 block at wire id 2 (wider than the 176 px slot), over the ruler',
    ask: [
      yesNo('Is the yellow stripe at the right edge of block 2 visible?'),
      yesNo('Does block 2 reach past the 400 line?'),
    ],
    run: () => {
      wipe(true);
      return sendMarkers([2], 200, 112);
    },
  },
];

// ── probe state, as the browser page sees it ──

const ANSWERS_FILE = 'dist/akp05-strip-probe-answers.json';
const PORT = 3077;

interface StageRecord {
  stage: number;
  label: string;
  detail?: string;
  answers: { [id: string]: { question: string; answer: string } };
  note?: string;
  at: string;
}

let stage = 0;
let detail: string | undefined;
let auto = false;
let done = false;
const log: string[] = [];
const records: StageRecord[] = [];
/** Set while the feature report check counts key presses. */
let keyWatch: { downs: number } | null = null;

const questionId = (i: number): string => `Q${stage}.${i + 1}`;

function state(): object {
  const s = stages[stage];
  return {
    stage,
    total: stages.length + 1,
    label: s?.label ?? 'automatic check: feature report 0x01 and the keys',
    detail,
    questions: auto || done ? [] : s!.ask.map((q, i) => ({ id: questionId(i), ...q })),
    auto,
    done,
    log,
    answersFile: `ts/${ANSWERS_FILE}`,
  };
}

function runStage(): void {
  log.length = 0;
  try {
    detail = stages[stage]!.run();
  } catch (err) {
    detail = `stage failed: ${(err as Error).message}`;
  }
  const suffix = detail ? `  [${detail}]` : '';
  console.log(`${PREFIX} stage ${stage}: ${stages[stage]!.label}${suffix}`);
}

async function saveRecords(): Promise<void> {
  const file = { ladderSizes: ladder.map((j) => j.length), records, checkLog: log };
  await tjs.writeFile(ANSWERS_FILE, JSON.stringify(file, null, 2));
}

async function submitAnswers(body: {
  stage?: number;
  answers?: { [id: string]: string | number };
  note?: string;
}): Promise<void> {
  // A double click must not record one stage twice or skip the next one.
  if (auto || done || body.stage !== stage) return;
  const s = stages[stage]!;
  const answers: StageRecord['answers'] = {};
  s.ask.forEach((q, i) => {
    const id = questionId(i);
    answers[id] = { question: q.text, answer: String(body.answers?.[id] ?? '') };
    console.log(`${PREFIX}   ${id} ${answers[id].answer}  (${q.text})`);
  });
  const note = body.note?.trim() || undefined;
  if (note) console.log(`${PREFIX}   note: ${note}`);
  records.push({ stage, label: s.label, detail, answers, note, at: new Date().toISOString() });
  await saveRecords();
  stage++;
  if (stage < stages.length) {
    runStage();
    return;
  }
  auto = true;
  detail = undefined;
  void featureReportCheck()
    .catch((err: unknown) => say(`check failed: ${(err as Error).message}`))
    .finally(() => {
      auto = false;
      done = true;
      void saveRecords();
    });
}

function say(line: string): void {
  log.push(line);
  console.log(`${PREFIX}   ${line}`);
}

async function countKeyPresses(when: string): Promise<number> {
  say(`${when}: press LCD keys a few times NOW (${KEY_WATCH_MS / 1000} s)`);
  const watch = { downs: 0 };
  keyWatch = watch;
  await new Promise((resolve) => setTimeout(resolve, KEY_WATCH_MS));
  keyWatch = null;
  say(`  -> ${watch.downs} key presses seen`);
  return watch.downs;
}

/** Round 3: the keys stopped after this read. Measures that, then tries a light
 *  re-init and a full reopen. Logs its own results, no answers needed. */
async function featureReportCheck(): Promise<void> {
  if ((await countKeyPresses('before the read')) === 0) {
    say('no presses before the read either; the check means nothing');
    return;
  }
  say(`feature report 0x01: ${driver.readFeatureReport(0x01, 20)}`);
  if ((await countKeyPresses('after the read')) > 0) return;
  driver.writePacket(buildDis());
  driver.writePacket(buildCle(AKP05_CLEAR_ALL));
  driver.writePacket(buildStp());
  if ((await countKeyPresses('after DIS + CLE + STP')) > 0) return;
  await driver.close();
  await driver.open(hidPath);
  await countKeyPresses('after close + reopen');
}

driver.on('key', (e: { state: string }) => {
  if (e.state === 'down' && keyWatch) keyWatch.downs++;
});

async function readBody(req: Request): Promise<object> {
  try {
    return (JSON.parse(await req.text()) as object | null) ?? {};
  } catch {
    return {};
  }
}

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

async function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === 'GET' && path === '/') {
    return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (req.method === 'GET' && path === '/api/state') return json(state());
  if (req.method !== 'POST') return new Response(null, { status: 404 });
  if (path === '/api/answers') await submitAnswers(await readBody(req));
  else if (path === '/api/rerun' && !auto && !done) runStage();
  else if (path === '/api/quit') setTimeout(() => void shutdown(), 100);
  else return new Response(null, { status: 404 });
  return json(state());
}

const server = tjs.serve({ port: PORT, listenIp: '127.0.0.1', fetch: handle });

async function shutdown(): Promise<void> {
  server.stop();
  await driver.close();
  closeSidecar();
  tjs.exit(0);
}

tjs.addSignalListener('SIGINT', () => void shutdown());

const url = `http://127.0.0.1:${PORT}/`;
console.log(`${PREFIX} ladder sizes: ${ladder.map((j) => j.length).join(', ')} B`);
console.log(`${PREFIX} open ${url} and answer there; LCD keys do not advance stages`);
try {
  tjs.spawn(['open', url]);
} catch {
  // not macOS: open the URL by hand
}
runStage();
