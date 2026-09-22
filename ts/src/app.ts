import { resolveTrayBin, startTray } from './tray.js';
import type { TrayHandle, TrayState } from './tray.js';
import { ElgatoServer, ElgatoChildServer } from './elgato.js';
import { WebUIServer } from './web/server';
import type { MockDeviceConfig } from './web/server';
import { MockDriver } from './devices/mock.js';
import type { ClientApp, CommEntry, ImageModeOverride, LogObject } from './types.js';
import type { TouchStripMode } from './types.js';
import { ELGATO_CHILD_PORT, ELGATO_TCP_PORT, WEBUI_PORT } from './types.js';
import { advertisedGeometry, DEFAULT_MODEL, DEVICE_MODELS } from './devices/registry.js';
import type { OverrideChangeKind } from './devices/model-overrides.js';
import { log, setWebUILog, setLogLevel, step } from './logger.js';
import { startLogFile, stopLogFile, activeLogFilePath } from './log-file.js';
import { setupNativeLibs } from './native-libs.js';
import { setupImageHandler } from './image-pipeline.js';
import { DriverManager, getInitialDriverMode } from './driver-manager.js';
import { macToBytes } from './driver-manager-primary.js';
import type { SessionServersFactory } from './device-session.js';
import { startCoraWithRetry } from './cora-startup.js';
import { isElgatoAppRunning, openPathInOS, platformName } from './os-utils.ts';
import { parseCli, userArgs, applyFlagsToEnv, versionText, USAGE_TEXT, isLogLevel } from './cli.js';
import { runDevicesCommand } from './cli-devices.js';
import { runDiagnoseCommand } from './cli-diagnose.js';
import { loadSettings } from './settings-store.js';
import { STARTUP_DELAY_MS, CHECK_INTERVAL_MS } from './update-check.js';
import { MIN_DWELL_MS, PING_SCHEDULE_SLACK_MS, PING_RETRY_INTERVAL_MS } from './daily-ping-env.js';

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
// Log level precedence: --log-level / $DECKBRIDGE_LOG_LEVEL (already in env) win,
// else settings.json's "logLevel". Winner goes back into env so USB workers inherit it.
if (tjs.env.DECKBRIDGE_LOG_LEVEL) {
  setLogLevel(tjs.env.DECKBRIDGE_LOG_LEVEL);
} else {
  const { logLevel } = await loadSettings();
  if (isLogLevel(logLevel)) {
    setLogLevel(logLevel);
    tjs.env.DECKBRIDGE_LOG_LEVEL = logLevel;
  }
}
// Disk sink first — before setupNativeLibs, before any HID call. defaultCacheRoot()
// is pure (env + tjs.homeDir), so this needs no native lib, and a freeze anywhere
// below still leaves the breadcrumb that names the step it hung on.
startLogFile();
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
);
const defaultChildGeometry = advertisedGeometry(DEFAULT_MODEL);
const server = new ElgatoServer(defaultChildGeometry);
const childServer = new ElgatoChildServer(
  defaultChildGeometry,
  ELGATO_CHILD_PORT,
  server.deviceConfig,
  false,
);

let shuttingDown = false;
let tray: TrayHandle | null = null;
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
let dailyPingTimer: ReturnType<typeof setInterval> | null = null;

setWebUILog((level, component, message) => webui.log(level, component, message));

// txiki hard-aborts on unhandled rejection unless preventDefault(); this lets shutdown() run the teardown instead.
globalThis.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  ev.preventDefault();
  const reason =
    ev.reason instanceof Error ? (ev.reason.stack ?? ev.reason.message) : String(ev.reason);
  log('error', 'deckBr', `unhandled rejection — shutting down: ${reason}`);
  shutdown().catch(() => tjs.exit(1));
});

