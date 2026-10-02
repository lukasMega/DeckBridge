import { EventEmitter } from 'node:events';
import { log, step } from '../shared/logger.js';
import { overridesDisabled } from '../shared/cli.js';
import { closeDriver } from '../worker/hid-worker-host.js';
import type { WorkerHidDriver } from '../worker/hid-worker-host.js';
import { ELGATO_CHILD_PORT, ELGATO_TCP_PORT, MAX_MULTI_DECK_DOCKS } from '../shared/types.js';
import type { DockStatus } from '../shared/types.js';
import type { DockDriver, DeviceModel, DeviceModelOverride } from '../devices/driver.js';
import { applyModelOverrides, overrideSummary } from '../devices/model-overrides.js';
import type { OverrideChangeKind } from '../devices/model-overrides.js';
import {
  advertisedGeometry,
  DEVICE_MODELS,
  DEFAULT_MODEL,
  findModelById,
} from '../devices/registry.js';
import { Dock } from './dock.js';
import type { DockHooks } from './dock.js';
import { ProbePacer } from './driver-manager-pacing.js';
import { DockScanner } from './dock-scanner.js';
import {
  elgatoHardwarePresent,
  nativeHidDiscovery,
  resolveRealDeviceIdentity,
  type HidDiscovery,
} from './driver-manager-discovery.js';
import { WorkerPool } from './worker-pool.js';
import { begin, settleAll } from './settle.js';
import {
  getInitialDriverMode,
  type DriverManagerDeps,
  type DriverMode,
} from './driver-manager-deps.js';

/** Mode switch proceeds past a failed teardown; shutdown is where failures are fatal. */
const logCleanupFailure = (e: unknown): void =>
  log('warn', 'driverMgr', `cleanup failed: ${e instanceof Error ? e.message : String(e)}`);

/** Emits one `'changed'` event whenever dock statuses, the tray state or the probe
 *  state may have changed; app.ts refreshes the WebUI dock list and the tray from it. */
export class DriverManager extends EventEmitter {
  private readonly deps: DriverManagerDeps;

  /** Real USB or the mock; the driver itself is dock 0's (`primary.driver`). */
  private mode: DriverMode = getInitialDriverMode();
  private imagesSent = 0;

  /** Probe interval + reconnect/in-flight state (driver-manager-pacing.ts). */
  private readonly pacer = new ProbePacer();

  /** USB enumeration off the main thread (driver-manager-discovery.ts). */
  private readonly discovery: HidDiscovery;

  /** Parked workers of failed opens, shared with the dock scan (worker-pool.ts). */
  private readonly pool: WorkerPool;

  /** Every live dock by index. Dock 0 is the one whose CORA servers live for the
   *  process (drivers attach/detach across replugs); 1.. come and go with their unit. */
  private readonly docks = new Map<number, Dock>();

  /** Dock 0 — the probe/reconnect lifecycle below attaches its drivers. */
  private readonly primary: Dock;

  /** Docks 1..N (multi-deck); deps are closures over this instance's state. */
  private readonly scanner: DockScanner;

  /** The running probe (tryRealConnect), so shutdown can wait for it to settle. */
  private probeTask: Promise<unknown> | null = null;
  private shutdownTask: Promise<void> | null = null;

  declare connectMock: (model?: DeviceModel) => Promise<void>;
  declare switchMode: (newMode: DriverMode) => Promise<void>;

