import { buildTrayState, resolveTrayBin, startTray } from '../infra/tray.js';
import type { TrayHandle } from '../infra/tray.js';
import { ElgatoServer } from '../cora/primary-server.js';
import { ElgatoChildServer } from '../cora/child-server.js';
import { CoraDock } from './cora-dock.js';
import { WebUIServer } from '../web/server/index.js';
import type { MockDeviceConfig } from '../web/server/index.js';
import type { ClientApp, CommEntry, LogObject } from '../shared/types.js';
import type { MockInput, TouchStripMode } from '../shared/types.js';
import { ELGATO_CHILD_PORT, ELGATO_TCP_PORT, WEBUI_PORT } from '../shared/types.js';
import { advertisedGeometry, DEFAULT_MODEL, DEVICE_MODELS } from '../devices/registry.js';
import type { OverrideChangeKind } from '../devices/model-overrides.js';
import { log, setWebUILog, setLogLevel, step } from '../shared/logger.js';
import { startLogFile, stopLogFile, activeLogFilePath } from '../infra/log-file.js';
import { setupNativeLibs } from '../infra/native-libs.js';
import { DriverManager } from './driver-manager.js';
import { ElgatoAutoRestart, createElgatoAutoRestartDeps } from './elgato-auto-restart.js';
import { getInitialDriverMode } from './driver-manager-deps.js';
import { macToBytes } from './dock-status.js';
import type { CoraDockFactory } from './dock-scanner-deps.js';
import { isElgatoAppRunning, openPathInOS, platformName } from '../infra/os-utils.ts';
import { parseCli, userArgs, applyFlagsToEnv, versionText, USAGE_TEXT } from '../shared/cli.js';
import { runDevicesCommand } from '../cli/devices.js';
import { runDiagnoseCommand } from '../cli/diagnose.js';
import { PersistedSettings } from '../infra/settings.js';
import { createDailyPing, sendBeacon } from '../infra/daily-ping.js';
import { STARTUP_DELAY_MS, CHECK_INTERVAL_MS } from '../infra/update-check.js';
import { stopCommands } from '../infra/command-runner.js';
import { stopSpawns } from '../infra/owned-spawn.js';
import { shutdownPluginHost } from '../plugin/plugin-host.js';
import { createShutdown } from './shutdown.js';
import {
  MIN_DWELL_MS,
  PING_SCHEDULE_SLACK_MS,
  PING_RETRY_INTERVAL_MS,
} from '../infra/daily-ping-env.js';

const openBrowser = openPathInOS;

// CLI parsing first: version/help/devices exit immediately; flags must land in tjs.env before anything below reads it.
const cli = parseCli(userArgs());
if (cli.command === 'version') {
  console.log(versionText());
  tjs.exit(0);
}
if (cli.command === 'help') {
  console.log(USAGE_TEXT);
  tjs.exit(0);
}
if (cli.command === 'devices') {
  await runDevicesCommand();
  tjs.exit(0);
}
applyFlagsToEnv(cli.flags);
// diagnose runs after applyFlagsToEnv (reports effective flags/env, honours --cache-dir) but before any server/device open; enumeration only, never hid_open.
if (cli.command === 'diagnose') {
  await runDiagnoseCommand(cli.flags);
  tjs.exit(0);
}
// Disk sink first — before setupNativeLibs, before any HID call. defaultCacheRoot()
// is pure (env + tjs.homeDir), so this needs no native lib, and a freeze anywhere
// below still leaves the breadcrumb that names the step it hung on.
startLogFile();
// Loaded once, before any reader: dropped-entry warnings land in the log file.
const settings = new PersistedSettings();
await settings.load();
// Log level precedence: --log-level / $DECKBRIDGE_LOG_LEVEL (already in env) win,
// else settings.json's "logLevel". Winner goes back into env so USB workers inherit it.
if (tjs.env.DECKBRIDGE_LOG_LEVEL) {
  setLogLevel(tjs.env.DECKBRIDGE_LOG_LEVEL);
} else if (settings.logLevel) {
  setLogLevel(settings.logLevel);
  tjs.env.DECKBRIDGE_LOG_LEVEL = settings.logLevel;
}
const headless = cli.flags.headless;
const noWebui = cli.flags.noWebui;

