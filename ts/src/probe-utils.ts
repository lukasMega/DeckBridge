/** Shared plumbing for the manual hardware probes (dev-entry tier). */
import { closeSidecar } from './translator.js';
import { IS_MACOS, listHidPaths } from './ffi/hidapi.js';
import { setupNativeLibs } from './native-libs.js';
import { MiraboxDriver } from './mirabox.js';
import { AJAZZ_AKP05E_MODEL } from './devices/ajazz/akp05e.js';
import { AJAZZ_AKP05_MODEL } from './devices/ajazz/akp05.js';
import type { DeviceModel } from './devices/driver.js';
import type { KeyEvent } from './types.js';

/** Probes are run by hand, so a raw ENOENT/FFI stack is worse than one line naming
 *  the fix. Prints under the probe's own prefix and stops. */
function fail(prefix: string, ...lines: string[]): never {
  for (const line of lines) console.log(`${prefix} ${line}`);
  return tjs.exit(1);
}

/** Extract the bundle's embedded hidapi and point HIDAPI_LIB at it. Probe bundles
 *  embed the native libs (build.mjs only skips that for test/smoke builds) but no
 *  probe ran the extract step, so hidapi resolution silently fell through to
 *  whatever the system happened to have — or to nothing at all. */
export async function initProbeLibs(): Promise<void> {
  await setupNativeLibs();
}

const OPEN_REFUSED_HINTS = IS_MACOS
  ? [
      'Two things refuse an open on macOS:',
      '  1. Input Monitoring. macOS attributes the grant to the app responsible for',
      '     this process — your terminal or IDE, never the tjs binary. System Settings',
      '     → Privacy & Security → Input Monitoring, then fully quit and reopen it.',
      '  2. Another DeckBridge instance already holds the device (hidapi opens',
      '     exclusively on macOS). Stop `mise run d` / the tray app and retry.',
    ]
  : [
      'Check the udev rule (docs/features.md#permissions), and that no other',
      'DeckBridge instance already holds the device.',
    ];

/** Enumerate first, then open, so "nothing connected" and "open refused" are two
 *  different messages. Returns an open driver, or exits. */
export async function openProbeDevice(model: DeviceModel, prefix: string): Promise<MiraboxDriver> {
  const usagePage = model.usagePage!;
  const usage = model.usage!;
  const paths = model.usbProductIds.flatMap((pid) =>
    listHidPaths(model.usbVendorId, usagePage, usage, pid),
  );
  if (paths.length === 0) {
    fail(
      prefix,
      `no ${model.name} found (VID 0x${model.usbVendorId.toString(16)}, ` +
        `usage 0x${usagePage.toString(16)}/${usage}).`,
      'Check the cable, then run the `devices` subcommand to see what enumeration reports.',
    );
  }
  if (paths.length > 1) {
    console.log(`${prefix} ${paths.length} units match — using ${paths[0]!}`);
  }

  const driver = new MiraboxDriver(model);
  try {
    await driver.open(paths[0]);
  } catch (e) {
    fail(prefix, `open failed: ${(e as Error).message}`, ...OPEN_REFUSED_HINTS);
  }
  return driver;
}

/** First AKP05E/AKP05 on the bus, or exits with the usual causes. The caller opens
 *  it: each AKP05 probe subclasses `Akp05Driver` differently. */
export function findAkp05Device(prefix: string): { model: DeviceModel; hidPath: string } {
  for (const model of [AJAZZ_AKP05E_MODEL, AJAZZ_AKP05_MODEL]) {
    for (const pid of model.usbProductIds) {
      const paths = listHidPaths(model.usbVendorId, model.usagePage!, model.usage!, pid);
      if (paths.length === 0) continue;
      console.log(`${prefix} model: ${model.id} PID=0x${pid.toString(16).padStart(4, '0')}`);
      if (paths.length > 1)
        console.log(`${prefix} ${paths.length} units match — using ${paths[0]!}`);
      return { model, hidPath: paths[0]! };
    }
  }
  return fail(
    prefix,
    'no AKP05/AKP05E found on VID 0x0300 usage 0xffa0/1.',
    'check the cable, and stop any running DeckBridge instance —',
    'hidapi opens exclusively on macOS.',
  );
}

/** Up to `max` .jpg/.jpeg names from `dir`, sorted, or null when the directory is
 *  missing or holds none — absent is normal for the default directory, so the caller
 *  decides whether that is a failure or a cue to fall back to its built-in images. */
export async function tryProbeJpegDir(
  dir: string,
  prefix: string,
  max: number,
): Promise<string[] | null> {
  let entries: AsyncIterableIterator<{ name: string }>;
  try {
    entries = await tjs.readDir(dir);
  } catch {
    return null;
  }

  const names: string[] = [];
  for await (const ent of entries) {
    if (/\.jpe?g$/i.test(ent.name)) names.push(ent.name);
  }
  if (names.length === 0) return null;

  names.sort((a, b) => a.localeCompare(b));
  if (names.length > max) {
    console.log(`${prefix} ${names.length} files found — sending the first ${max}`);
    names.length = max;
  }
  return names;
}

/** Same, for a directory the user named explicitly — a typo there must fail loudly
 *  instead of quietly painting the built-in images. */
export async function readProbeJpegDir(
  dir: string,
  prefix: string,
  max: number,
): Promise<string[]> {
  const names = await tryProbeJpegDir(dir, prefix, max);
  if (names === null) {
    fail(
      prefix,
      `no .jpg files in ${dir} (or the directory does not exist).`,
      `Drop up to ${max} JPEGs named 0-*.jpg .. ${(max - 1).toString()}-*.jpg into it.`,
    );
  }
  return names;
}

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
