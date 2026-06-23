import { log } from './logger.js';
import type { LogLevel } from './logger.js';
import { hidDevicePresent } from './ffi/hidapi.js';
import { WorkerHidDriver } from './hid-worker-host.js';
import { MockDriver } from './devices/mock.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';
import type { DeviceConfig } from './elgato-types.js';
import type { WebUIServer } from './web/server';
import type { DeviceDriver, DeviceModel } from './devices/driver.js';
import type { KeyEvent, CommEntry } from './types.js';
import { RECONNECT_DELAY_MS } from './types.js';
import { DEVICE_MODELS, DEFAULT_MODEL } from './devices/registry.js';
import { deviceInputToMk2Index } from './translator.js';
import { sendSplashImages } from './splash-sender.js';
import { modelToChildGeometry } from './capabilities.js';

export type DriverMode = 'real' | 'mock';

/** The driver mode a fresh DriverManager starts in, based on DECKBRIDGE_MOCK env var. */
export function getInitialDriverMode(): DriverMode {
  return tjs.env['DECKBRIDGE_MOCK'] === '1' ? 'mock' : 'real';
}

/** Default device-presence check: any of the model's PIDs enumerated on USB.
 *  Enumeration only (deckbridge-native) — never hid_open. See isModelPresent. */
const defaultPresenceCheck = (model: DeviceModel): boolean =>
  model.usbProductIds.some((pid) => hidDevicePresent(model.usbVendorId, pid));

export interface DriverManagerDeps {
  webui: WebUIServer;
  server: ElgatoServer;
  childServer: ElgatoChildServer;
  onTrayChange: () => void;
  getShuttingDown: () => boolean;
}

export class DriverManager {
  private readonly webui: WebUIServer;
  private readonly server: ElgatoServer;
  private readonly childServer: ElgatoChildServer;
  private readonly onTrayChange: () => void;
  private readonly getShuttingDown: () => boolean;

  private driverMode: DriverMode = getInitialDriverMode();
  private currentDriver: DeviceDriver | null = null;
  private realDriver: WorkerHidDriver | null = null;
  private reconnecting = false;
  private reconnectAttemptCount = 0;
  private probeInFlight = false;
  private imagesSent = 0;

  // Real-driver workers whose open() failed but whose worker is kept alive for
  // reuse on the next reconnect attempt, keyed by model.id. Reusing the worker
  // avoids the spawn+terminate-per-retry of a hidapi-loaded worker — the macOS
  // SIGBUS hazard for a present-but-unopenable device. Drained on switchMode;
  // the process exits on shutdown so no explicit shutdown drain is needed.
  private idleDrivers = new Map<string, WorkerHidDriver>();

  // Test-only seam: lets driver-manager.test.ts inject a fake driver whose
  // open() rejects, so the reconnect/attempt-count loop can be exercised
  // without real hardware/FFI. Do not use outside tests.
  private makeRealDriver: (model: DeviceModel) => WorkerHidDriver = (model) =>
    new WorkerHidDriver(model);

  // Gates probeAndOpen() so a worker is spawned only for a *connected* device.
  // Opening an absent device, or loading hidapi in a throwaway probe worker that
  // is then terminated, segfaults on macOS (IOKit/dlclose churn) — so presence
  // is decided up front by enumeration, never by trial hid_open. Test seam:
  // __setPresenceCheck (tests have no real FFI/hardware).
  private isModelPresent: (model: DeviceModel) => boolean = defaultPresenceCheck;

  constructor(deps: DriverManagerDeps) {
    this.webui = deps.webui;
    this.server = deps.server;
    this.childServer = deps.childServer;
    this.onTrayChange = deps.onTrayChange;
    this.getShuttingDown = deps.getShuttingDown;
  }

  getCurrentDriver(): DeviceDriver | null {
    return this.currentDriver;
  }

  getDriverMode(): DriverMode {
    return this.driverMode;
  }

  getReconnectAttemptCount(): number {
    return this.reconnectAttemptCount;
  }

  /** Test-only: override the real-driver factory used by probeAndOpen(). */
  __setRealDriverFactory(fn: (model: DeviceModel) => WorkerHidDriver): void {
    this.makeRealDriver = fn;
  }

  /** Test-only: restore the default real-driver factory. */
  __resetRealDriverFactory(): void {
    this.makeRealDriver = (model) => new WorkerHidDriver(model);
  }