  constructor(deps: DriverManagerDeps) {
    super();
    this.deps = deps;
    this.discovery = deps.discovery ?? nativeHidDiscovery();
    this.pool = deps.pool ?? new WorkerPool();
    const { webui } = deps;
    this.primary = new Dock({
      index: 0,
      cora: deps.cora,
      ports: { primary: ELGATO_TCP_PORT, child: ELGATO_CHILD_PORT },
      settings: deps.settings,
      getShuttingDown: deps.getShuttingDown,
      // The process-lifetime dock also feeds the key activity feed, the brightness
      // slider and the image counter; its disconnect starts the reconnect probe.
      hooks: {
        ...this.dockHooks(0),
        disconnect: () => this.onPrimaryDisconnect(),
        key: (index, state, wireId) => webui.notifyKeyEvent(index, state, wireId),
        brightness: (level) => webui.notifyBrightness(level),
        imageSent: () => webui.notifyStats({ imagesSent: ++this.imagesSent }),
      },
    });
    this.docks.set(0, this.primary);
    this.scanner = new DockScanner({
      docks: this.docks,
      getShuttingDown: deps.getShuttingDown,
      getDriverMode: () => this.mode,
      isProbeInFlight: () => this.pacer.probing,
      coraDockFactory: deps.coraDockFactory ?? null,
      getRealDriver: () => (this.mode === 'real' ? this.primary.driver : null),
      discovery: this.discovery,
      pool: this.pool,
      effectiveModelFor: (model) => ({
        model: this.effectiveModel(model),
        override: this.overrideFor(model.id),
      }),
      settings: deps.settings,
      dockHooks: (index) => this.dockHooks(index),
      onChanged: () => this.changed(),
      onDockConnected: (index, deviceKey) => this.deps.onDockConnected?.(index, deviceKey),
    });
    if (__MOCK_BUILD__) {
      this.connectMock = async (model?: DeviceModel): Promise<void> => {
        // Effective, so device tuning is previewable without hardware.
        const m = this.effectiveModel(model ?? DEFAULT_MODEL);
        const prev = this.mode === 'mock' ? this.primary.detach() : null;
        if (prev) await closeDriver(prev);
        const { MockDriver } = await import('../devices/mock.js');
        const driver = new MockDriver(m);
        await driver.open();
        this.primary.resolveIdentity(`mock:${m.id}`);
        this.applyDeviceModel(m);
        this.primary.attach(driver, true);
        log('info', 'driverMgr', `mock driver active (${m.name})`);
        this.deps.webui.notifyDriverStatus('mock', true);
      };
      this.switchMode = async (newMode: DriverMode): Promise<void> => {
        if (newMode === this.mode && this.primary.driver !== null) return;
        log('info', 'driverMgr', `switching driver → ${newMode}`);
        this.pacer.started();
        const prev = this.primary.detach();
        if (prev) await closeDriver(prev);
        await this.pool.closeAll().catch(logCleanupFailure);
        await this.stopScannedDocks().catch(logCleanupFailure);
        this.mode = newMode;
        if (newMode === 'mock') {
          await this.connectMock();
        } else {
          this.deps.webui.notifyDriverStatus('real', false);
          void this.tryRealConnect();
        }
        this.changed();
      };
    }
  }

  private changed(): void {
    this.emit('changed');
  }

  /** The same hooks `dockHooks` gives scanned docks, for a dock built outside the manager. */
  hooksForDock(index: number): DockHooks {
    return this.dockHooks(index);
  }

  /** Register a dock that is not backed by a scanned USB unit (the browser deck). The index
   *  is reserved first so a scan can never take it. Not touched by switchMode or
   *  stopScannedDocks. */
  addExternalDock(dock: Dock): void {
    if (this.docks.has(dock.index)) throw new Error(`dock index ${dock.index} is in use`);
    this.scanner.reserveIndex(dock.index);
    this.docks.set(dock.index, dock);
    this.changed();
  }

  removeExternalDock(index: number): void {
    if (index === 0 || !this.docks.delete(index)) return;
    this.scanner.unreserveIndex(index);
    this.changed();
  }

  /** Status + WebUI mirror hooks every dock gets, tagged with its index. */
  private dockHooks(index: number): DockHooks {
    const { webui } = this.deps;
    return {
      changed: () => this.changed(),
      action: (message) => webui.notifyDeviceAction(index, message),
      // No copy: `data` is immutable-by-convention (see dock-frames.ts).
      image: (key, data, format) => webui.notifyDockImage(index, key, data, format),
      touchImage: (data, region) => webui.imageChannel.notifyDockTouchImage(index, data, region),
      widgetPaint: (wireId, paint) =>
        webui.imageChannel.notifyDockWidgetPaint(index, wireId, paint),
      stripWrite: (...args) => webui.imageChannel.notifyDockStripWrite(index, ...args),
      elgatoAttached: () => this.deps.onElgatoAttached?.(index),
    };
  }

  /** Full HID inventory via the scan worker, for the WebUI diagnostics report. */
  hidInventory(): ReturnType<HidDiscovery['inventory']> {
    return this.discovery.inventory();
  }

  getCurrentDriver(): DockDriver | null {
    return this.primary.driver;
  }

  /** Click-to-press: false when the dock is gone, the index is out of range or a press is pending. */
  simulateKeyPress(dockIndex: number, mk2Index: number): boolean {
    return this.docks.get(dockIndex)?.simulateKeyPress(mk2Index) ?? false;
  }