// Extract embedded native libs and set DECKBRIDGE_NATIVE_LIB / HIDAPI_LIB
// before any server, the HID worker, or the FFI loaders run.
// No-op when env vars are already set (dev) or in --no-embed builds.
await step('deckBr', 'native-libs extract', () => setupNativeLibs());

// tjs.env.DECKBRIDGE_WEBUI_PORT already reflects --webui-port (applyFlagsToEnv, above)
// or a pre-existing env var — falls back to the WEBUI_PORT default.
const webuiPort = tjs.env.DECKBRIDGE_WEBUI_PORT
  ? Number(tjs.env.DECKBRIDGE_WEBUI_PORT)
  : WEBUI_PORT;
const webui = new WebUIServer(
  webuiPort,
  DEVICE_MODELS.map((m) => ({ id: m.id, name: m.name, keyCount: m.keyCount })),
  getInitialDriverMode(),
  settings,
);
const defaultChildGeometry = advertisedGeometry(DEFAULT_MODEL);
const server = new ElgatoServer(defaultChildGeometry);
const childServer = new ElgatoChildServer(
  defaultChildGeometry,
  ELGATO_CHILD_PORT,
  server.deviceConfig,
  false,
);
// Composition unit above the server pair: pairing watchdog, applyModel(),
// startWithRetry() (see cora-dock.ts). DriverManager wraps it as dock 0.
const primaryDock = new CoraDock(server, childServer, 'dock 0');

// Widened: TS would otherwise narrow it to `false` across the startup awaits.
let shuttingDown = false as boolean;
let tray: TrayHandle | null = null;
/** Every startup/recurring timer, so shutdown can clear them all. */
const timers: Array<ReturnType<typeof setTimeout>> = [];
/** Update checks / daily pings in flight: they may still write settings. */
const settingsWriters = new Set<Promise<unknown>>();
function trackWriter(p: Promise<unknown>): void {
  settingsWriters.add(p);
  void p.finally(() => settingsWriters.delete(p));
}

setWebUILog((level, component, message) => webui.log(level, component, message));

// txiki hard-aborts on unhandled rejection unless preventDefault(); this lets shutdown() run the teardown instead.
globalThis.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  ev.preventDefault();
  const reason =
    ev.reason instanceof Error ? (ev.reason.stack ?? ev.reason.message) : String(ev.reason);
  log('error', 'deckBr', `unhandled rejection — shutting down: ${reason}`);
  shutdown().catch(() => tjs.exit(1));
});

// Deduped: 'changed' fires on every dock status change; the tray cares about few fields.
let lastTrayState = '';
function pushTrayState(): void {
  if (!tray) return;
  const driver = driverManager.getCurrentDriver();
  const state = buildTrayState({
    deviceName: driver?.model.name,
    driverConnected: driver !== null && driverManager.getDriverMode() === 'real',
    elgatoConnected: primaryDock.childHasClient,
    reconnectAttempts: driverManager.getReconnectAttemptCount(),
    update: webui.updates.info(),
  });
  const json = JSON.stringify(state);
  if (json === lastTrayState) return;
  lastTrayState = json;
  tray.push(state);
}

webui.updates.setOnChange(pushTrayState);

