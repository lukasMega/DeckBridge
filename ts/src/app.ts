import { startTray } from './tray.js';
import type { TrayHandle, TrayState } from './tray.js';
import { ElgatoServer, ElgatoChildServer } from './elgato.js';
import { WebUIServer } from './web/server';
import type { MockDeviceConfig } from './web/server';
import { MockDriver } from './devices/mock.js';
import type { ClientApp, CommEntry, ImageModeOverride, LogObject } from './types.js';
import { ELGATO_CHILD_PORT, ELGATO_TCP_PORT, WEBUI_PORT } from './types.js';
import { DEVICE_MODELS } from './devices/registry.js';
import { log, setWebUILog } from './logger.js';
import { setupNativeLibs } from './native-libs.js';
import { setupImageHandler } from './image-pipeline.js';
import { DriverManager, getInitialDriverMode } from './driver-manager.js';
import type { SessionServersFactory } from './device-session.js';
import { startCoraWithRetry } from './cora-startup.js';
import { openPathInOS, platformName } from './os-utils.ts';

const [MAC_OS, WIN] = ['macOS', 'Windows'];

const openBrowser = openPathInOS;

async function isElgatoAppRunning(): Promise<boolean> {
  // platformName() returns 'macOS', 'Windows', 'Linux', etc. (or '' if unavailable).
  const platform = platformName();
  if (platform !== MAC_OS && platform !== WIN) return false;
  try {
    if (platform === MAC_OS) {
      const p = tjs.spawn(['pgrep', '-x', 'Stream Deck'], { stdout: 'ignore', stderr: 'ignore' });
      const { exit_status } = await p.wait();
      return exit_status === 0;
    }
    // Windows: pipe stdout and check for the process name
    const p = tjs.spawn(['tasklist', '/FI', 'IMAGENAME eq StreamDeck.exe', '/NH'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const dec = new TextDecoder();
    let out = '';
    const reader = p.stdout.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
    await p.wait();
    return out.toLowerCase().includes('streamdeck.exe');
  } catch {
    return false;
  }
}

// Extract embedded native libs and set DECKBRIDGE_NATIVE_LIB / HIDAPI_LIB
// before any server, the HID worker, or the FFI loaders run.
// No-op when env vars are already set (dev) or in --no-embed builds.
await setupNativeLibs();

const webui = new WebUIServer(
  WEBUI_PORT,
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

// WebUI "Run now" on a command-widget extra key — force an immediate re-run.
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

// Poll for the Elgato desktop app running status. When driverConnected the
// conflict is irrelevant; only check when the device slot is free. Skip the
// spawn entirely when no WebUI client is connected — nobody is looking at
// `elgatoAppRunning`, and a fresh poll happens on the next tick once a client
// connects.
let _elgatoAppRunning = false;
setInterval(async () => {
  if (!webui.hasClients()) return;
  const connected = webui.snapshot().driverConnected;
  const next = connected ? false : await isElgatoAppRunning();
  if (next !== _elgatoAppRunning) {
    _elgatoAppRunning = next;
    webui.notifyElgatoAppRunning(next);
  }
}, 2000);

await webui.start();
log('info', 'web', `WebUI: http://localhost:${webui.port}`);

if (tjs.env.DECKBRIDGE_OPEN) {
  log('info', 'web', 'auto-opening browser (DECKBRIDGE_OPEN)');
  void openBrowser(`http://localhost:${webui.port}`);
}

let trayBin = tjs.env.DECKBRIDGE_TRAY_BIN ?? '';
if (!trayBin) {
  // No run.sh anymore: look for a deckbridge-tray sidecar next to the executable.
  const exeDir = tjs.exePath.slice(0, tjs.exePath.lastIndexOf('/'));
  const candidate = `${exeDir}/deckbridge-tray`;
  try {
    const st = await tjs.stat(candidate);
    if (st.isFile) trayBin = candidate;
  } catch {}
}
if (trayBin) {
  tray = startTray(trayBin, () => {
    void shutdown().catch(() => tjs.exit(1));
  });
  log('info', 'tray', tray ? `started: ${trayBin}` : `failed to spawn: ${trayBin}`);
} else {
  log('info', 'tray', 'DECKBRIDGE_TRAY_BIN not set — running without tray');
}

const _ifaces = tjs.system.networkInterfaces.filter((i) => !i.internal && !i.address.includes(':'));
const _privateRe = /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const localIp =
  _ifaces.find((i) => _privateRe.test(i.address))?.address ?? _ifaces[0]?.address ?? '';
if (localIp) webui.setLocalIp(localIp);

await startCoraWithRetry({
  server,
  childServer,
  log,
  webuiLog: (level, component, message) => webui.log(level, component, message),
  getShuttingDown: () => shuttingDown,
  elgatoTcpPort: ELGATO_TCP_PORT,
  elgatoChildPort: ELGATO_CHILD_PORT,
});
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
