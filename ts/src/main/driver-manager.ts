import { log, step } from '../shared/logger.js';
import { overridesDisabled } from '../shared/cli.js';
import { closeDriver } from '../worker/hid-worker-host.js';
import type { WorkerHidDriver } from '../worker/hid-worker-host.js';
import { MockDriver } from '../devices/mock.js';
import { wireMockDriver } from './driver-manager-mock.js';
import { MAX_MULTI_DECK_SESSIONS } from '../shared/types.js';
import type { DockStatus, DialEvent, TouchStripMode } from '../shared/types.js';
import type { DeviceDriver, DeviceModel, DeviceModelOverride } from '../devices/driver.js';
import { applyModelOverrides, overrideSummary } from '../devices/model-overrides.js';
import type { OverrideChangeKind } from '../devices/model-overrides.js';
import type { DockPrefs } from '../infra/dock-prefs.js';
import { advertisedGeometry, DEVICE_MODELS, DEFAULT_MODEL } from '../devices/registry.js';
import { sendSplashImages } from '../shared/splash-sender.js';
import { applyModelToServers, wireCommonDriverEvents } from './device-session.js';
import { PrimaryDock } from './driver-manager-primary.js';
import { applyTuningChange } from './driver-manager-tuning.js';
import { ProbePacer } from './driver-manager-pacing.js';
import { ExtraDockCoordinator } from './driver-manager-extras.js';
import {
  elgatoHardwarePresent,
  nativeHidDiscovery,
  resolveRealDeviceIdentity,
  type HidDiscovery,
} from './driver-manager-discovery.js';
import { WorkerPool } from './worker-pool.js';
import {
  getInitialDriverMode,
  type DriverManagerDeps,
  type DriverMode,
} from './driver-manager-deps.js';

export class DriverManager {
  private readonly deps: DriverManagerDeps;

  private driverMode: DriverMode = getInitialDriverMode();
  private currentDriver: DeviceDriver | null = null;
  private realDriver: WorkerHidDriver | null = null;
  private reconnecting = false;
  private reconnectAttemptCount = 0;
  private probeInFlight = false;
  private imagesSent = 0;

  /** Probe interval, adapted to how slow HID enumeration is (driver-manager-pacing.ts). */
  private readonly pacer = new ProbePacer();

  /** USB enumeration off the main thread (driver-manager-discovery.ts). */
  private readonly discovery: HidDiscovery;

  /** Parked workers of failed opens, shared with the extras (worker-pool.ts). */
  private readonly pool: WorkerPool;

  /** Primary dock (index 0) state: identity, brightness, widgets, saved-frame replay. */
  private readonly primary: PrimaryDock;

  /** Multi-device coordinator (extras only); deps are closures over this instance's state. */
  private readonly extraCoordinator: ExtraDockCoordinator;