function buildTrayState(): TrayState {
  const driver = driverManager.getCurrentDriver();
  const driverConnected = driver !== null && driverManager.getDriverMode() === 'real';
  const { elgatoConnected } = webui.snapshot();
  // The USB device is whatever model is actually open (Mirabox OR Elgato hardware);
  // "Elgato" in these strings means the Stream Deck app on the other end of CORA.
  const deviceName = driver?.model.name ?? 'Device';
  let icon: TrayState['icon'];
  let status: string;
  if (driverConnected && elgatoConnected) {
    icon = 'full';
    status = `${deviceName} + Elgato app connected`;
  } else if (driverConnected) {
    icon = 'usb_only';
    status = `${deviceName} connected (Elgato app not paired)`;
  } else {
    icon = 'disconnected';
    const attempts = driverManager.getReconnectAttemptCount();
    status = attempts > 0 ? `No device (attempt ${attempts})` : 'No device';
  }
  const update = webui.updates.info();
  let updateText = 'Using latest version';
  if (!update.enabled) {
    updateText = 'Update checks disabled';
  } else if (update.updateAvailable) {
    updateText = `Update available: v${update.latest ?? '?'}`;
  } else if (update.lastCheckedAt === undefined) {
    updateText = 'Checking for updates…';
  }
  return {
    icon,
    status,
    reconnectAttempts: driverManager.getReconnectAttemptCount(),
    updateAvailable: update.updateAvailable && update.latest !== update.dismissedVersion,
    updateText,
    version: __VERSION__,
  };
}

function pushTrayState(): void {
  tray?.push(buildTrayState());
}

webui.updates.setOnChange(pushTrayState);

// Extra-dock CORA server pair builder (multi-device). Mirrors the primary wiring
// above: the childServer shares the SAME server.deviceConfig reference, and each
// serverLog is piped to the shared logger. No WebUI/comm mirror — WebUI stays primary-only.
const sessionServersFactory: SessionServersFactory = (identity) => {
  const s = new ElgatoServer(defaultChildGeometry, identity.primaryPort, false, {
    childPort: identity.childPort,
    mdnsServiceName: identity.mdnsServiceName,
    dockSerial: identity.dockSerial,
    childSerial: identity.childSerial,
  });
  const cs = new ElgatoChildServer(defaultChildGeometry, identity.childPort, s.deviceConfig, false);
  s.on('serverLog', ({ level, component: c, message: m }: LogObject) => log(level, c, m));
  cs.on('serverLog', ({ level, component: c, message: m }: LogObject) => log(level, c, m));
  return { server: s, childServer: cs };
};

const driverManager = new DriverManager({
  webui,
  server,
  childServer,
  onTrayChange: pushTrayState,
  getShuttingDown: () => shuttingDown,
  sessionServersFactory,
  onDocksChanged: () => webui.notifyDocks(driverManager.getDockStatuses()),
});

setupImageHandler(childServer, webui, () => driverManager.getCurrentDriver());

// Wiring both halves of the primary CORA pair share (extras get serverLog only —
// see sessionServersFactory).
for (const s of [server, childServer]) {
  s.on('serverLog', ({ level, component: c, message: m }: LogObject) => log(level, c, m));
  s.on('comm', (entry: Omit<CommEntry, 'ts'>) => webui.notifyComm(entry));
  s.on('clientAppDetected', (app: ClientApp) => webui.notifyClientApp(app));
}

server.on('clientConnected', (addr: string) => log('info', 'elgato', `primary connected: ${addr}`));
server.on('clientDisconnected', () => log('info', 'elgato', 'primary disconnected'));

childServer.on('clientConnected', (addr: string) => {
  log('info', 'elgato', `child connected: ${addr}`);
  webui.notifyElgatoStatus(true, addr);
  pushTrayState();
  webui.notifyDocks(driverManager.getDockStatuses());
  // Re-push the saved brightness once the Elgato app has settled after
  // pairing — the app's own default-brightness handshake would otherwise
  // stomp the user's setting.
  setTimeout(() => {
    if (shuttingDown) return;
    driverManager.setDockBrightness(0, webui.brightnessForDock(0));
  }, 1000);
});