  /** The live dock at `index` (0 is always present). */
  dock(index: number): Dock | undefined {
    return this.docks.get(index);
  }

  /** A pushed channel changed: every dock paints what changed (unbound keys cost a compare). */
  paintChangedWidgets(): void {
    for (const dock of this.docks.values()) dock.paintChangedWidgets();
  }

  /** A settings import may change any dock's standby settings. */
  reloadAllStandby(): void {
    for (const dock of this.docks.values()) dock.reloadStandby();
  }

  /** The live dock serving `deviceKey`, if any. */
  dockForDevice(deviceKey: string): Dock | undefined {
    for (const dock of this.docks.values()) if (dock.identity?.deviceKey === deviceKey) return dock;
    return undefined;
  }

  getDriverMode(): DriverMode {
    return this.mode;
  }

  /** Push a log-level change to live USB workers; new ones read DECKBRIDGE_LOG_LEVEL. */
  setLogLevel(level: string): void {
    this.primary.driver?.setLogLevel(level);
    this.pool.setLogLevel(level);
    this.scanner.setLogLevel(level);
  }

  getReconnectAttemptCount(): number {
    return this.pacer.attempts;
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
    this.primary.setModel(model, deviceInfo);
    const geo = advertisedGeometry(model);
    this.deps.webui.notifyDeviceModel({
      id: model.id,
      name: model.name,
      keyCount: geo.keyCount,
      columns: geo.columns,
      rows: geo.rows,
    });
    this.changed();
  }

  private scheduleReconnect(): void {
    this.pacer.schedule(() => {
      this.tryRealConnect().catch((e: unknown) =>
        log('error', 'hid', `scheduled reconnect failed: ${(e as Error).message}`),
      );
    });
  }

  /** Test-only: current probe interval (see driver-manager-pacing.ts). */
  __reconnectDelayMs(): number {
    return this.pacer.delayMs;
  }