  constructor(deps: DriverManagerDeps) {
    this.deps = deps;
    this.discovery = deps.discovery ?? nativeHidDiscovery();
    this.pool = deps.pool ?? new WorkerPool();
    this.primary = new PrimaryDock(deps);
    this.extraCoordinator = new ExtraDockCoordinator({
      getShuttingDown: deps.getShuttingDown,
      getDriverMode: () => this.driverMode,
      isProbeInFlight: () => this.probeInFlight,
      sessionServersFactory: deps.sessionServersFactory ?? null,
      getRealDriver: () => this.realDriver,
      discovery: this.discovery,
      pool: this.pool,
      effectiveModelFor: (model) => ({
        model: this.effectiveModel(model),
        override: this.overrideFor(model.id),
      }),
      settings: deps.settings,
      onSessionsChanged: () => this.deps.onDocksChanged?.(),
      // No copy: `data` is immutable-by-convention here, same as the primary-dock mirror in image-pipeline.ts.
      onImage: (dockIndex, keyIndex, data, format) =>
        deps.webui.notifyDockImage(dockIndex, keyIndex, data, format),
      onAction: (index, message) => deps.webui.notifyDeviceAction(index, message),
      onTouchImage: (...args) => deps.webui.imageChannel.notifyDockTouchImage(...args),
      onWidgetPaint: (...args) => deps.webui.imageChannel.notifyDockWidgetPaint(...args),
      onStripWrite: (...args) => deps.webui.imageChannel.notifyDockStripWrite(...args),
      dockFramesSnapshot: (dockIndex) => deps.webui.dockFramesSnapshot(dockIndex),
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

  /** Live per-device prefs of the primary dock (runtime fallback before its identity). */
  primaryPrefs(): DockPrefs {
    return this.deps.settings.for(this.primary.identity?.deviceKey ?? '');
  }

  getDriverMode(): DriverMode {
    return this.driverMode;
  }

  /** Push a log-level change to live USB workers; new ones read DECKBRIDGE_LOG_LEVEL. */
  setLogLevel(level: string): void {
    this.realDriver?.setLogLevel(level);
    this.pool.setLogLevel(level);
    this.extraCoordinator.setLogLevel(level);
  }

  getReconnectAttemptCount(): number {
    return this.reconnectAttemptCount;
  }

  /** User tuning for `modelId`, undefined in safe mode (`--no-overrides`)/when unset. Shared with the WebUI view. */
  private overrideFor(modelId: string): DeviceModelOverride | undefined {
    if (overridesDisabled()) return undefined;
    return this.deps.settings.overrideFor(modelId);
  }

  /** Model + user tuning; downstream sees the effective model, registry never mutated. */
  private effectiveModel(model: DeviceModel): DeviceModel {
    return applyModelOverrides(model, this.overrideFor(model.id));
  }

  applyDeviceModel(
    registryOrEffective: DeviceModel,
    deviceInfo?: { serial?: string; firmware?: string },
  ): void {
    // Proxy model through user tuning so callers don't need to.
    const model = this.effectiveModel(registryOrEffective);
    this.deps.webui.resetImages();
    this.primary.model = model;
    this.primary.deviceInfo = deviceInfo;
    // Server-facing push shared with extras (device-session.ts); the WebUI half is primary-only.
    applyModelToServers(this.deps.server, this.deps.childServer, model, deviceInfo);
    const geo = advertisedGeometry(model);
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
    }, this.pacer.delayMs);
  }

  /** Test-only: current probe interval (see driver-manager-pacing.ts). */
  __reconnectDelayMs(): number {
    return this.pacer.delayMs;
  }

  /** Wire a fresh real driver once; reused idle drivers keep their listeners. */
  private attachRealDriverListeners(driver: WorkerHidDriver, model: DeviceModel): void {
    driver.on('imageSent', () => this.deps.webui.notifyStats({ imagesSent: ++this.imagesSent }));
    wireCommonDriverEvents(driver, model, {
      onAction: (message) => this.deps.webui.notifyDeviceAction(0, message),
      onKey: (index, state, wireId) => {
        this.deps.childServer.sendKeyEvent(index, state);
        this.deps.webui.notifyKeyEvent(index, state, wireId);
      },
      onExtraKey: (wireId, state) => this.primary.handleExtraKey(wireId, state),
      onDial: (event: DialEvent) => {
        if (!this.primary.handleDial(event)) this.deps.childServer.sendDial(event);
      },
      onTouch: (e) => this.primary.handleTouch(e) || this.deps.childServer.sendTouch(e),
      onReinit: () => this.primary.repaintWidgets(),
      onStripWrite: (...args) => this.deps.webui.imageChannel.notifyDockStripWrite(0, ...args),
    });
    driver.on('disconnect', () => {
      log('info', model.id, 'disconnected');
      // Re-init native HID stack before next probe: without it a replug of the
      // same unit can stay invisible to enumeration for the rest of the process.
      this.discovery.requestReset();
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

  /** Enumerate supported devices in dedicated worker. Duration feeds the
   * pacer; even a stalled scan cannot starve CORA/WebUI work (issue #67.2). */
  private async presentModels(): Promise<DeviceModel[]> {
    const took = await this.discovery.scan();
    const present = DEVICE_MODELS.filter((model) => this.discovery.present(model));
    log('debug', 'hid', `enumerate took ${took}ms, ${present.length} model(s) present`);
    this.pacer.note(took);
    return present;
  }

  private async probeAndOpen(): Promise<WorkerHidDriver | null> {
    /** Probe presence then open. Skip absent devices — hid_open on missing device
     * or terminating a hidapi-loaded worker segfaults on macOS. */
    for (const model of await this.presentModels()) {
      // Reuse the worker from a prior failed open (present-but-unopenable device,
      // e.g. Input Monitoring denied) — it connects the moment open() succeeds.
      const override = this.overrideFor(model.id);
      const effective = applyModelOverrides(model, override);
      const hidPath = this.discovery.paths(effective)[0];
      if (!hidPath && this.discovery.requireTargetedPath) {
        log('warn', 'hid', `${model.id} has no usage-matched HID path`);
        continue;
      }
      const { driver, fresh } = this.pool.acquire(effective, override);
      if (fresh) this.attachRealDriverListeners(driver, effective);
      try {
        await step('hid', `probe ${model.id} (overrides: ${overrideSummary(override)})`, () =>
          driver.open(hidPath),
        );
        return driver;
      } catch (e) {
        log('debug', 'hid', `${model.id} open failed: ${(e as Error).message}`);
        // Keep worker alive, listeners intact, for next retry.
        this.pool.park(model.id, driver);
      }
    }
    return null;
  }

  async tryRealConnect(): Promise<void> {
    this.reconnecting = false;
    if (this.deps.getShuttingDown() || this.driverMode !== 'real') return;

    // null: already probing, no device found, or session torn down across await.
    // Each case did its own notify/schedule work inside acquireRealDriver.
    const driver = this.realDriver ?? (await this.acquireRealDriver());
    if (!driver) return;

    this.reconnectAttemptCount = 0;
    log('info', 'hid', `connected: ${driver.model.name}`);
    this.currentDriver = driver;
    this.primary.seedFromIdentity(driver);
    this.deps.webui.notifyDriverStatus('real', true);
    this.deps.onTrayChange();
    sendSplashImages(driver);
    this.primary.repaintFromSavedFrames(driver);
    this.primary.startWidgets(driver);
    this.deps.onDocksChanged?.();
  }

  /** Probe + open + identity resolution. Returns installed driver, or null when
   * the caller must not proceed to activation. */
  private async acquireRealDriver(): Promise<WorkerHidDriver | null> {
    if (this.probeInFlight) return null;
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
    if (this.deps.getShuttingDown() || this.driverMode !== 'real') {
      if (found) await closeDriver(found);
      return null;
    }

    if (!found) {
      log('warn', 'hid', `no device found — retrying in ${this.pacer.delayMs / 1000}s`);
      this.deps.webui.notifyElgatoDevicePresent(elgatoHardwarePresent(this.discovery));
      this.scheduleReconnect();
      this.deps.onTrayChange();
      return null;
    }
    this.deps.webui.notifyElgatoDevicePresent(false);
    this.realDriver = found;
    const { deviceKey, serial } = resolveRealDeviceIdentity(
      this.discovery,
      found.hidPath,
      found.model,
    );
    this.primary.resolveIdentity(deviceKey);
    this.applyDeviceModel(found.model, {
      serial: found.deviceSerial ?? serial ?? undefined,
      firmware: found.deviceFirmware,
    });
    return found;
  }

  /** Device tuning changed (WebUI / settings import) — driver-manager-tuning.ts
   *  decides live-swap vs reopen; this class owns the reopen lifecycle. */
  async reloadDeviceTuning(modelId: string, kind: OverrideChangeKind = 'reopen'): Promise<void> {
    await applyTuningChange(
      {
        primary: this.primary,
        extras: this.extraCoordinator,
        driverMode: this.driverMode,
        currentDriver: this.currentDriver,
        realDriver: this.realDriver,
        overrideFor: (id) => this.overrideFor(id),
        connectMock: (model) => this.connectMock(model),
        // Close the session so the reconnect tick reopens it with the new spec.
        reopenSession: async (driver) => {
          this.currentDriver = null;
          this.realDriver = null;
          this.deps.webui.notifyDriverStatus('real', false);
          await closeDriver(driver);
          // The disconnect handler is detached by closeDriver, so schedule explicitly.
          this.scheduleReconnect();
          this.deps.onDocksChanged?.();
        },
      },
      modelId,
      kind,
    );
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

  /** WebUI touch-strip mode selector — who paints the strip on the dock at `index`. */
  setTouchStripModeForDock(index: number, mode: TouchStripMode): void {
    if (index === 0) this.primary.setTouchStripMode(mode);
    else this.extraCoordinator.setTouchStripMode(index, mode);
  }

  async connectMock(model?: DeviceModel): Promise<void> {
    // Effective, so device tuning is previewable in mock mode without hardware.
    const m = this.effectiveModel(model ?? DEFAULT_MODEL);
    if (this.currentDriver && this.driverMode === 'mock') {
      const prev = this.currentDriver;
      this.currentDriver = null;
      this.primary.stopWidgets();
      await closeDriver(prev);
    }
    const driver = new MockDriver(m);
    await driver.open();
    this.currentDriver = driver;
    // A stable per-model key, so per-device prefs (side keys, knobs, brightness)
    // work without hardware; settings persist under whichever --cache-dir is used.
    this.primary.resolveIdentity(`mock:${m.id}`);
    this.applyDeviceModel(m);
    wireMockDriver(driver, {
      primary: this.primary,
      childServer: this.deps.childServer,
      webui: this.deps.webui,
    });
    this.primary.seedFromIdentity(driver);
    this.primary.startWidgets(driver);
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
    await this.pool.closeAll();
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

  /** Multi-deck opt-in: off (the default) = one dock, no USB scanning once up;
   * switching it off tears down a live second dock. `cap` is a test seam. */
  setMultiDeck(enabled: boolean, cap: number = MAX_MULTI_DECK_SESSIONS): Promise<void> {
    return this.extraCoordinator.setMaxDocks(enabled ? cap : 1);
  }

  /** Begin polling for extra docks. Idempotent; no-op until multi-deck is on. */
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