  /** Test-only: override the device-presence check used by probeAndOpen(). */
  __setPresenceCheck(fn: (model: DeviceModel) => boolean): void {
    this.isModelPresent = fn;
  }

  /** Test-only: restore the default (deckbridge-native enumeration) presence check. */
  __resetPresenceCheck(): void {
    this.isModelPresent = defaultPresenceCheck;
  }

  applyDeviceModel(
    model: DeviceModel,
    deviceInfo?: {
      serial?: string;
      firmware?: string;
    },
  ): void {
    this.webui.resetImages();
    const pid = model.cora.productId;
    const geo = model.cora.advertiseGeometry ?? modelToChildGeometry(model);
    const configPatch: Partial<DeviceConfig> = { productId: pid };
    if (model.cora.usePhysicalIdentity) {
      if (deviceInfo?.serial) configPatch.childSerialNumber = deviceInfo.serial;
      if (deviceInfo?.firmware) configPatch.childFirmwareVersion = deviceInfo.firmware;
    }
    this.server.setDeviceConfig(configPatch);
    this.server.setChildGeometry(geo);
    this.server.restartMdns(pid);
    this.childServer.setChildGeometry(geo);
    this.server.pushChildCapabilities();
    this.webui.notifyDeviceModel({
      id: model.id,
      name: model.name,
      keyCount: geo.keyCount,
      columns: geo.columns,
      rows: geo.rows,
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttemptCount++;
    setTimeout(() => {
      this.tryRealConnect().catch((e: unknown) =>
        log('error', 'hid', `scheduled reconnect failed: ${(e as Error).message}`),
      );
    }, RECONNECT_DELAY_MS);
  }

  private hasInputKeyMap(model: DeviceModel): boolean {
    return model.keyMap.wireInputToCora != null || model.keyMap.inputOffset != null;
  }

  /** Attach the comm/key/error/log/disconnect event handlers to a freshly
   *  created real driver. Done once per driver instance — reused idle drivers
   *  (see idleDrivers) keep their listeners across reconnect attempts. */
  private attachRealDriverListeners(driver: WorkerHidDriver, model: DeviceModel): void {
    driver.on('comm', (entry: Omit<CommEntry, 'ts'>) => this.webui.notifyComm(entry));
    driver.on('imageSent', () => this.webui.notifyStats({ imagesSent: ++this.imagesSent }));
    driver.on('key', (e: KeyEvent) => {
      if (this.hasInputKeyMap(model)) {
        const mk2 = deviceInputToMk2Index(e.keyIndex, model);
        if (mk2 < 0) return; // unused 293S 6th-column key
        log(
          'info',
          'key',
          `${model.id} wire=0x${e.keyIndex.toString(16).padStart(2, '0')} → mk2=${mk2} ${e.state}`,
        );
        this.childServer.sendKeyEvent(mk2, e.state);
        this.webui.notifyKeyEvent(mk2, e.state);
      } else {
        log('info', 'key', `${model.id} key=${e.keyIndex} ${e.state}`);
        this.childServer.sendKeyEvent(e.keyIndex, e.state);
        this.webui.notifyKeyEvent(e.keyIndex, e.state);
      }
    });
    driver.on('error', (err: Error) => log('error', model.id, err.message));
    driver.on(
      'log',
      ({ level, component, message }: { level: LogLevel; component: string; message: string }) =>
        log(level, component, message),
    );
    driver.on('disconnect', () => {
      log('info', model.id, 'disconnected');
      this.currentDriver = null;
      this.realDriver = null;
      this.webui.notifyDriverStatus('real', false);
      // Reset to default model when nothing is connected
      this.applyDeviceModel(DEFAULT_MODEL);
      if (this.driverMode === 'real') this.scheduleReconnect();
      this.onTrayChange();
    });
  }

  private async probeAndOpen(): Promise<WorkerHidDriver | null> {
    for (const model of DEVICE_MODELS) {
      // Only spawn a worker for a device that is actually connected — probing an
      // absent model would hid_open a missing device / terminate a hidapi-loaded
      // worker, both of which segfault on macOS.
      if (!this.isModelPresent(model)) continue;
      // Reuse the worker from a prior failed open instead of spawning a fresh one
      // each retry. Terminating a hidapi-loaded worker on macOS is SIGBUS-prone,
      // so a present-but-unopenable device (e.g. Input Monitoring denied) must NOT
      // spawn+terminate a throwaway worker every reconnect cycle. The worker stays
      // idle and open() is re-issued on the same instance — which also lets it
      // connect the moment the open finally succeeds.
      let driver = this.idleDrivers.get(model.id);
      if (!driver) {
        driver = this.makeRealDriver(model);
        this.attachRealDriverListeners(driver, model);
      }
      try {
        await driver.open();
        this.idleDrivers.delete(model.id);
        return driver;
      } catch (e) {
        log('debug', 'hid', `${model.id} open failed: ${(e as Error).message}`);
        // Keep the worker alive (listeners intact) for the next retry — do NOT
        // removeAllListeners or terminate it here.
        this.idleDrivers.set(model.id, driver);
      }
    }
    return null;
  }

  async tryRealConnect(): Promise<void> {
    this.reconnecting = false;
    if (this.getShuttingDown() || this.driverMode !== 'real') return;

    if (!this.realDriver) {
      if (this.probeInFlight) return; // no concurrent probes
      this.probeInFlight = true;
      let found: WorkerHidDriver | null = null;
      try {
        log('info', 'hid', 'probing USB devices...');
        found = await this.probeAndOpen();
      } finally {
        this.probeInFlight = false;
      }

      // Re-check state after the await — a mode switch or shutdown during the
      // probe must not install a leaked worker. The driverMode check looks
      // "always 'real'" to control-flow narrowing (the guard above), but
      // switchMode() can flip it during the awaited probeAndOpen() — the E1-a race.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- driverMode is mutated across the await
      if (this.getShuttingDown() || this.driverMode !== 'real') {
        if (found) {
          found.removeAllListeners();
          await found.close().catch(() => undefined);
        }
        return;
      }

      if (!found) {
        log('warn', 'hid', `no device found — retrying in ${RECONNECT_DELAY_MS / 1000}s`);
        this.scheduleReconnect();
        this.onTrayChange();
        return;
      }
      this.realDriver = found;
      this.applyDeviceModel(this.realDriver.model, {
        serial: this.realDriver.deviceSerial,
        firmware: this.realDriver.deviceFirmware,
      });
    }

    this.reconnectAttemptCount = 0;
    log('info', 'hid', `connected: ${this.realDriver.model.name}`);
    this.currentDriver = this.realDriver;
    this.webui.notifyDriverStatus('real', true);
    this.onTrayChange();
    sendSplashImages(this.realDriver);
  }

  async connectMock(model?: DeviceModel): Promise<void> {
    const m = model ?? DEFAULT_MODEL;
    // Close existing mock driver before creating a new one
    if (this.currentDriver && this.driverMode === 'mock') {
      const prev = this.currentDriver;
      this.currentDriver = null;
      prev.removeAllListeners();
      await prev.close().catch(() => undefined);
    }
    const driver = new MockDriver(m);
    await driver.open();
    this.currentDriver = driver;
    this.applyDeviceModel(m);
    driver.on('key', (e: KeyEvent) => {
      this.childServer.sendKeyEvent(e.keyIndex, e.state);
      this.webui.notifyKeyEvent(e.keyIndex, e.state);
    });
    log('info', 'driverMgr', `mock driver active (${m.name})`);
    this.webui.notifyDriverStatus('mock', true);
  }

  async switchMode(newMode: DriverMode): Promise<void> {
    if (newMode === this.driverMode && this.currentDriver !== null) return;
    log('info', 'driverMgr', `switching driver → ${newMode}`);
    this.reconnecting = false;
    const prevCurrent = this.currentDriver;
    const prevReal = this.realDriver;
    this.currentDriver = null;
    this.realDriver = null;
    if (prevReal && prevReal !== prevCurrent) {
      prevReal.removeAllListeners();
      await prevReal.close().catch(() => undefined);
    }
    if (prevCurrent) {
      prevCurrent.removeAllListeners();
      await prevCurrent.close().catch(() => undefined);
    }
    // Drain idle real-driver workers kept alive for reconnect retries (present-
    // but-unopenable devices). One-off terminate per worker, off the hot retry
    // loop — safe, and prevents leaking worker threads when switching to mock.
    for (const d of this.idleDrivers.values()) {
      d.removeAllListeners();
      await d.close().catch(() => undefined);
    }
    this.idleDrivers.clear();
    this.driverMode = newMode;
    if (newMode === 'mock') {
      await this.connectMock();
    } else {
      this.webui.notifyDriverStatus('real', false);
      void this.tryRealConnect();
    }
  }
}
