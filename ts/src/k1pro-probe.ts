import { MiraboxDriver } from './mirabox.js';
import { closeSidecar } from './translator.js';
import type { KeyEvent } from './types.js';
import { MIRABOX_K1PRO_MODEL } from './devices/mirabox/mirabox-k1pro.js';

// K1 Pro probe round 3+: file-driven A/B harness.
//
// Sends up to 6 JPEG files (sorted by name) from a directory to the 6 keys,
// so arbitrary encoder variants (jpegtran -optimize, 4:2:0 re-encodes, padded
// variants, ...) can be compared on hardware with everything else identical.
//
// Usage: put 6 files named 0-*.jpg .. 5-*.jpg into /tmp/k1pro-probe3 (or pass
// another dir as argv[1]), then `mise run k1pro-probe`.
//
// History:
//   round 1 (size ladder, same pixels): single-chunk + seam-in-COM clean;
//     seam-in-DQT -> greyscale, seam-in-SOS -> artifact (header/seam rule).
//   round 2 (same 1591B bitstream shifted +4..+64): artifact at EVERY
//     alignment; 1793B re-encode of the same image clean -> scan failures are
//     bitstream-content-dependent, not alignment/size-dependent.

// args: [tjs, 'run', script, dir?]
// eslint-disable-next-line sonarjs/publicly-writable-directories -- diagnostic probe, dev machine only
const dir = tjs.args[3] ?? '/tmp/k1pro-probe3';

const names: string[] = [];
for await (const ent of await tjs.readDir(dir)) {
  if (ent.name.endsWith('.jpg')) names.push(ent.name);
}
names.sort((a, b) => a.localeCompare(b));
if (names.length === 0) throw new Error(`no .jpg files in ${dir}`);
if (names.length > 6) names.length = 6;

const model = MIRABOX_K1PRO_MODEL;
const driver = new MiraboxDriver(model);
await driver.open();
console.log(`[probe] K1 Pro connected — sending ${names.length} files from ${dir}`);

const POS = ['top-left', 'top-mid', 'top-right', 'bot-left', 'bot-mid', 'bot-right'];
const wireIds = model.keyMap.coraToWireImage!;

for (let cora = 0; cora < names.length; cora++) {
  const name = names[cora]!;
  const jpeg = await tjs.readFile(`${dir}/${name}`);
  // Optional inter-chunk pacing for timing experiments: a `delay<N>` token in
  // the filename (e.g. `2-key4q60-delay20.jpg`) sets N ms between chunks.
  const delayMs = Number(/delay(\d+)/.exec(name)?.[1] ?? 0);
  driver.sendImage(wireIds[cora]!, jpeg, delayMs);
  const tag = delayMs > 0 ? ` delay=${delayMs}ms` : '';
  console.log(`[probe] ${POS[cora]!.padEnd(9)} (cora=${cora}): ${jpeg.length}B${tag} — ${name}`);
  await new Promise((r) => setTimeout(r, 100));
}

console.log('[probe] sent — note per position: CLEAN or ARTIFACT (and how it looks).');
console.log('[probe] Ctrl+C to exit.');

driver.on('key', (e: KeyEvent) => {
  console.log(`[key] code=0x${e.keyIndex.toString(16).padStart(2, '0')} state=${e.state}`);
});

tjs.addSignalListener('SIGINT', () => {
  void driver.close().then(() => {
    closeSidecar();
    tjs.exit(0);
    return undefined;
  });
});
