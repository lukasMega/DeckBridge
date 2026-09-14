import { resolveTrayBin, startTray } from './tray.js';
import type { TrayHandle, TrayState } from './tray.js';
import { ElgatoServer, ElgatoChildServer } from './elgato.js';
import { WebUIServer } from './web/server';
import type { MockDeviceConfig } from './web/server';
import { MockDriver } from './devices/mock.js';
import type { ClientApp, CommEntry, ImageModeOverride, LogObject } from './types.js';
import { ELGATO_CHILD_PORT, ELGATO_TCP_PORT, WEBUI_PORT } from './types.js';
import { DEVICE_MODELS } from './devices/registry.js';
import { log, setWebUILog, setLogLevel, step } from './logger.js';
import { startLogFile, stopLogFile, activeLogFilePath } from './log-file.js';
import { setupNativeLibs } from './native-libs.js';
import { setupImageHandler } from './image-pipeline.js';
import { DriverManager, getInitialDriverMode } from './driver-manager.js';
import type { SessionServersFactory } from './device-session.js';
import { startCoraWithRetry } from './cora-startup.js';
import { isElgatoAppRunning, openPathInOS, platformName } from './os-utils.ts';
import { parseCli, userArgs, applyFlagsToEnv, versionText, USAGE_TEXT, isLogLevel } from './cli.js';
import { runDevicesCommand } from './cli-devices.js';
import { runDiagnoseCommand } from './cli-diagnose.js';
import { loadSettings } from './settings-store.js';

const openBrowser = openPathInOS;

// CLI parsing is the very first thing that happens: version/help/devices exit
// immediately, and the flags must land in tjs.env before anything below reads it
// (setupNativeLibs, WebUIServer's port, getInitialDriverMode, etc).
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
// `diagnose` runs AFTER applyFlagsToEnv (it reports the effective flags/env and honours
// --cache-dir) but before any server or device open — that's what makes it usable on the
// freeze report, where the WebUI never comes up. Enumeration only, never hid_open.
if (cli.command === 'diagnose') {
  await runDiagnoseCommand(cli.flags);
  tjs.exit(0);
}
// Log level, in precedence order: --log-level / $DECKBRIDGE_LOG_LEVEL (both already
// in env by now) win outright; otherwise settings.json's persisted "logLevel" applies.
// setLogLevel(), not a plain env read: logger.ts's own module-load env read already
// happened (as one of this file's imports, above) before this line runs. The winner is
// written back into env so every USB worker spawned later inherits it at module load.
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
const server = new ElgatoServer();
const childServer = new ElgatoChildServer(ELGATO_CHILD_PORT, server.deviceConfig, false);

let shuttingDown = false;
let tray: TrayHandle | null = null;

setWebUILog((level, component, message) => webui.log(level, component, message));

// Last-resort handler: txiki hard-aborts the process on an unhandled promise
// rejection unless preventDefault() is called. Calling it lets shutdown() run
// the device disconnect handshake / socket teardown / tray kill instead of a
// raw abort. shutdown() is idempotent, so a rejection storm collapses to one
// teardown.
globalThis.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
  ev.preventDefault();
  const reason =
    ev.reason instanceof Error ? (ev.reason.stack ?? ev.reason.message) : String(ev.reason);
  log('error', 'deckBr', `unhandled rejection — shutting down: ${reason}`);
  shutdown().catch(() => tjs.exit(1));
});

function buildTrayState(): TrayState {
  const driverConnected =
    driverManager.getCurrentDriver() !== null && driverManager.getDriverMode() === 'real';
  const { elgatoConnected } = webui.snapshot();
  let icon: TrayState['icon'];
  let status: string;
  if (driverConnected && elgatoConnected) {
    icon = 'full';
    status = 'Mirabox + Elgato connected';
  } else if (driverConnected) {
    icon = 'usb_only';
    status = 'Mirabox connected (Elgato not paired)';
  } else {
    icon = 'disconnected';
    const attempts = driverManager.getReconnectAttemptCount();
    status = attempts > 0 ? `No device (attempt ${attempts})` : 'No device';
  }
  return { icon, status, reconnectAttempts: driverManager.getReconnectAttemptCount() };
}

function pushTrayState(): void {
  tray?.push(buildTrayState());
}