// Scanned-dock CORA server pair builder (multi-device). Mirrors the primary wiring
// above: the childServer shares the SAME server.deviceConfig reference, and each
// serverLog is piped to the shared logger. No WebUI/comm mirror — WebUI stays primary-only.
const coraDockFactory: CoraDockFactory = (identity) => {
  const s = new ElgatoServer(defaultChildGeometry, identity.primaryPort, false, {
    childPort: identity.childPort,
    mdnsServiceName: identity.mdnsServiceName,
    dockSerial: identity.dockSerial,
    childSerial: identity.childSerial,
  });
  const cs = new ElgatoChildServer(defaultChildGeometry, identity.childPort, s.deviceConfig, false);
  s.on('serverLog', ({ level, component: c, message: m }: LogObject) => log(level, c, m));
  cs.on('serverLog', ({ level, component: c, message: m }: LogObject) => log(level, c, m));
  return new CoraDock(s, cs, `dock ${identity.index}`);
};

const driverManager = new DriverManager({
  webui,
  settings,
  cora: primaryDock,
  getShuttingDown: () => shuttingDown,
  coraDockFactory,
  onDockConnected: (dockIndex, deviceKey) =>
    elgatoAutoRestart.onDockConnected(dockIndex, deviceKey),
  onElgatoAttached: (dockIndex) => elgatoAutoRestart.onElgatoAttached(dockIndex),
});

webui.setHidInventory(() => driverManager.hidInventory());

// One fan-out for every dock/probe state change: the WebUI dock list (deduped
// there) and the tray.
driverManager.on('changed', () => {
  webui.notifyDocks(driverManager.getDockStatuses());
  pushTrayState();
});

// Grace-period scheduler (main/elgato-auto-restart.ts, §4.3) — at most once per
// process, restarts the Elgato app for a previously-paired dock it hasn't
// reattached to on its own. Deps built from the singletons above.
const elgatoAutoRestart = new ElgatoAutoRestart(
  createElgatoAutoRestartDeps({ webui, settings, driverManager }),
);

const shutdown = createShutdown({
  quiesce: () => {
    shuttingDown = true;
    webui.beginShutdown();
    for (const [sig, handler] of signalHandlers) {
      try {
        tjs.removeSignalListener(sig, handler);
      } catch {}
    }
    log('info', 'deckBr', 'shutting down...');
    for (const t of timers) clearTimeout(t);
    elgatoAutoRestart.dispose();
    webui.elgatoApp.control.cancelLaunches();
    driverManager.stopScan();
  },
  owners: [
    ['commands', () => Promise.all([stopCommands(), stopSpawns()])],
    ['plugins', shutdownPluginHost],
    ['docks', () => driverManager.shutdown()],
    ['webui', () => webui.stop()],
    ['tray', async () => tray?.close()],
    ['settings writers', () => Promise.allSettled(settingsWriters)],
  ],
  persist: () => settings.close(),
  // Last: the shutdown path itself reaches the disk (tray "Quit" routes through here too).
  drainLogs: stopLogFile,
  exit: (code) => tjs.exit(code),
});

function onSignal(sig?: string): void {
  log('warn', 'deckBr', `received ${sig ?? 'signal'} — shutting down`);
  shutdown().catch(() => tjs.exit(1));
}

// [signal, handler] pairs: shutdown() unregisters the exact registered references.
const signalHandlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(
  (sig) => [sig, () => onSignal(sig)] as const,
);
for (const [sig, handler] of signalHandlers) tjs.addSignalListener(sig, handler);

// Wiring both halves of the primary CORA pair share (scanned docks get serverLog only —
// see coraDockFactory).
for (const s of [server, childServer]) {
  s.on('serverLog', ({ level, component: c, message: m }: LogObject) => log(level, c, m));
  s.on('comm', (entry: Omit<CommEntry, 'ts'>) => webui.notifyComm(entry));
  s.on('clientAppDetected', (app: ClientApp) => webui.notifyClientApp(app));
}

server.on('clientConnected', (addr: string) => log('info', 'elgato', `primary connected: ${addr}`));
server.on('clientDisconnected', () => log('info', 'elgato', 'primary disconnected'));

// The WebUI's Elgato-link indicator. Pairing bookkeeping, auto-restart and the
// brightness re-push live in the Dock; its 'changed' refreshes the dock list + tray.
childServer.on('clientConnected', (addr: string) => {
  log('info', 'elgato', `child connected: ${addr}`);
  webui.notifyElgatoStatus(true, addr);
});

