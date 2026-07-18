import { log } from './logger.js';
import { hidDevicePresent, hidSerialForPath, listHidPaths } from './ffi/hidapi.js';
import { WorkerHidDriver, closeDriver } from './hid-worker-host.js';
import { MockDriver } from './devices/mock.js';
import type { KeyEvent, CommEntry, DockStatus } from './types.js';
import { RECONNECT_DELAY_MS } from './types.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';
import type { WebUIServer } from './web/server';
import type { DeviceDriver, DeviceModel } from './devices/driver.js';
import { DEVICE_MODELS, DEFAULT_MODEL } from './devices/registry.js';
import { sendSplashImages } from './splash-sender.js';
import { modelToChildGeometry } from './capabilities.js';
import { applyModelToServers, wireCommonDriverEvents } from './device-session.js';
import type { SessionServersFactory } from './device-session.js';
import { PrimaryDock } from './driver-manager-primary.js';
import { ExtraDockCoordinator } from './driver-manager-extras.js';
import { deviceKeyFor } from './device-identity.js';

export type DriverMode = 'real' | 'mock';

/** The driver mode a fresh DriverManager starts in, based on DECKBRIDGE_MOCK env var. */
export function getInitialDriverMode(): DriverMode {
  return tjs.env['DECKBRIDGE_MOCK'] === '1' ? 'mock' : 'real';
}

/** Device presence = any of the model's PIDs enumerated on USB. Enumeration
 *  only (deckbridge-native) — never trial hid_open (macOS SIGBUS, see probeAndOpen). */
const defaultPresenceCheck = (model: DeviceModel): boolean =>
  model.usbProductIds.some((pid) => hidDevicePresent(model.usbVendorId, pid));

/** Every connected HID interface matching the model's VID + usagePage/usage, across its
 *  PIDs — one path per physical unit. [] when the model can't be safely path-targeted. */
const defaultListModelPaths = (model: DeviceModel): string[] => {
  const { usagePage, usage } = model;
  if (usagePage === undefined || usage === undefined) return [];
  const paths = model.usbProductIds.flatMap((pid) =>
    listHidPaths(model.usbVendorId, usagePage, usage, pid),
  );
  return [...new Set(paths)];
};

export interface DriverManagerDeps {
  webui: WebUIServer;
  server: ElgatoServer;
  childServer: ElgatoChildServer;
  onTrayChange: () => void;
  getShuttingDown: () => boolean;
  /** Builds the CORA server pair for an extra dock (wired in app.ts). Absent → extras disabled. */
  sessionServersFactory?: SessionServersFactory;
  /** Any dock's status() shape may have changed — the WebUI pushes getDockStatuses(). */
  onDocksChanged?: () => void;
}

export class DriverManager {
  private readonly deps: DriverManagerDeps;

  private driverMode: DriverMode = getInitialDriverMode();
  private currentDriver: DeviceDriver | null = null;
  private realDriver: WorkerHidDriver | null = null;
  private reconnecting = false;
  private reconnectAttemptCount = 0;
  private probeInFlight = false;
  private imagesSent = 0;

  /** Primary dock (index 0) state: identity, brightness, widgets, saved-frame replay. */
  private readonly primary: PrimaryDock;

  /** Workers whose open() failed, kept alive for reuse on the next reconnect attempt
   *  (keyed by model.id) — spawning+terminating a hidapi-loaded worker per retry SIGBUSes
   *  on macOS. Drained on switchMode; process exit covers shutdown. */
  private idleDrivers = new Map<string, WorkerHidDriver>();

  /** Multi-device coordinator (extras only). Deps are closures over this instance's
   *  mutable state — always-current values without an import cycle. */
  private readonly extraCoordinator: ExtraDockCoordinator;

