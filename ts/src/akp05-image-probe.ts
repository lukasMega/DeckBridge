import { Akp05Driver } from './devices/ajazz/akp05-driver.js';
import { AKP05_CLEAR_ALL, buildCle, buildStp } from './devices/ajazz/akp05-protocol.js';
import { AJAZZ_AKP05E_MODEL } from './devices/ajazz/akp05e.js';
import { AJAZZ_AKP05_MODEL } from './devices/ajazz/akp05.js';
import { listHidPaths } from './ffi/hidapi.js';
import { initProbeLibs } from './probe-utils.js';
import { SPLASH_STATES } from './assets/splash-states.js';
import { splashSpec } from './splash-sender.js';
import { closeSidecar, transformImageForDevice } from './translator.js';
import type { DeviceModel } from './devices/driver.js';

// AKP05E top-row line artifacts: any lit key leaves lines on the top key of its column.
// Press any LCD key to advance one stage. Usage: mise run akp05-image-probe.

const PREFIX = '[akp05-img]';

class ProbeDriver extends Akp05Driver {
  writes = 0;

  protected override _writeRaw(
    buf: Uint8Array,
    logTag: string,
    message: (n: number, errStr: string) => string,
  ): number {
    const n = super._writeRaw(buf, logTag, message);
    this.writes++;
    return n;
  }

  writePacket(packet: Buffer): void {
    // Same framing as the driver's private write(): report id 0 + one 1024 B packet.
    const report = Buffer.alloc(1025);
    report.set(packet, 1);
    this._writeRaw(report, 'hid', (n, e) => `probe write ${n}: ${e}`);
  }
}

await initProbeLibs();

let model: DeviceModel | null = null;
let hidPath: string | null = null;
for (const candidate of [AJAZZ_AKP05E_MODEL, AJAZZ_AKP05_MODEL]) {
  for (const pid of candidate.usbProductIds) {
    const paths = listHidPaths(candidate.usbVendorId, candidate.usagePage!, candidate.usage!, pid);
    if (paths.length === 0) continue;
    model = candidate;
    hidPath = paths[0]!;
    break;
  }
  if (model) break;
}
if (!model || !hidPath) {
  console.log(`${PREFIX} no AKP05/AKP05E found — stop any running DeckBridge (exclusive open).`);
  tjs.exit(1);
}

const spec = splashSpec(model);
const splash = transformImageForDevice(Buffer.from(SPLASH_STATES.connected, 'base64'), spec);
console.log(`${PREFIX} splash ${splash.length} B (${spec.width}×${spec.height})`);

const driver = new ProbeDriver(model);
await driver.open(hidPath);

function clearAll(): void {
  driver.writePacket(buildCle(AKP05_CLEAR_ALL));
  driver.writePacket(buildStp());
}

// Run 3: framing (ULEND/STP/wake/pacing) and height make no difference — any lit key
// puts lines on the top key of its column. Vary content + brightness on wire 6 only:
// lines that track which rows are lit mean a firmware memory leak; lines that ignore
// content (or scale with brightness) mean LCD crosstalk.
const S = 112;

/** Upright 112×112 24-bit BMP; `color(x, y)` returns [r, g, b]. */
function bmp(color: (x: number, y: number) => readonly [number, number, number]): Buffer {
  const row = S * 3;
  const buf = Buffer.alloc(54 + row * S);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(S, 18);
  buf.writeInt32LE(-S, 22); // top-down
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * S, 34);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const [r, g, b] = color(x, y);
      const o = 54 + y * row + x * 3;
      buf[o] = b;
      buf[o + 1] = g;
      buf[o + 2] = r;
    }
  }
  return buf;
}

const WHITE = [255, 255, 255] as const;
const jpeg = (src: Buffer): Buffer => transformImageForDevice(src, { ...spec, sharpen: 0 });

// Run 4 showed the lines are LCD crosstalk (line color = column average of the lit key,
// scales with brightness) on rows no image drives. Guess: the top-row slot is taller than
// 112 and the 180°-rotated image leaves its physical top rows undriven. Cover them.
const white = jpeg(bmp(() => WHITE));
const blueAt = (height: number): Buffer =>
  transformImageForDevice(
    bmp(() => [0, 0, 255]),
    { ...spec, height, sharpen: 0 },
  );
const HEIGHTS = [112, 114, 116, 118, 120, 124, 128];

const stages: { label: string; run: () => Promise<void> | void }[] = [
  { label: 'init only — panel should be black', run: () => undefined },
  ...HEIGHTS.map((h) => ({
    label: `bottom-left white; top-left (wire 11) blue 112×${h} — lines gone? blue reaching the top edge?`,
    run: () => {
      clearAll();
      driver.sendImage(6, white);
      driver.sendImage(11, blueAt(h));
    },
  })),
];

let stage = 0;
let busy = false;

async function runStage(): Promise<void> {
  const s = stages[stage]!;
  const before = driver.writes;
  await s.run();
  console.log(`${PREFIX} stage ${stage}: ${s.label}  [${driver.writes - before} writes]`);
  console.log(
    stage < stages.length - 1
      ? `${PREFIX}   look at the top row, then press any LCD key for the next stage`
      : `${PREFIX}   last stage — press any key (or Ctrl+C) to exit`,
  );
}

async function shutdown(): Promise<void> {
  await driver.close();
  closeSidecar();
  tjs.exit(0);
}

driver.on('key', (e: { state: string }) => {
  if (e.state !== 'down' || busy) return;
  busy = true;
  stage++;
  void (stage >= stages.length ? shutdown() : runStage()).finally(() => {
    busy = false;
  });
});

tjs.addSignalListener('SIGINT', () => void shutdown());

await runStage();
