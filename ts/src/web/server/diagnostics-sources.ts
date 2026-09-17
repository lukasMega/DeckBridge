// Collects the live sources for the server-side diagnostics report and writes it
// to disk. Split out of web-ui-server.ts to keep that file under the 500-line
// check-loc gate; the builder itself (pure) lives in diagnostics.ts and is shared
// with `deckbridge diagnose`.
import { buildDiagnostics, diagnosticsFileName } from './diagnostics.js';
import type { DiagnosticsOptions, DiagnosticsSources } from './diagnostics.js';
import { checkRequirements } from './requirements.js';
import type { KeyEventEntry, LogEntry, StateResponse } from './types.js';
import type { CommEntry } from '../../types.js';
import type { DeviceModelOverride } from '../../devices/driver.js';
import type { ModelOverridesController } from './model-overrides-controller.js';
import { enumerateDevices, toDeviceRow } from '../../cli-devices.js';
import { listAllHidDevicesTimed } from '../../ffi/hidapi.js';
import { tailLogFile } from '../../log-file.js';
import { defaultCacheRoot } from '../../native-libs.js';
import { settingsPath } from '../../settings-store.js';
import { isElgatoAppRunning, openPathInOS, platformName } from '../../os-utils.ts';
import { versionText } from '../../cli.js';

/** The fields both the resolved inputs and the raw args carry verbatim. */
interface DiagnosticsInputsBase {
  cacheRoot?: string;
  logPath: string;
  logLevel: string;
  uptimeMs: number;
  state: StateResponse;
  settingsJson: string;
}

/** Everything the report needs that only the running server knows. */
export interface LiveDiagnosticsInputs extends DiagnosticsInputsBase {
  modelOverrides: Record<string, DeviceModelOverride>;
  effectiveModels: Record<string, unknown>;
  comms: CommEntry[];
  keyEvents: KeyEventEntry[];
  ringLogs: LogEntry[];
}

/** The live-source assembly, expressed against the two controllers/buffers the
 *  report reads from — so WebUIServer hands over references, not fifteen
 *  closures. */
export function liveDiagnosticsInputs(
  args: DiagnosticsInputsBase & {
    overrides: ModelOverridesController;
    activity: { comms: CommEntry[]; keyEvents: KeyEventEntry[]; logs: LogEntry[] };
  },
): LiveDiagnosticsInputs {
  const { overrides, activity, ...rest } = args;
  const modelOverrides = overrides.all();
  // Post-override spec of every model the user has tuned — so a report from a
  // tuned device shows what it is actually running, not the registry default.
  const effectiveModels: Record<string, unknown> = {};
  for (const modelId of Object.keys(modelOverrides)) {
    const view = overrides.view(modelId);
    if (!('error' in view)) effectiveModels[modelId] = view.effective;
  }
  return {
    ...rest,
    modelOverrides,
    effectiveModels,
    comms: activity.comms,
    keyEvents: activity.keyEvents,
    ringLogs: activity.logs,
  };
}

/** `tjs.env` entries DeckBridge itself reads. None are secrets, and a wrong path
 *  in one of them is a common root cause, so values are shown verbatim. */
export function deckbridgeEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tjs.env).filter(([k]) => k.startsWith('DECKBRIDGE_') || k === 'HIDAPI_LIB'),
  );
}

function sourcesFor(
  live: LiveDiagnosticsInputs,
  logTail: string,
  elgatoAppRunning: boolean,
): DiagnosticsSources {
  const hidEnum = listAllHidDevicesTimed();
  return {
    header: {
      version: versionText(),
      platform: platformName() || '(unknown)',
      txikiVersion: tjs.version,
      cpus: `${tjs.system.cpus.length}x ${tjs.system.cpus[0]?.model ?? '?'}`,
      uptimeMs: live.uptimeMs,
      logLevel: live.logLevel,
      elgatoAppRunning,
    },
    env: deckbridgeEnv(),
    paths: {
      cacheRoot: live.cacheRoot ?? defaultCacheRoot(),
      settingsPath: settingsPath(live.cacheRoot),
      logPath: live.logPath,
    },
    modelOverrides: live.modelOverrides,
    effectiveModels: live.effectiveModels,
    hidDevices: hidEnum.devices,
    hidEnumerateMs: hidEnum.tookMs,
    deviceRows: enumerateDevices().map(toDeviceRow),
    state: live.state,
    updates: {
      enabled: live.state.updateInfo.enabled,
      lastCheckedAt: live.state.updateInfo.lastCheckedAt,
      latest: live.state.updateInfo.latest,
      updateAvailable: live.state.updateInfo.updateAvailable,
      error: live.state.updateInfo.error,
    },
    comms: live.comms,
    keyEvents: live.keyEvents,
    logTail,
    ringLogs: live.ringLogs,
    settingsJson: live.settingsJson,
  };
}

/** The same report `deckbridge diagnose` produces, plus the live dock state and
 *  the comm / key-event ring buffers a running server has. */
export async function buildLiveDiagnostics(
  live: LiveDiagnosticsInputs,
  opt: DiagnosticsOptions = {},
): Promise<string> {
  // Read the whole file and let the builder apply the line cap — the tail is the
  // one section whose length is worth bounding at render time, not at read time.
  const logTail = await tailLogFile(Number.MAX_SAFE_INTEGER, live.cacheRoot);
  // Probed here, not read off the status snapshot: that flag is a conflict signal,
  // forced false whenever DeckBridge holds the device (app.ts's poll) and stale
  // whenever no WebUI client is connected. A report must say what is actually running.
  const sources = sourcesFor(live, logTail, await isElgatoAppRunning());
  sources.requirements = await checkRequirements();
  return buildDiagnostics(sources, opt);
}

/** Write the report under <cacheRoot>/diagnostics/ and reveal the folder.
 *  Returns the path, or null when the write failed. */
export async function saveLiveDiagnostics(
  live: LiveDiagnosticsInputs,
  opt: DiagnosticsOptions = {},
): Promise<string | null> {
  const dir = `${live.cacheRoot ?? defaultCacheRoot()}/diagnostics`;
  const target = `${dir}/${diagnosticsFileName()}`;
  try {
    const report = await buildLiveDiagnostics(live, opt);
    await tjs.makeDir(dir, { recursive: true });
    await tjs.writeFile(target, report);
  } catch {
    return null;
  }
  void openPathInOS(dir);
  return target;
}