  // Test seams (tests have no hardware/FFI) — overridden via __set* below. Presence is
  // decided up front by enumeration, never trial hid_open: opening an absent device or
  // terminating a throwaway hidapi-loaded worker segfaults on macOS (IOKit/dlclose churn).
  private makeRealDriver: (model: DeviceModel) => WorkerHidDriver = (model) =>
    new WorkerHidDriver(model);
  private isModelPresent: (model: DeviceModel) => boolean = defaultPresenceCheck;
  private listModelPaths: (model: DeviceModel) => string[] = defaultListModelPaths;

  constructor(deps: DriverManagerDeps) {
    this.deps = deps;
    this.primary = new PrimaryDock({ webui: deps.webui, server: deps.server });
    this.extraCoordinator = new ExtraDockCoordinator({
      getShuttingDown: deps.getShuttingDown,
      getDriverMode: () => this.driverMode,
      isProbeInFlight: () => this.probeInFlight,
      sessionServersFactory: deps.sessionServersFactory ?? null,
      getRealDriver: () => this.realDriver,
      listModelPaths: (model) => this.listModelPaths(model),
      makeRealDriver: (model) => this.makeRealDriver(model),
      takeIdleDriver: (modelId) => {
        const d = this.idleDrivers.get(modelId);
        this.idleDrivers.delete(modelId);
        return d;
      },
      parkIdleDriver: (modelId, driver) => this.idleDrivers.set(modelId, driver),
      getOrCreateDeviceIdentity: (deviceKey, defaultMdnsName) =>
        deps.webui.getOrCreateDeviceIdentity(deviceKey, defaultMdnsName),
      onSessionsChanged: () => this.deps.onDocksChanged?.(),
      onImage: (dockIndex, keyIndex, data, format) =>
        deps.webui.notifyDockImage(dockIndex, keyIndex, Buffer.from(data), format),
      isBrightnessOverride: (deviceKey) => deps.webui.isBrightnessOverride(deviceKey),
      extraKeyConfigFor: (deviceKey, wireId) => deps.webui.extraKeyConfigFor(deviceKey, wireId),
    });
  }

  getCurrentDriver(): DeviceDriver | null {
    return this.currentDriver;
  }

  /** Driver behind the dock at `index` (0 = primary, 1.. = extra session). */
  getDriverForDock(index: number): DeviceDriver | null {
    return index === 0 ? this.currentDriver : this.extraCoordinator.getDriverForDock(index);
  }

