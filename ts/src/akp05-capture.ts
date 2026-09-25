import { Akp05Driver } from './devices/ajazz/akp05-driver.js';
import { findAkp05Device, initProbeLibs } from './probe-utils.js';

// Ajazz AKP05/AKP05E input trace. Records the one thing no reference project has:
// the touch-strip report codes (zeccola/ajazz-akp05 and ambiso/opendeck-akp05 both
// document keys and encoders, but call swipe codes uncaptured/unreliable).
// Usage: mise run akp05-capture. Ctrl+C to stop. Reads only — the driver's own init
// and keepalive run, nothing else is written.

const PREFIX = '[akp05]';

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

/** Trailing zero padding carries no information and hides the interesting head. */
function trimZeroTail(data: Uint8Array): Uint8Array {
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return data.subarray(0, end);
}

class CaptureDriver extends Akp05Driver {
  protected override parseInput(data: Buffer): void {
    const trimmed = trimZeroTail(data);
    const ack = data[0] === 0x41 && data[1] === 0x43 && data[2] === 0x4b;
    const decoded = ack
      ? `ACK code=0x${(data[9] ?? 0).toString(16).padStart(2, '0')} state=${data[10] ?? 0}`
      : 'non-ACK report';
    console.log(`${PREFIX} ${decoded}  [${trimmed.length} B] ${hex(trimmed)}`);
    super.parseInput(data);
  }
}

await initProbeLibs();

const { model, hidPath } = findAkp05Device(PREFIX);

const driver = new CaptureDriver(model);
try {
  await driver.open(hidPath);
} catch (e) {
  console.log(`${PREFIX} open failed: ${(e as Error).message}`);
  console.log(`${PREFIX} on macOS grant Input Monitoring to this terminal, then reopen it.`);
  tjs.exit(1);
}

console.log(`${PREFIX} opened. Now, one input at a time, with a pause between:`);
console.log(`${PREFIX}   1. press each LCD key (known: codes 0x01-0x0a)`);
console.log(`${PREFIX}   2. press, then turn, each encoder left to right`);
console.log(`${PREFIX}   3. tap the touch strip at its left edge, middle, right edge`);
console.log(`${PREFIX}   4. swipe the strip left, then right`);
console.log(`${PREFIX} Ctrl+C when done.`);

tjs.addSignalListener('SIGINT', () => {
  void driver.close().then(() => tjs.exit(0));
});
