import { log, step } from './logger.js';
import { overridesDisabled } from './cli.js';
import { hidDevicePresent, hidSerialForPath, listHidPaths } from './ffi/hidapi.js';
import { WorkerHidDriver, closeDriver } from './hid-worker-host.js';
import { MockDriver } from './devices/mock.js';
import type { KeyEvent, CommEntry, DockStatus } from './types.js';
import { RECONNECT_DELAY_MS } from './types.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';
import type { WebUIServer } from './web/server';
import type { DeviceDriver, DeviceModel, DeviceModelOverride } from './devices/driver.js';
import { applyModelOverrides, overrideSummary } from './devices/model-overrides.js';
import { DEVICE_MODELS, DEFAULT_MODEL } from './devices/registry.js';
import { sendSplashImages } from './splash-sender.js';
import { modelToChildGeometry } from './capabilities.js';
import { applyModelToServers, wireCommonDriverEvents } from './device-session.js';
import type { SessionServersFactory } from './device-session.js';
import { PrimaryDock } from './driver-manager-primary.js';
import { ExtraDockCoordinator } from './driver-manager-extras.js';
import { deviceKeyFor, sharedSerialModelId } from './device-identity.js';

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
  private makeRealDriver: (model: DeviceModel, ov?: DeviceModelOverride) => WorkerHidDriver = (
    model,
    ov,
  ) => new WorkerHidDriver(model, ov);
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
      effectiveModelFor: (model) => ({
        model: this.effectiveModel(model),
        override: this.overrideFor(model.id),
      }),
      makeRealDriver: (model, ov) => this.makeRealDriver(model, ov),
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

  /** Push a runtime log-level change to every live USB worker (primary, extras,
   *  and parked idle workers). Workers spawned later inherit it from
   *  DECKBRIDGE_LOG_LEVEL, which app.ts keeps in sync. */
  setLogLevel(level: string): void {
    this.realDriver?.setLogLevel(level);
    for (const d of this.idleDrivers.values()) d.setLogLevel(level);
    this.extraCoordinator.setLogLevel(level);
  }

  getReconnectAttemptCount(): number {
    return this.reconnectAttemptCount;
  }

  /** Test-only: override the real-driver factory used by probeAndOpen(). */
  __setRealDriverFactory(
    fn: (model: DeviceModel, ov?: DeviceModelOverride) => WorkerHidDriver,
  ): void {
    this.makeRealDriver = fn;
  }

  __resetRealDriverFactory(): void {
    this.makeRealDriver = (model, ov) => new WorkerHidDriver(model, ov);
  }

  /** The user's device tuning for `modelId`, or undefined in safe mode
   *  (`--no-overrides`) / when nothing is persisted. */
  private overrideFor(modelId: string): DeviceModelOverride | undefined {
    // Safe mode (`run --no-overrides`): a bad keyMap can make a device look dead,
    // and the WebUI Reset button is no help if the user can't get that far. Shared
    // with the WebUI's own view, so the panel never claims tuning the device isn't
    // actually running.
    if (overridesDisabled()) return undefined;
    return this.deps.webui.modelOverrideFor(modelId);
  }

  /** Registry model + the user's tuning. Everything downstream (CORA advertise
   *  geometry, input mapping, splash, extras) sees the effective model; the
   *  registry itself is never mutated. */
  private effectiveModel(model: DeviceModel): DeviceModel {
    return applyModelOverrides(model, this.overrideFor(model.id));
  }

  /** Test-only: override the device-presence check used by probeAndOpen(). */
  __setPresenceCheck(fn: (model: DeviceModel) => boolean): void {
    this.isModelPresent = fn;
  }

  /** Test-only: override the extra-dock coordinator's per-model path enumeration. */
  __setListModelPaths(fn: (model: DeviceModel) => string[]): void {
    this.listModelPaths = fn;
  }

  applyDeviceModel(
    registryOrEffective: DeviceModel,
    deviceInfo?: { serial?: string; firmware?: string },
  ): void {
    // Idempotent: callers pass either a bare registry model (WebUI model picker,
    // DEFAULT_MODEL on disconnect) or an already-effective one (probe result).
    const model = this.effectiveModel(registryOrEffective);
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
      onKey: (index, state, wireId) => {
        this.deps.childServer.sendKeyEvent(index, state);
        this.deps.webui.notifyKeyEvent(index, state, wireId);
      },
      onReinit: () => this.primary.repaintWidgets(),
    });
    driver.on('disconnect', () => {
      log('info', model.id, 'disconnected');
      this.primary.onDisconnect(model.id);
      this.currentDriver = null;
      this.realDriver = null;
      this.deps.webui.notifyDriverStatus('real', false);
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

  /** Presence sweep = one synchronous hid_enumerate per model/PID on the main
   *  thread. Timed as a breadcrumb: a slow enumerate is the leading suspect
   *  when startup appears to hang (issue #67.2). */
  private presentModels(): DeviceModel[] {
    const t0 = Date.now();
    const present = DEVICE_MODELS.filter((model) => this.isModelPresent(model));
    log('debug', 'hid', `enumerate took ${Date.now() - t0}ms, ${present.length} model(s) present`);
    return present;
  }

  private async probeAndOpen(): Promise<WorkerHidDriver | null> {
    // Only spawn a worker for a connected device — hid_open on a missing device
    // or terminating a hidapi-loaded worker segfaults on macOS.
    for (const model of this.presentModels()) {
      // Reuse the worker from a prior failed open (present-but-unopenable device,
      // e.g. Input Monitoring denied) — it connects the moment open() succeeds.
      const override = this.overrideFor(model.id);
      const effective = applyModelOverrides(model, override);
      const parked = this.idleDrivers.get(model.id);
      const driver = parked ?? this.makeRealDriver(effective, override);
      if (!parked) this.attachRealDriverListeners(driver, effective);
      try {
        await step('hid', `probe ${model.id} (overrides: ${overrideSummary(override)})`, () =>
          driver.open(),
        );
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
      if (this.probeInFlight) return;
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
      this.primary.resolveIdentity(
        deviceKeyFor(
          hidPath ?? `model:${found.model.id}`,
          serial,
          sharedSerialModelId(found.model),
        ),
      );
      this.applyDeviceModel(found.model, {
        serial: found.deviceSerial ?? serial ?? undefined,
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

  /** Device tuning changed (WebUI / settings import): close the affected
   *  session(s) so the 2 s reconnect tick reopens them with the new spec.
   *  image/wire/keyMap must already be correct at open() and at the first
   *  splash, so a live patch would not do. `modelId` '' means "all models".
   *  No-op in mock mode beyond a model re-apply — there is no worker to reopen. */
  async reloadDeviceTuning(modelId: string): Promise<void> {
    if (this.driverMode === 'mock') {
      const current = this.currentDriver;
      if (current) await this.connectMock(current.model);
      return;
    }
    await this.extraCoordinator.reloadDeviceTuning(modelId);
    const driver = this.realDriver;
    if (!driver || (modelId && driver.model.id !== modelId)) return;
    log('info', 'driverMgr', `reopening ${driver.model.id} to apply device tuning`);
    this.currentDriver = null;
    this.realDriver = null;
    this.deps.webui.notifyDriverStatus('real', false);
    await closeDriver(driver);
    // The disconnect handler is detached by closeDriver, so schedule explicitly.
    this.scheduleReconnect();
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
    // Effective, so device tuning is previewable in mock mode without hardware.
    const m = this.effectiveModel(model ?? DEFAULT_MODEL);
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

  // Multi-device (extra docks): thin delegation to ExtraDockCoordinator

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