// Extra-dock CORA server pair builder (multi-device). Mirrors the primary
// wiring above: the childServer gets the SAME server.deviceConfig reference, and
// each server's serverLog is piped to the shared logger (DeviceSession wires the
// driver's events but not the servers' — extras would otherwise be silent). No
// WebUI/comm mirror: the WebUI stays single-device (primary only).
const sessionServersFactory: SessionServersFactory = (identity) => {
  const s = new ElgatoServer(identity.primaryPort, false, {
    childPort: identity.childPort,
    mdnsServiceName: identity.mdnsServiceName,
    dockSerial: identity.dockSerial,
    childSerial: identity.childSerial,
  });
  const cs = new ElgatoChildServer(identity.childPort, s.deviceConfig, false);
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

server.on('serverLog', ({ level, component: c, message: m }: LogObject) => log(level, c, m));
server.on('comm', (entry: Omit<CommEntry, 'ts'>) => webui.notifyComm(entry));
server.on('clientConnected', (addr: string) => log('info', 'elgato', `primary connected: ${addr}`));
server.on('clientDisconnected', () => log('info', 'elgato', 'primary disconnected'));
server.on('clientAppDetected', (app: ClientApp) => webui.notifyClientApp(app));

childServer.on('comm', (entry: Omit<CommEntry, 'ts'>) => webui.notifyComm(entry));
childServer.on('serverLog', ({ level, component: c, message: m }: LogObject) => log(level, c, m));
childServer.on('clientAppDetected', (app: ClientApp) => webui.notifyClientApp(app));

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

// Device tuning changed: reopen the affected session(s) so the new image/wire/
// keyMap spec is in force from the next open() and the first splash.
webui.on('modelOverridesChanged', (modelId: string) => {
  driverManager.reloadDeviceTuning(modelId).catch((err: unknown) => {
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

webui.on('setDeviceMdnsName', (deviceKey: string, name: string) => {
  const ok = webui.updateDeviceMdnsName(deviceKey, name);
  if (!ok) {
    log('warn', 'deckBr', `setDeviceMdnsName: no persisted identity for deviceKey=${deviceKey}`);
    return;
  }
  driverManager.applyMdnsNameForDeviceKey(deviceKey, name);
});

webui.on('mockConfig', (cfg: MockDeviceConfig) => {
  const macParts = cfg.macAddress.split(':');
  const macBytes = macParts.length === 6 ? macParts.map((p) => parseInt(p, 16)) : [];
  server.setDeviceConfig({ ...cfg, macAddress: macBytes.length === 6 ? macBytes : [] });
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
  try {
    tjs.removeSignalListener('SIGINT', sigInt);
  } catch {}
  try {
    tjs.removeSignalListener('SIGTERM', sigTerm);
  } catch {}
  try {
    tjs.removeSignalListener('SIGHUP', sigHup);
  } catch {}
  log('info', 'deckBr', 'shutting down...');
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

const sigInt = () => onSignal('SIGINT');
const sigTerm = () => onSignal('SIGTERM');
const sigHup = () => onSignal('SIGHUP');
tjs.addSignalListener('SIGINT', sigInt);
tjs.addSignalListener('SIGTERM', sigTerm);
tjs.addSignalListener('SIGHUP', sigHup);

log('info', 'deckBr', '══════════════════════════════════════════════');
log('info', 'deckBr', `bundle built : ${__BUILD_TIME__}`);
log('info', 'deckBr', `started      : ${new Date().toISOString()}`);
log(
  'info',
  'deckBr',
  `cpus         : ${tjs.system.cpus.length}x ${tjs.system.cpus[0]?.model ?? '?'}`,
);
log('info', 'deckBr', `txiki.js     : ${tjs.version}`);
log('info', 'deckBr', `log file     : ${activeLogFilePath() ?? '(disabled)'}`);
log('debug', 'deckBr', `platform     : ${platformName() || '(unknown)'}`);
log(
  'info',
  'deckBr',
  `env DECKBRIDGE_NATIVE_LIB = ${tjs.env.DECKBRIDGE_NATIVE_LIB ?? '(not set)'}`,
);
log('info', 'deckBr', `env HIDAPI_LIB     = ${tjs.env.HIDAPI_LIB ?? '(not set)'}`);
log('info', 'deckBr', `env DECKBRIDGE_MOCK      = ${tjs.env.DECKBRIDGE_MOCK ?? '(not set)'}`);
log('info', 'deckBr', `env DECKBRIDGE_OPEN   = ${tjs.env.DECKBRIDGE_OPEN ?? '(not set)'}`);
log('info', 'deckBr', `env DECKBRIDGE_DUMP_DIR  = ${tjs.env.DECKBRIDGE_DUMP_DIR ?? '(not set)'}`);
log(
  'info',
  'deckBr',
  `env DECKBRIDGE_RAW_DUMP_DIR = ${tjs.env.DECKBRIDGE_RAW_DUMP_DIR ?? '(not set)'}`,
);
log('info', 'deckBr', '══════════════════════════════════════════════');

// Poll for a conflict with the Elgato desktop app: it is running AND the device
// slot is free, i.e. it is plausibly the reason we can't open the hardware. When
// driverConnected we own the device, so there is no conflict by definition and the
// flag is false regardless of whether the app is running (the diagnostics report
// probes the process separately — see os-utils.isElgatoAppRunning). Skip the spawn
// entirely when no WebUI client is connected — nobody is looking at the flag, and a
// fresh poll happens on the next tick once a client connects. --headless skips this
// timer entirely: no WebUI client is ever expected to be watching on a headless box.
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

// Begin polling for extra distinct-model docks. Safe in mock mode: scanExtras()
// guards on driverMode==='real' and a connected primary, so it's a no-op until
// a real primary is up.
driverManager.startScan();

log('info', 'deckBr', 'startup complete — entering event loop');