childServer.on('clientDisconnected', () => {
  log('info', 'elgato', 'child disconnected');
  webui.notifyElgatoStatus(false);
});

webui.on('setBrightness', (level: number, dock?: number) => {
  driverManager.dock(dock ?? 0)?.setBrightness(level);
});

// The WebUI already applied the level to the main thread; forward it to the USB
// workers, where the interesting device traffic is.
webui.on('setLogLevel', (level: string) => {
  driverManager.setLogLevel(level);
  log('info', 'deckBr', `log level set to ${level}`);
});

// Multi-deck opt-in toggled (WebUI or settings import): raise/lower the dock cap.
// Switching it off tears down a live second dock.
webui.on('setMultiDeck', (enabled: boolean) => {
  driverManager.setMultiDeck(enabled).catch((err: unknown) => {
    log('error', 'deckBr', `setMultiDeck(${enabled}) failed: ${(err as Error).message}`);
  });
});

// Device tuning changed: an image-only change is swapped into the live
// dock(s) and repainted; keyMap/wire/splash reopen so the new spec is in
// force from the next open() and the first splash.
webui.on('modelOverridesChanged', (modelId: string, kind: OverrideChangeKind = 'reopen') => {
  driverManager.reloadDeviceTuning(modelId, kind).catch((err: unknown) => {
    log('error', 'deckBr', `reloadDeviceTuning(${modelId}) failed: ${(err as Error).message}`);
  });
});

if (__MOCK_BUILD__) {
  const { MockDriver } = await import('../devices/mock.js');
  webui.on('switchMode', (mode: 'real' | 'mock') => {
    driverManager.switchMode(mode).catch((err: unknown) => {
      log('error', 'deckBr', `switchMode(${mode}) failed: ${(err as Error).message}`);
      webui.notifyDriverStatus(mode, false);
    });
  });

  webui.on('keyPress', (mk2Index: number) => {
    const d = driverManager.getCurrentDriver();
    if (driverManager.getDriverMode() === 'mock' && d instanceof MockDriver) {
      d.simulateKeyPress(mk2Index);
    }
  });

  webui.on('mockInput', (input: MockInput) => {
    const d = driverManager.getCurrentDriver();
    if (driverManager.getDriverMode() === 'mock' && d instanceof MockDriver) d.simulate(input);
  });

  webui.on('setModel', (modelId: string) => {
    const model = DEVICE_MODELS.find((m) => m.id === modelId);
    if (!model) return;
    if (driverManager.getDriverMode() === 'mock') {
      driverManager.connectMock(model).catch((err: unknown) => {
        log('error', 'deckBr', `connectMock(${model.id}) failed: ${(err as Error).message}`);
        webui.notifyDriverStatus('mock', false);
      });
    } else {
      driverManager.applyDeviceModel(model);
    }
  });
}

// An extra-key assignment changed (WebUI) — repaint that dock's key icons.
// Dispatch needs no re-wire: it resolves the config per press.
webui.on('extraKeyChanged', (dock: number) => {
  driverManager.dock(dock)?.repaintWidgets();
});

webui.on('extraKeyRunNow', (dock: number, wireId: number) => {
  driverManager.dock(dock)?.forceRunWidget(wireId);
});

webui.on('touchStripModeChanged', (dock: number, mode: TouchStripMode) => {
  driverManager.dock(dock)?.setTouchStripMode(mode);
});

webui.on('mdnsNameChanged', (deviceKey: string, name: string) => {
  driverManager.dockForDevice(deviceKey)?.renameMdns(name);
});