childServer.on('clientDisconnected', () => {
  log('info', 'elgato', 'child disconnected');
  webui.notifyElgatoStatus(false);
  pushTrayState();
  webui.notifyDocks(driverManager.getDockStatuses());
});

childServer.on('brightness', (level: number) => {
  if (webui.isBrightnessOverrideForDock(0)) {
    log('debug', 'elgato', `brightness ${level} from Elgato ignored (override on)`);
    return;
  }
  log('info', 'elgato', `brightness set to ${level}`);
  driverManager.setDockBrightness(0, level);
  webui.notifyBrightness(level);
  webui.notifyRepaint();
});

webui.on('regenPreviews', (_resizeOn: boolean) => {
  for (const [keyIndex, jpeg] of webui.imageState.entries()) {
    webui.notifyImageUpdate(keyIndex, jpeg);
  }
});

webui.on('setBrightness', (level: number, dock?: number) => {
  driverManager.setDockBrightness(dock ?? 0, level);
});

webui.on('setImageOverride', (mode: ImageModeOverride, dock?: number) => {
  const d = driverManager.getDriverForDock(dock ?? 0);
  d?.setImageOverride?.(mode);
  // The Elgato app won't resend on a mode flip — repaint from the stored CORA
  // frames (imageState = the selected dock's live frames) so the change is
  // visible immediately.
  for (const [k, data] of webui.imageState) {
    d?.renderCoraImage?.(k, data, webui.imageFormat.get(k) ?? 'jpeg');
  }
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
// session(s) and repainted; keyMap/wire/splash reopen so the new spec is in
// force from the next open() and the first splash.
webui.on('modelOverridesChanged', (modelId: string, kind: OverrideChangeKind = 'reopen') => {
  driverManager.reloadDeviceTuning(modelId, kind).catch((err: unknown) => {
    log('error', 'deckBr', `reloadDeviceTuning(${modelId}) failed: ${(err as Error).message}`);
  });
});

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

// An extra-key assignment changed (WebUI) — repaint that dock's key icons.
// Dispatch needs no re-wire: it resolves the config per press.
webui.on('extraKeyChanged', (dock: number) => {
  driverManager.repaintExtraKeysForDock(dock);
});

webui.on('extraKeyRunNow', (dock: number, wireId: number) => {
  driverManager.forceRunExtraKey(dock, wireId);
});

webui.on('touchStripModeChanged', (dock: number, mode: TouchStripMode) => {
  driverManager.setTouchStripModeForDock(dock, mode);
});

webui.on('setDeviceMdnsName', (deviceKey: string, name: string) => {
  const ok = webui.updateDeviceMdnsName(deviceKey, name);
  if (!ok) {
    log('warn', 'deckBr', `setDeviceMdnsName: no persisted identity for deviceKey=${deviceKey}`);
    return;
  }
  driverManager.applyMdnsNameForDeviceKey(deviceKey, name);
});

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

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [sig, handler] of signalHandlers) {
    try {
      tjs.removeSignalListener(sig, handler);
    } catch {}
  }
  log('info', 'deckBr', 'shutting down...');
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (dailyPingTimer) clearInterval(dailyPingTimer);
  driverManager.stopScan();
  await driverManager.stopAllExtraSessions().catch(() => undefined);
  const prev = driverManager.getCurrentDriver();
  if (prev) prev.removeAllListeners();
  await prev?.close().catch(() => undefined);
  await server.stop().catch(() => undefined);
  await childServer.stop().catch(() => undefined);
  await webui.stop().catch(() => undefined);
  tray?.close();
  // Last thing before exit: drain the batched log lines so the shutdown path
  // itself is on disk (the tray "Quit" handler routes through here too).
  await stopLogFile().catch(() => undefined);
  tjs.exit(0);
}

