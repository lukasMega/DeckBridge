/** `deckbridge diagnose` subcommand: writes a one-file diagnostics report, then
 *  the caller exits.
 *
 *  This is the answer to the "freeze on Windows, WebUI never starts" report — it
 *  runs before any server or device open, so it produces evidence on a machine
 *  where the in-app log panel is unreachable. Enumeration only, never hid_open
 *  (macOS SIGBUS — the same rule cli-devices.ts documents).
 */
import { setupNativeLibs, defaultCacheRoot } from './native-libs.js';
import { listAllHidDevicesTimed } from './ffi/hidapi.js';
import { enumerateDevices, toDeviceRow } from './cli-devices.js';
import { checkRequirements } from './web/server/requirements.js';
import { buildDiagnostics, diagnosticsFileName, REVIEW_NOTICE } from './web/server/diagnostics.js';
import { deckbridgeEnv } from './web/server/diagnostics-sources.js';
import { loadSettings, settingsPath } from './settings-store.js';
import { logFilePath, tailLogFile } from './log-file.js';
import { currentLogLevel } from './logger.js';
import { isElgatoAppRunning, platformName } from './os-utils.js';
import { versionText } from './cli.js';
import type { CliFlags } from './cli.js';

/** Build the report text. Exported for tests: no file I/O, no console output. */
export async function buildDiagnosticsReport(flags: CliFlags): Promise<string> {
  const cacheRoot = defaultCacheRoot();
  const settings = await loadSettings(cacheRoot);
  const hidEnum = listAllHidDevicesTimed();
  return buildDiagnostics(
    {
      header: {
        version: versionText(),
        platform: platformName() || '(unknown)',
        txikiVersion: tjs.version,
        cpus: `${tjs.system.cpus.length}x ${tjs.system.cpus[0]?.model ?? '?'}`,
        logLevel: currentLogLevel(),
        elgatoAppRunning: await isElgatoAppRunning(),
      },
      flags: { ...flags },
      env: deckbridgeEnv(),
      paths: {
        cacheRoot,
        settingsPath: settingsPath(cacheRoot),
        logPath: logFilePath(cacheRoot),
      },
      modelOverrides: settings.modelOverrides ?? {},
      hidDevices: hidEnum.devices,
      hidEnumerateMs: hidEnum.tookMs,
      deviceRows: enumerateDevices().map(toDeviceRow),
      requirements: await checkRequirements(),
      logTail: await tailLogFile(Number.MAX_SAFE_INTEGER, cacheRoot),
      settingsJson: JSON.stringify(settings, null, 2),
    },
    { redactCommands: flags.redactCommands },
  );
}

/** Where the report lands when --out was not given. */
export function defaultDiagnosticsPath(cacheRoot: string, now = new Date()): string {
  return `${cacheRoot}/diagnostics/${diagnosticsFileName(now)}`;
}

export async function runDiagnoseCommand(flags: CliFlags): Promise<void> {
  // Native libs first: without DECKBRIDGE_NATIVE_LIB the HID enumeration sections
  // come back empty, which is exactly the data the freeze report needs.
  await setupNativeLibs();
  const report = await buildDiagnosticsReport(flags);
  console.log(report);

  const cacheRoot = defaultCacheRoot();
  const target = flags.out ?? defaultDiagnosticsPath(cacheRoot);
  const dir = target.slice(0, Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')));
  try {
    if (dir) await tjs.makeDir(dir, { recursive: true });
    await tjs.writeFile(target, report);
    console.log(`\nWritten to: ${target}`);
  } catch (e) {
    console.error(`\nCould not write ${target}: ${(e as Error).message}`);
  }
  if (!flags.redactCommands) console.log(REVIEW_NOTICE);
}