if (__MOCK_BUILD__)
  webui.on('mockConfig', (cfg: MockDeviceConfig) => {
    server.setDeviceConfig({ ...cfg, macAddress: macToBytes(cfg.macAddress, []) });
    log(
      'info',
      'deckBr',
      `mock config updated: dockFw=${cfg.dockFirmwareVersion} childFw=${cfg.childFirmwareVersion}` +
        ` dockSerial=${cfg.serialNumber} childSerial=${cfg.childSerialNumber}` +
        ` pid=0x${cfg.productId.toString(16).padStart(4, '0')} mac=${cfg.macAddress}`,
    );
  });

// Startup banner. Label padding is hand-set per line and reproduced verbatim in
// issue reports — keep the widths as they are.
const BANNER_RULE = '══════════════════════════════════════════════';
for (const [level, line] of [
  ['info', BANNER_RULE],
  ['info', `bundle built : ${__BUILD_TIME__}`],
  ['info', `started      : ${new Date().toISOString()}`],
  ['info', `cpus         : ${tjs.system.cpus.length}x ${tjs.system.cpus[0]?.model ?? '?'}`],
  ['info', `txiki.js     : ${tjs.version}`],
  ['info', `log file     : ${activeLogFilePath() ?? '(disabled)'}`],
  ['debug', `platform     : ${platformName() || '(unknown)'}`],
  ['info', `env DECKBRIDGE_NATIVE_LIB = ${tjs.env.DECKBRIDGE_NATIVE_LIB ?? '(not set)'}`],
  ['info', `env HIDAPI_LIB     = ${tjs.env.HIDAPI_LIB ?? '(not set)'}`],
  ...(__MOCK_BUILD__
    ? [['info', `env DECKBRIDGE_MOCK      = ${tjs.env.DECKBRIDGE_MOCK ?? '(not set)'}`] as const]
    : []),
  ['info', `env DECKBRIDGE_OPEN   = ${tjs.env.DECKBRIDGE_OPEN ?? '(not set)'}`],
  ['info', `env DECKBRIDGE_DUMP_DIR  = ${tjs.env.DECKBRIDGE_DUMP_DIR ?? '(not set)'}`],
  ['info', `env DECKBRIDGE_RAW_DUMP_DIR = ${tjs.env.DECKBRIDGE_RAW_DUMP_DIR ?? '(not set)'}`],
  ['info', BANNER_RULE],
] as const) {
  log(level, 'deckBr', line);
}

// Poll for a conflict with the Elgato desktop app: running AND the device slot free
// plausibly explains why we can't open the hardware. Skipped when no WebUI client is
// connected (nobody reads the flag) or under --headless.
let _elgatoAppConflict = false;
if (!headless) {
  timers.push(
    setInterval(async () => {
      if (!webui.hasClients()) return;
      const connected = webui.snapshot().driverConnected;
      const next = connected ? false : await isElgatoAppRunning();
      if (next !== _elgatoAppConflict) {
        _elgatoAppConflict = next;
        webui.notifyElgatoAppConflict(next);
      }
    }, 2000),
  );
}

// GitHub-release update check (update-check.ts): a delayed start keeps it off the
// blocking startup path; mock mode never touches the network. Failures log at
// debug — an offline user is the normal case, see update-controller.ts.
if (!__MOCK_BUILD__ || tjs.env.DECKBRIDGE_MOCK !== '1') {
  const runUpdateCheck = (): void => {
    if (shuttingDown) return;
    trackWriter(
      webui.updates.check(false).catch((e: unknown) => log('debug', 'update', String(e))),
    );
  };
  timers.push(setTimeout(runUpdateCheck, STARTUP_DELAY_MS));
  timers.push(setInterval(runUpdateCheck, CHECK_INTERVAL_MS));

  // Own delay, not the update check's 30 s: MIN_DWELL_MS keeps CI/sandbox runs
  // from beaconing (daily-ping-env.ts) and lets a boot-time device enumerate
  // before the ping calls it "no device". Slack absorbs setTimeout jitter.
  const dailyPing = createDailyPing({
    currentVersion: __VERSION__,
    isEnabled: () => settings.a7s ?? true,
    getLastPingDay: () => settings.a7sDay,
    setLastPingDay: (day) => settings.setDailyPingDay(day),
    modelIds: () => driverManager.getDockStatuses().map((d) => d.modelId),
    send: sendBeacon,
    platform: platformName,
    browserLocale: () => settings.browserLocale,
    browserTimeZone: () => settings.browserTimeZone,
  });
  const runPing = (): void => {
    if (shuttingDown) return;
    trackWriter(dailyPing.ping().catch((e: unknown) => log('debug', 'dailyPing', String(e))));
  };
  timers.push(setTimeout(runPing, MIN_DWELL_MS + PING_SCHEDULE_SLACK_MS));
  timers.push(setInterval(runPing, PING_RETRY_INTERVAL_MS));
}