function onSignal(sig?: string): void {
  log('warn', 'deckBr', `received ${sig ?? 'signal'} — shutting down`);
  shutdown().catch(() => tjs.exit(1));
}

// Kept as [signal, handler] pairs so shutdown() can unregister the exact same
// function references it registered.
const signalHandlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(
  (sig) => [sig, () => onSignal(sig)] as const,
);
for (const [sig, handler] of signalHandlers) tjs.addSignalListener(sig, handler);

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
  ['info', `env DECKBRIDGE_MOCK      = ${tjs.env.DECKBRIDGE_MOCK ?? '(not set)'}`],
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
  setInterval(async () => {
    if (!webui.hasClients()) return;
    const connected = webui.snapshot().driverConnected;
    const next = connected ? false : await isElgatoAppRunning();
    if (next !== _elgatoAppConflict) {
      _elgatoAppConflict = next;
      webui.notifyElgatoAppConflict(next);
    }
  }, 2000);
}

// GitHub-release update check (update-check.ts): a delayed start keeps it off the
// blocking startup path; mock mode never touches the network. Failures log at
// debug — an offline user is the normal case, see update-controller.ts.
if (tjs.env.DECKBRIDGE_MOCK !== '1') {
  const runUpdateCheck = (): void => {
    void webui.updates.check(false).catch((e: unknown) => log('debug', 'update', String(e)));
  };
  setTimeout(runUpdateCheck, STARTUP_DELAY_MS);
  updateCheckTimer = setInterval(runUpdateCheck, CHECK_INTERVAL_MS);

  // Own delay, not the update check's 30 s: MIN_DWELL_MS keeps CI/sandbox runs
  // from beaconing (daily-ping-env.ts) and lets a boot-time device enumerate
  // before the ping calls it "no device". Slack absorbs setTimeout jitter.
  const runPing = (): void => {
    void webui.updates.ping().catch((e: unknown) => log('debug', 'dailyPing', String(e)));
  };
  setTimeout(runPing, MIN_DWELL_MS + PING_SCHEDULE_SLACK_MS);
  dailyPingTimer = setInterval(runPing, PING_RETRY_INTERVAL_MS);
}

// --no-webui: settings still load (see WebUIServer.start), the HTTP/WS listener doesn't.
await step('deckBr', `webui bind :${webuiPort}`, () => webui.start(!noWebui));
if (noWebui) {
  log('info', 'web', 'WebUI disabled (--no-webui)');
} else {
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
      startTray(trayBin, () => {
        void shutdown().catch(() => tjs.exit(1));
      }),
    );
    tray = spawned;
    if (spawned) pushTrayState();
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
  startCoraWithRetry({
    server,
    childServer,
    log,
    webuiLog: (level, component, message) => webui.log(level, component, message),
    getShuttingDown: () => shuttingDown,
    elgatoTcpPort: ELGATO_TCP_PORT,
    elgatoChildPort: ELGATO_CHILD_PORT,
  }),
);
log('info', 'elgato', `primary (Network Dock) listening on ${localIp}:${ELGATO_TCP_PORT}`);
log('info', 'elgato', `child (Stream Deck) listening on ${localIp}:${ELGATO_CHILD_PORT}`);

if (driverManager.getDriverMode() === 'mock') {
  await driverManager.connectMock();
} else {
  driverManager.tryRealConnect().catch((e: unknown) => log('error', 'hid', String(e)));
}

// Seed the dock cap from settings.json before asking for scanning. Multi-deck is
// opt-in: with it off (the default) startScan() installs no timer at all, so a
// connected single deck ends USB enumeration for good.
await driverManager.setMultiDeck(webui.multiDeckEnabled());
// Safe in mock mode: scanExtras() guards on driverMode==='real' and a connected
// primary, so it's a no-op until a real primary is up.
driverManager.startScan();

log('info', 'deckBr', 'startup complete — entering event loop');