  /** The primary's USB unit went away: keep the dock (and its frames), probe again. */
  private onPrimaryDisconnect(): void {
    // Re-init native HID stack before next probe: without it a replug of the
    // same unit can stay invisible to enumeration for the rest of the process.
    this.discovery.requestReset();
    this.primary.detach();
    this.deps.webui.notifyDriverStatus('real', false);
    this.applyDeviceModel(DEFAULT_MODEL);
    if (this.mode === 'real') this.scheduleReconnect();
    this.changed();
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
      if (!hidPath) {
        log('warn', 'hid', `${model.id} has no usage-matched HID path`);
        continue;
      }
      // Listeners are wired by Dock.attach after a good open.
      const { driver } = this.pool.acquire(effective, override);
      try {
        await step('hid', `probe ${model.id} (overrides: ${overrideSummary(override)})`, () =>
          driver.open(hidPath),
        );
        return driver;
      } catch (e) {
        log('debug', 'hid', `${model.id} open failed: ${(e as Error).message}`);
        if (this.shutdownTask || this.deps.getShuttingDown()) {
          await closeDriver(driver);
          continue;
        }
        // Keep worker alive, listeners intact, for next retry.
        this.pool.park(model.id, driver);
      }
    }
    return null;
  }

  async tryRealConnect(): Promise<void> {
    this.pacer.started();
    if (this.deps.getShuttingDown() || this.mode !== 'real' || this.primary.driver) return;

    // null: already probing, no device found, or dock torn down across await.
    // Each case did its own notify/schedule work inside acquireRealDriver.
    const task = this.acquireRealDriver();
    this.probeTask = task;
    const driver = await task;
    if (!driver) return;
    if (this.deps.getShuttingDown()) {
      await closeDriver(driver);
      return;
    }

    this.pacer.connected();
    log('info', 'hid', `connected: ${driver.model.name}`);
    this.primary.attach(driver);
    this.deps.webui.notifyDriverStatus('real', true);
    this.deps.onDockConnected?.(0, this.primary.identity?.deviceKey ?? '');
    this.changed();
  }

  /** Probe + open + identity resolution. Returns installed driver, or null when
   * the caller must not proceed to activation. */
  private async acquireRealDriver(): Promise<WorkerHidDriver | null> {
    if (this.pacer.probing) return null;
    this.pacer.probing = true;
    let found: WorkerHidDriver | null = null;
    try {
      log('info', 'hid', 'probing USB devices...');
      found = await this.probeAndOpen();
    } finally {
      this.pacer.probing = false;
    }

    // Re-check after the await: switchMode()/shutdown during the awaited probe
    // (the E1-a race) must not install a leaked worker.
    if (this.deps.getShuttingDown() || this.mode !== 'real') {
      if (found) await closeDriver(found);
      return null;
    }

    if (!found) {
      log('warn', 'hid', `no device found — retrying in ${this.pacer.delayMs / 1000}s`);
      this.deps.webui.notifyElgatoDevicePresent(elgatoHardwarePresent(this.discovery));
      this.scheduleReconnect();
      this.changed();
      return null;
    }
    this.deps.webui.notifyElgatoDevicePresent(false);
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

  /** Device tuning changed (WebUI / settings import). `modelId` '' means every
   *  model; `kind` comes from classifyOverrideChange: an image-only change is
   *  swapped into every live dock (no status flap), anything else reopens. */
  async reloadDeviceTuning(modelId: string, kind: OverrideChangeKind = 'reopen'): Promise<void> {
    if (kind === 'none') return;
    if (kind === 'live') {
      for (const dock of this.docks.values()) {
        dock.applyTuning(modelId, (id) => this.overrideFor(id));
      }
      return;
    }
    if (__MOCK_BUILD__ && this.mode === 'mock') {
      // Registry entry, not driver.model: connectMock re-merges the override, and
      // re-merging over an already merged model would keep a value just cleared.
      const model = this.primary.driver && findModelById(this.primary.driver.model.id);
      if (model) await this.connectMock(model);
      return;
    }
    await this.scanner.reloadDeviceTuning(modelId);
    const driver = this.primary.driver;
    if (!driver || (modelId && driver.model.id !== modelId)) return;
    log('info', 'driverMgr', `reopening ${driver.model.id} to apply device tuning`);
    // Close the dock's driver so the reconnect tick reopens it with the new spec.
    this.primary.detach();
    this.deps.webui.notifyDriverStatus('real', false);
    await closeDriver(driver);
    // The disconnect handler is detached by closeDriver, so schedule explicitly.
    this.scheduleReconnect();
    this.changed();
  }

  // Multi-device (scanned docks): thin delegation to DockScanner

  /** Multi-deck opt-in: off (the default) = one dock, no USB scanning once up;
   * switching it off tears down a live second dock. `cap` is a test seam. */
  setMultiDeck(enabled: boolean, cap: number = MAX_MULTI_DECK_DOCKS): Promise<void> {
    return this.scanner.setMaxDocks(enabled ? cap : 1);
  }

  /** Begin polling for scanned docks. Idempotent; no-op until multi-deck is on. */
  startScan(): void {
    this.scanner.startScan();
  }

  stopScan(): void {
    this.scanner.stopScan();
  }

  /** Test-only seam: run one dock-scan pass without the timer. */
  async __scanOnce(): Promise<void> {
    await this.scanner.scanOnce();
  }

  /** Tear down every scanned dock and reset the index pool (switchMode, shutdown). */
  async stopScannedDocks(): Promise<void> {
    await this.scanner.stopScannedDocks();
  }

  /** Application shutdown, idempotent: no new probes or scans, every dock stopped
   *  (widgets, commands, driver, CORA pair + mDNS), then the parked workers closed.
   *  Pending probes/creations settle first so nothing registers after this. */
  shutdown(): Promise<void> {
    this.shutdownTask ??= this.runShutdown();
    return this.shutdownTask;
  }

  private async runShutdown(): Promise<void> {
    this.stopScan();
    this.pacer.cancel();
    // Settles a probe/scan blocked on enumeration so its owner can see the shutdown.
    this.discovery.dispose?.();
    // Every owner starts closing now; a stalled secondary open (awaited inside the
    // scanner stop) or probe must not hold the primary dock or the parked workers.
    await settleAll('driver manager shutdown', [
      begin(() => this.primary.stop()),
      begin(() => this.scanner.stopScannedDocks()),
      begin(() => this.pool.closeAll()),
      begin(async () => {
        await this.probeTask?.catch(() => undefined);
        // A probe that settled late closes its own worker (see probeAndOpen); this
        // sweeps anything parked in the meantime.
        await this.pool.closeAll();
      }),
    ]);
  }

  /** Status of every dock with a driver attached, sorted by index. */
  getDockStatuses(): DockStatus[] {
    return [...this.docks.values()]
      .filter((dock) => dock.driver !== null)
      .map((dock) => dock.status())
      .toSorted((a, b) => a.index - b.index);
  }
}
