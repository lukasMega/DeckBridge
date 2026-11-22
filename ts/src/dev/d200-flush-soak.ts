import { closeImageProc } from '../ffi/image-proc.js';
import type { DeviceImageSpec } from '../devices/driver.js';
import { ULANZI_D200_MODEL } from '../devices/ulanzi/ulanzi-d200.js';
import { UlanziDriver } from '../devices/ulanzi/ulanzi-driver.js';
import { canvasSliceToBmp, transformImageForDevice } from '../transform/translator.js';
import type { KeyEvent } from '../shared/types.js';
import { OPEN_REFUSED_HINTS, fail, findProbePath, initProbeLibs } from './probe-utils.js';

// V6 soak (.claude/plans/2026-11-13_ulanzi-d200-hw-verification.md) at the quiet-window flush
// rate: other drivers saw the panel blank, presses lag and hid_write fail after ~17 min (O7).
// Load, through the real UlanziDriver: key 0 = a 1 Hz clock, key 1 = a busy key changing every
// 50 ms (keeps the flush rate at its minFlushIntervalMs floor), and every 5 s all keys change
// (a page switch). Watch the panel; press keys now and then (presses are logged with time).
//
// Usage: mise run d200-flush-soak [-- --minutes <n>]   (default 25)

const PREFIX = '[soak]';
const model = ULANZI_D200_MODEL;
const SIZE = 196;
const BUSY_MS = 50;
const PAGE_MS = 5000;
const REPORT_MS = 30_000;

const spec: DeviceImageSpec = {
  ...model.image,
  format: 'png',
  width: SIZE,
  height: SIZE,
  rotate: 0,
  flipH: false,
  flipV: false,
  maxBytes: 0,
};

const cache = new Map<string, Uint8Array>();
/** A solid colour with a white bar `fill` (0-1) wide along the bottom. */
function image(r: number, g: number, b: number, fill: number): Uint8Array {
  const key = `${r},${g},${b},${fill.toFixed(3)}`;
  let png = cache.get(key);
  if (png) return png;
  const rgb = new Uint8Array(SIZE * SIZE * 3);
  const barW = Math.round(fill * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const bar = y >= SIZE - 40 && x < barW;
      const i = (y * SIZE + x) * 3;
      rgb[i] = bar ? 255 : r;
      rgb[i + 1] = bar ? 255 : g;
      rgb[i + 2] = bar ? 255 : b;
    }
  }
  png = transformImageForDevice(canvasSliceToBmp(rgb, SIZE, SIZE, 0, SIZE), spec);
  cache.set(key, png);
  return png;
}

const hue = (i: number): [number, number, number] => {
  const h = (i % 12) / 12;
  const c = (n: number): number => Math.round(127 + 127 * Math.cos(2 * Math.PI * (h + n / 3)));
  return [c(0), c(1), c(2)];
};

function log(...parts: unknown[]): void {
  console.log(PREFIX, new Date().toISOString().slice(11, 19), ...parts);
}

async function main(): Promise<void> {
  const args = tjs.args.slice(3);
  const at = args.indexOf('--minutes');
  const minutes = at >= 0 ? Number(args[at + 1]) : 25;
  if (!Number.isFinite(minutes) || minutes <= 0) fail(PREFIX, '--minutes needs a positive number');

  await initProbeLibs();
  const driver = new UlanziDriver(model);
  // Counting taps on the driver's own flush and packet writes (private, probe only).
  const inner = driver as unknown as { flush(): void; writePacket(p: Uint8Array): boolean };
  const flush = inner.flush.bind(driver);
  const writePacket = inner.writePacket.bind(driver);
  let flushes = 0;
  let packets = 0;
  let failedWrites = 0;
  let firstFailAt: number | null = null;
  inner.flush = () => {
    flushes++;
    flush();
  };
  inner.writePacket = (p) => {
    packets++;
    const ok = writePacket(p);
    if (!ok) {
      failedWrites++;
      firstFailAt ??= Date.now();
    }
    return ok;
  };

  try {
    await driver.open(findProbePath(model, PREFIX));
  } catch (e) {
    fail(PREFIX, `open failed: ${(e as Error).message}`, ...OPEN_REFUSED_HINTS);
  }
  const startedAt = Date.now();
  const elapsed = (): string => `${((Date.now() - startedAt) / 60_000).toFixed(1)} min`;
  driver.on('error', (e: Error) => log(`error at ${elapsed()}: ${e.message}`));
  driver.on('disconnect', () => {
    log(`DISCONNECTED at ${elapsed()}`);
    tjs.exit(1);
  });
  driver.on('key', (k: KeyEvent) => {
    if (k.state === 'down') log(`press slot ${k.keyIndex} at ${elapsed()}`);
  });

  const keys = (model.keyMap.coraToWireImage ?? []).filter((s) => s >= 0);
  let page = 0;
  let busy = 0;
  const paintPage = (): void => {
    page++;
    for (const slot of keys.slice(2)) driver.sendImage(slot, image(...hue(page + slot), 0));
  };
  paintPage();
  const timers = [
    setInterval(() => {
      const s = new Date().getSeconds();
      driver.sendImage(keys[0]!, image(40, 40, 40, s / 59));
    }, 1000),
    setInterval(() => driver.sendImage(keys[1]!, image(...hue(busy++), 0)), BUSY_MS),
    setInterval(paintPage, PAGE_MS),
    setInterval(() => {
      const mins = (Date.now() - startedAt) / 60_000;
      log(
        `${elapsed()}: ${flushes} flushes (${(flushes / (mins * 60)).toFixed(1)}/s), ` +
          `${packets} packets, ${failedWrites} failed writes` +
          (firstFailAt === null
            ? ''
            : `, first failure at ${((firstFailAt - startedAt) / 60_000).toFixed(1)} min`),
      );
    }, REPORT_MS),
  ];

  const stop = async (why: string): Promise<void> => {
    for (const t of timers) clearInterval(t);
    log(
      `${why} after ${elapsed()}: ${flushes} flushes, ${packets} packets, ${failedWrites} failed writes`,
    );
    await driver.close();
    closeImageProc();
    tjs.exit(failedWrites > 0 ? 1 : 0);
  };
  tjs.addSignalListener('SIGINT', () => void stop('stopped'));
  setTimeout(() => void stop('done'), minutes * 60_000);
  log(
    `running ${minutes} min on ${keys.length} keys: clock slot ${keys[0]}, busy slot ${keys[1]}, page every ${PAGE_MS / 1000} s`,
  );
}

await main();