  /** Apply + record a brightness level for the dock at `index`. */
  setDockBrightness(index: number, level: number): void {
    if (index !== 0) {
      this.extraCoordinator.setDockBrightness(index, level);
      return;
    }
    this.primary.setBrightness(this.currentDriver, level);
    this.deps.onDocksChanged?.();
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

  __resetRealDriverFactory(): void {
    this.makeRealDriver = (model) => new WorkerHidDriver(model);
  }

  /** Test-only: override the device-presence check used by probeAndOpen(). */
  __setPresenceCheck(fn: (model: DeviceModel) => boolean): void {
    this.isModelPresent = fn;
  }

  /** Test-only: override the extra-dock coordinator's per-model path enumeration. */
  __setListModelPaths(fn: (model: DeviceModel) => string[]): void {
    this.listModelPaths = fn;
  }

  applyDeviceModel(model: DeviceModel, deviceInfo?: { serial?: string; firmware?: string }): void {
    this.deps.webui.resetImages();
    this.primary.model = model;
    this.primary.deviceInfo = deviceInfo;
    // Server-facing push shared with extras (device-session.ts); the WebUI half is primary-only.
    applyModelToServers(this.deps.server, this.deps.childServer, model, deviceInfo);
    const geo = model.cora.advertiseGeometry ?? modelToChildGeometry(model);
    this.deps.webui.notifyDeviceModel({
      id: model.id,
      name: model.name,
      keyCount: geo.keyCount,
      columns: geo.columns,
      rows: geo.rows,
    });
    this.deps.onDocksChanged?.();
  }

  /** Live-rename the mDNS advert of whichever live dock matches `deviceKey`. */
  applyMdnsNameForDeviceKey(deviceKey: string, name: string): boolean {
    if (this.primary.applyMdnsName(deviceKey, name)) {
      this.deps.onDocksChanged?.();
      return true;
    }
    return this.extraCoordinator.applyMdnsNameForDeviceKey(deviceKey, name);
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

  /** Attach event handlers to a freshly created real driver — once per instance; reused
   *  idle drivers keep their listeners. Common wiring shared with extras. */
  private attachRealDriverListeners(driver: WorkerHidDriver, model: DeviceModel): void {
    driver.on('comm', (entry: Omit<CommEntry, 'ts'>) => this.deps.webui.notifyComm(entry));
    driver.on('imageSent', () => this.deps.webui.notifyStats({ imagesSent: ++this.imagesSent }));
    wireCommonDriverEvents(driver, model, {
      onKey: (index, state) => {
        this.deps.childServer.sendKeyEvent(index, state);
        this.deps.webui.notifyKeyEvent(index, state);
      },
      onReinit: () => this.primary.repaintWidgets(),
    });
    driver.on('disconnect', () => {
      log('info', model.id, 'disconnected');
      this.primary.onDisconnect(model.id);
      this.currentDriver = null;
      this.realDriver = null;
      this.deps.webui.notifyDriverStatus('real', false);
      // Reset to default model when nothing is connected
      this.applyDeviceModel(DEFAULT_MODEL);
      if (this.driverMode === 'real') this.scheduleReconnect();
      this.deps.onTrayChange();
      this.deps.onDocksChanged?.();
    });
  }

  /** Elgato-branded model enumerated on USB — gates the "Elgato app is blocking
   *  access" screen so it can't fire without Elgato hardware present. */
  private elgatoHardwarePresent(): boolean {
    return DEVICE_MODELS.some(
      (model) => model.driverKind === 'elgato-hid' && this.isModelPresent(model),
    );
  }

  private async probeAndOpen(): Promise<WorkerHidDriver | null> {
    for (const model of DEVICE_MODELS) {
      // Only spawn a worker for a connected device — hid_open on a missing device
      // or terminating a hidapi-loaded worker segfaults on macOS.
      if (!this.isModelPresent(model)) continue;
      // Reuse the worker from a prior failed open (present-but-unopenable device,
      // e.g. Input Monitoring denied) — it connects the moment open() succeeds.
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
        // Keep the worker alive, listeners intact, for the next retry.
        this.idleDrivers.set(model.id, driver);
      }
    }
    return null;
  }

  async tryRealConnect(): Promise<void> {
    this.reconnecting = false;
    if (this.deps.getShuttingDown() || this.driverMode !== 'real') return;

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

      // Re-check after the await: switchMode()/shutdown during the awaited probe
      // (the E1-a race) must not install a leaked worker.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- driverMode is mutated across the await
      if (this.deps.getShuttingDown() || this.driverMode !== 'real') {
        if (found) await closeDriver(found);
        return;
      }

      if (!found) {
        log('warn', 'hid', `no device found — retrying in ${RECONNECT_DELAY_MS / 1000}s`);
        this.deps.webui.notifyElgatoDevicePresent(this.elgatoHardwarePresent());
        this.scheduleReconnect();
        this.deps.onTrayChange();
        return;
      }
      this.deps.webui.notifyElgatoDevicePresent(false);
      this.realDriver = found;
      // Stable USB-serial key, else the (volatile) hidPath, else a per-model
      // key (VID/PID-fallback open, no usage-matched path) — same as extras.
      const hidPath = found.hidPath;
      const serial = hidPath ? hidSerialForPath(hidPath) : null;
      this.primary.resolveIdentity(deviceKeyFor(hidPath ?? `model:${found.model.id}`, serial));
      this.applyDeviceModel(found.model, {
        serial: found.deviceSerial,
        firmware: found.deviceFirmware,
      });
    }

    this.reconnectAttemptCount = 0;
    log('info', 'hid', `connected: ${this.realDriver.model.name}`);
    this.currentDriver = this.realDriver;
    this.primary.seedFromIdentity(this.realDriver);
    this.deps.webui.notifyDriverStatus('real', true);
    this.deps.onTrayChange();
    sendSplashImages(this.realDriver);
    this.primary.repaintFromSavedFrames(this.realDriver);
    this.primary.startWidgets(this.realDriver);
    this.deps.onDocksChanged?.();
  }

