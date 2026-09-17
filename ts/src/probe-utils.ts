/** Shared plumbing for the manual hardware probes (dev-entry tier). */
import { closeSidecar } from './translator.js';
import type { MiraboxDriver } from './mirabox.js';
import type { KeyEvent } from './types.js';

/** Ctrl+C: close the device (and the image sidecar) before exiting — a probe that
 *  exits with the handle open leaves the HID interface claimed until replug. */
export function exitOnSigint(driver: MiraboxDriver): void {
  tjs.addSignalListener('SIGINT', () => {
    void driver.close().then(() => {
      closeSidecar();
      tjs.exit(0);
      return undefined;
    });
  });
}

/** One line per key event; `prefix` matches the probe's other output. */
export function logKeyEvents(driver: MiraboxDriver, prefix = '[key] '): void {
  driver.on('key', (e: KeyEvent) => {
    console.log(`${prefix}code=0x${e.keyIndex.toString(16).padStart(2, '0')} state=${e.state}`);
  });
}