if (noWebui) {
  log('info', 'web', 'WebUI disabled (--no-webui)');
} else {
  await step('deckBr', `webui bind :${webuiPort}`, () => webui.start());
  log('info', 'web', `WebUI: http://localhost:${webui.port}`);
}

if (!headless && tjs.env.DECKBRIDGE_OPEN) {
  log('info', 'web', 'auto-opening browser (DECKBRIDGE_OPEN)');
  void openBrowser(`http://localhost:${webui.port}`);
}

if (headless) {
  log('info', 'tray', 'skipped (--headless)');
} else {
  // $DECKBRIDGE_TRAY_BIN, else a deckbridge-tray sidecar next to the executable
  // (no run.sh anymore). Same resolver the /requirements check reports on.
  const trayBin = await resolveTrayBin();
  if (trayBin) {
    const spawned = await step('tray', 'tray spawn', () =>
      startTray(trayBin, {
        onQuit: () => {
          void shutdown().catch(() => tjs.exit(1));
        },
        onRestartElgatoApp: () => {
          void webui.elgatoApp.restartNow();
        },
      }),
    );
    // Quit during the spawn: shutdown already ran its tray step, so close this one here.
    if (shuttingDown) await spawned?.close();
    else tray = spawned;
    if (tray) pushTrayState();
    log('info', 'tray', spawned ? `started: ${trayBin}` : `failed to spawn: ${trayBin}`);
  } else {
    log(
      'info',
      'tray',
      'no tray binary (DECKBRIDGE_TRAY_BIN unset, no deckbridge-tray next to the executable) — running without tray',
    );
  }
}

const _ifaces = tjs.system.networkInterfaces.filter((i) => !i.internal && !i.address.includes(':'));
const _privateRe = /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const localIp =
  _ifaces.find((i) => _privateRe.test(i.address))?.address ?? _ifaces[0]?.address ?? '';
if (localIp) webui.setLocalIp(localIp);

await step('deckBr', `cora bind :${ELGATO_TCP_PORT}/:${ELGATO_CHILD_PORT}`, () =>
  primaryDock.startWithRetry({
    log,
    getShuttingDown: () => shuttingDown,
    primaryPort: ELGATO_TCP_PORT,
    childPort: ELGATO_CHILD_PORT,
  }),
);
log('info', 'elgato', `primary (Network Dock) listening on ${localIp}:${ELGATO_TCP_PORT}`);
log('info', 'elgato', `child (Stream Deck) listening on ${localIp}:${ELGATO_CHILD_PORT}`);

if (__MOCK_BUILD__ && driverManager.getDriverMode() === 'mock') {
  await driverManager.connectMock();
} else {
  driverManager.tryRealConnect().catch((e: unknown) => log('error', 'hid', String(e)));
}

// Seed the dock cap from settings.json before asking for scanning. Multi-deck is
// opt-in: with it off (the default) startScan() installs no timer at all, so a
// connected single deck ends USB enumeration for good.
await driverManager.setMultiDeck(settings.multiDeck);
// Safe in mock mode: scanForDocks() guards on driverMode==='real' and a connected
// primary, so it's a no-op until a real primary is up.
driverManager.startScan();

log('info', 'deckBr', 'startup complete — entering event loop');