  /** WebUI extra-key config change — repaint (config resolves per tick, no re-wire). */
  repaintExtraKeysForDock(index: number): void {
    if (index === 0) this.primary.repaintWidgets();
    else this.extraCoordinator.repaintExtraKeys(index);
  }

  /** WebUI "Run now" for a command-widget extra key on the dock at `index`. */
  forceRunExtraKey(index: number, wireId: number): void {
    if (index === 0) this.primary.forceRunWidget(wireId);
    else this.extraCoordinator.forceRunExtraKey(index, wireId);
  }

  async connectMock(model?: DeviceModel): Promise<void> {
    const m = model ?? DEFAULT_MODEL;
    // Close existing mock driver before creating a new one
    if (this.currentDriver && this.driverMode === 'mock') {
      const prev = this.currentDriver;
      this.currentDriver = null;
      await closeDriver(prev);
    }
    const driver = new MockDriver(m);
    await driver.open();
    this.currentDriver = driver;
    this.applyDeviceModel(m);
    driver.on('key', (e: KeyEvent) => {
      this.deps.childServer.sendKeyEvent(e.keyIndex, e.state);
      this.deps.webui.notifyKeyEvent(e.keyIndex, e.state);
    });
    log('info', 'driverMgr', `mock driver active (${m.name})`);
    this.deps.webui.notifyDriverStatus('mock', true);
  }

  async switchMode(newMode: DriverMode): Promise<void> {
    if (newMode === this.driverMode && this.currentDriver !== null) return;
    log('info', 'driverMgr', `switching driver → ${newMode}`);
    this.reconnecting = false;
    this.primary.stopWidgets();
    const prevCurrent = this.currentDriver;
    const prevReal = this.realDriver;
    this.currentDriver = null;
    this.realDriver = null;
    if (prevReal && prevReal !== prevCurrent) await closeDriver(prevReal);
    if (prevCurrent) await closeDriver(prevCurrent);
    // Drain idle workers — one-off terminate off the hot retry loop, no thread leaks.
    for (const d of this.idleDrivers.values()) await closeDriver(d);
    this.idleDrivers.clear();
    // Extras are real-mode only; going to real, scanExtras() rebuilds them.
    await this.stopAllExtraSessions();
    this.driverMode = newMode;
    if (newMode === 'mock') {
      await this.connectMock();
    } else {
      this.deps.webui.notifyDriverStatus('real', false);
      void this.tryRealConnect();
    }
    this.deps.onDocksChanged?.();
  }

  // ── Multi-device (extra docks): thin delegation to ExtraDockCoordinator ────

  /** Begin polling for extra devices to expose as their own docks. Idempotent. */
  startScan(): void {
    this.extraCoordinator.startScan();
  }

  stopScan(): void {
    this.extraCoordinator.stopScan();
  }

  /** Test-only seam: run one extra-device scan pass without the timer. */
  async __scanOnce(): Promise<void> {
    await this.extraCoordinator.scanOnce();
  }

  /** Tear down every extra dock and reset the index pool (switchMode, shutdown). */
  async stopAllExtraSessions(): Promise<void> {
    await this.extraCoordinator.stopAllExtraSessions();
  }

  /** Every live dock's status for the WebUI: primary (index 0, if connected)
   *  then extras (sorted by index). Real mode with no driver → extras only. */
  getDockStatuses(): DockStatus[] {
    const extras = this.extraCoordinator.getDockStatuses();
    if (this.driverMode === 'real' && this.currentDriver === null) return extras;
    return [
      this.primary.status(this.deps.server.hasClient, this.deps.childServer.hasClient),
      ...extras,
    ];
  }
}
