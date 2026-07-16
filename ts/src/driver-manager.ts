import { log } from './logger.js';
import type { LogLevel } from './logger.js';
import { hidDevicePresent, hidSerialForPath, listHidPaths } from './ffi/hidapi.js';
import { WorkerHidDriver, closeDriver } from './hid-worker-host.js';
import { MockDriver } from './devices/mock.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';
import type { WebUIServer } from './web/server';
import type { DeviceDriver, DeviceModel } from './devices/driver.js';
import type { KeyEvent, CommEntry, DockStatus } from './types.js';
import {
  RECONNECT_DELAY_MS,
  DEFAULT_BRIGHTNESS,
  DEFAULT_MAC_ADDRESS,
  MDNS_SERVICE_NAME,
} from './types.js';
import { DEVICE_MODELS, DEFAULT_MODEL } from './devices/registry.js';
import { deviceInputToMk2Index } from './translator.js';
import { sendSplashImages } from './splash-sender.js';
import { ExtraKeyWidgets } from './extra-keys.js';
import { modelToChildGeometry } from './capabilities.js';
import {
  applyModelToServers,
  buildPrimaryDockStatus,
  type SessionServersFactory,
} from './device-session.js';
import { ExtraDockCoordinator } from './driver-manager-extras.js';
import { deviceKeyFor } from './device-identity.js';
import type { DeviceIdentitySettings } from './settings-store.js';

export type DriverMode = 'real' | 'mock';

/** The driver mode a fresh DriverManager starts in, based on DECKBRIDGE_MOCK env var. */
export function getInitialDriverMode(): DriverMode {
  return tjs.env['DECKBRIDGE_MOCK'] === '1' ? 'mock' : 'real';
}

/** Default device-presence check: any of the model's PIDs enumerated on USB.
 *  Enumeration only (deckbridge-native) — never hid_open. See isModelPresent. */
const defaultPresenceCheck = (model: DeviceModel): boolean =>
  model.usbProductIds.some((pid) => hidDevicePresent(model.usbVendorId, pid));

/** Default per-model path enumeration: every connected HID interface matching
 *  the model's VID + usagePage/usage, across each of its PIDs. Used by the extra-
 *  dock coordinator to open each physical unit of a model separately. Returns []
 *  for models without a usagePage/usage (can't be safely path-targeted). */
const defaultListModelPaths = (model: DeviceModel): string[] => {
  if (model.usagePage === undefined || model.usage === undefined) return [];
  const paths: string[] = [];
  for (const pid of model.usbProductIds) {
    for (const path of listHidPaths(model.usbVendorId, model.usagePage, model.usage, pid)) {
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
};

export interface DriverManagerDeps {
  webui: WebUIServer;
  server: ElgatoServer;
  childServer: ElgatoChildServer;
  onTrayChange: () => void;
  getShuttingDown: () => boolean;
  // Multi-device: builds the CORA server pair for an extra dock. Absent (e.g.
  // tests without multi-device, or before app.ts wires it) disables extras —
  // scanExtras() is a no-op. Decoupled as a factory so DriverManager compiles
  // against the current ElgatoServer API; app.ts supplies the real one.
  sessionServersFactory?: SessionServersFactory;
  /** Called whenever any dock's status() shape may have changed — the primary
   *  connecting/disconnecting or switching model, or an extra dock's set/status
   *  changing (forwarded from ExtraDockCoordinator). Opaque to DriverManager's
   *  callers: the WebUI uses it to push getDockStatuses() to clients. */
  onDocksChanged?: () => void;
}

export class DriverManager {
  private readonly webui: WebUIServer;
  private readonly server: ElgatoServer;
  private readonly childServer: ElgatoChildServer;
  private readonly onTrayChange: () => void;
  private readonly getShuttingDown: () => boolean;
  private readonly sessionServersFactory: SessionServersFactory | null;
  private readonly onDocksChanged?: () => void;

  private driverMode: DriverMode = getInitialDriverMode();
  private currentDriver: DeviceDriver | null = null;
  private currentModel: DeviceModel = DEFAULT_MODEL;
  private primaryBrightness = DEFAULT_BRIGHTNESS;
  // Physical serial/firmware from the real driver on connect; getDockStatuses()
  // reports it when model.cora.usePhysicalIdentity, else the DEFAULT_* constants.
  private primaryDeviceInfo: { serial?: string; firmware?: string } | undefined;
  // Primary's stable per-physical-device identity (mac/serials/mdns), resolved
  // on connect via webui.getOrCreateDeviceIdentity — extras' analog is
  // SessionIdentity. Undefined pre-connect → getDockStatuses() uses DEFAULT_*.
  private primaryIdentity: DeviceIdentitySettings | undefined;
  private realDriver: WorkerHidDriver | null = null;
  private reconnecting = false;
  private reconnectAttemptCount = 0;
  private probeInFlight = false;
  private imagesSent = 0;

  // The Elgato app's last CORA frames for the primary, captured on USB
  // disconnect. The app keeps its TCP pairing across a USB replug and never
  // re-pushes, so on reconnect the deck would be stuck on the splash. Replayed
  // over the splash to restore real content. Guarded by model id so a different
  // device plugged in doesn't inherit stale frames. Cleared after replay.
  private savedPrimaryFrames: Map<number, { data: Buffer; format: 'jpeg' | 'bmp' }> | null = null;
  private savedPrimaryModelId: string | null = null;

  // Real-driver workers whose open() failed but whose worker is kept alive for
  // reuse on the next reconnect attempt, keyed by model.id. Reusing the worker
  // avoids the spawn+terminate-per-retry of a hidapi-loaded worker — the macOS
  // SIGBUS hazard for a present-but-unopenable device. Drained on switchMode;
  // the process exits on shutdown so no explicit shutdown drain is needed.
  private idleDrivers = new Map<string, WorkerHidDriver>();

  // Multi-device coordinator (extras only — the primary is the singleton path
  // above). Split out to driver-manager-extras.ts; deps below are closures
  // over this instance's own mutable state so the coordinator always sees the
  // current value without a runtime import cycle.
  private readonly extraCoordinator: ExtraDockCoordinator;

  // Display widgets on the primary's extra keys (293S 6th column — display-
  // only, no switches). Created per connect; config resolves per tick via the
  // webui's persisted per-device settings.
  private primaryWidgets: ExtraKeyWidgets | null = null;

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

  // Extra-dock coordinator's per-model path enumeration. Test seam:
  // __setListModelPaths (tests have no real FFI/hardware).
  private listModelPaths: (model: DeviceModel) => string[] = defaultListModelPaths;

  constructor(deps: DriverManagerDeps) {
    this.webui = deps.webui;
    this.server = deps.server;
    this.childServer = deps.childServer;
    this.onTrayChange = deps.onTrayChange;
    this.getShuttingDown = deps.getShuttingDown;
    this.sessionServersFactory = deps.sessionServersFactory ?? null;
    this.onDocksChanged = deps.onDocksChanged;
    this.extraCoordinator = new ExtraDockCoordinator({
      getShuttingDown: () => this.getShuttingDown(),
      getDriverMode: () => this.driverMode,
      isProbeInFlight: () => this.probeInFlight,
      sessionServersFactory: this.sessionServersFactory,
      getRealDriver: () => this.realDriver,
      listModelPaths: (model) => this.listModelPaths(model),
      makeRealDriver: (model) => this.makeRealDriver(model),
      takeIdleDriver: (modelId) => {
        const d = this.idleDrivers.get(modelId);
        if (d) this.idleDrivers.delete(modelId);
        return d;
      },
      parkIdleDriver: (modelId, driver) => this.idleDrivers.set(modelId, driver),
      getOrCreateDeviceIdentity: (deviceKey, defaultMdnsName) =>
        this.webui.getOrCreateDeviceIdentity(deviceKey, defaultMdnsName),
      onSessionsChanged: () => this.onDocksChanged?.(),
      onImage: (dockIndex, keyIndex, data, format) =>
        this.webui.notifyDockImage(dockIndex, keyIndex, Buffer.from(data), format),
      isBrightnessOverride: (deviceKey) => this.webui.isBrightnessOverride(deviceKey),
      extraKeyConfigFor: (deviceKey, wireId) => this.webui.extraKeyConfigFor(deviceKey, wireId),
    });
  }

  getCurrentDriver(): DeviceDriver | null {
    return this.currentDriver;
  }

  /** Seed the freshly connected primary driver with its persisted per-device
   *  settings (brightness + image-mode override) before the splash, so it boots
   *  at the user's saved values keyed by its stable identity. Only pushes what's
   *  actually persisted — absent = use the device/model default. */
  private seedPrimaryFromIdentity(): void {
    if (!this.currentDriver || !this.primaryIdentity) return;
    if (this.primaryIdentity.brightness !== undefined) {
      this.primaryBrightness = this.primaryIdentity.brightness;
      this.currentDriver.setBrightness(this.primaryBrightness);
    }
    if (this.primaryIdentity.imageModeOverride != null) {
      this.currentDriver.setImageOverride?.(this.primaryIdentity.imageModeOverride);
    }
  }

  /** Driver behind the dock at `index` (0 = primary/currentDriver, 1.. = extra
   *  session), for app.ts's per-dock image-mode apply + repaint. */
  getDriverForDock(index: number): DeviceDriver | null {
    return index === 0 ? this.currentDriver : this.extraCoordinator.getDriverForDock(index);
  }

  /** Apply a brightness level to the dock with this index (0 = primary,
   *  1.. = extras) and record it so getDockStatuses() reflects it. */
  setDockBrightness(index: number, level: number): void {
    if (index === 0) {
      this.primaryBrightness = level;
      this.currentDriver?.setBrightness(level);
      this.onDocksChanged?.();
      return;
    }
    this.extraCoordinator.setDockBrightness(index, level);
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

  /** Test-only: override the extra-dock coordinator's per-model path enumeration. */
  __setListModelPaths(fn: (model: DeviceModel) => string[]): void {
    this.listModelPaths = fn;
  }

  /** Test-only: restore the default (deckbridge-native enumeration) path list. */
  __resetListModelPaths(): void {
    this.listModelPaths = defaultListModelPaths;
  }

  applyDeviceModel(
    model: DeviceModel,
    deviceInfo?: {
      serial?: string;
      firmware?: string;
    },
  ): void {
    this.webui.resetImages();
    this.currentModel = model;
    this.primaryDeviceInfo = deviceInfo;
    // Server-facing PID/geometry/identity push is shared with extra sessions —
    // one implementation in device-session.ts. The primary keeps the WebUI half.
    applyModelToServers(this.server, this.childServer, model, deviceInfo);
    const geo = model.cora.advertiseGeometry ?? modelToChildGeometry(model);
    this.webui.notifyDeviceModel({
      id: model.id,
      name: model.name,
      keyCount: geo.keyCount,
      columns: geo.columns,
      rows: geo.rows,
    });
    this.onDocksChanged?.();
  }

  /** Push the primary's resolved per-device identity (mac + dock serial +
   *  mdns name) to the running CORA server. Unlike extras (identity passed at
   *  ElgatoServer construction via sessionServersFactory), the primary server
   *  is a fixed singleton created before any device connects — its identity
   *  can only change post-construction, via these setters. */
  private applyPrimaryIdentity(identity: DeviceIdentitySettings): void {
    const macParts = identity.macAddress.split(':');
    const macBytes =
      macParts.length === 6 ? macParts.map((p) => parseInt(p, 16)) : [...DEFAULT_MAC_ADDRESS];
    this.server.setDeviceConfig({ serialNumber: identity.dockSerial, macAddress: macBytes });
    this.server.setMdnsServiceName(identity.mdnsServiceName);
  }

  /** Live-rename whichever dock (primary or extra) matches `deviceKey`'s mDNS
   *  advert (WebUI "Device Identity" edit). No-op if no live dock has that key. */
  applyMdnsNameForDeviceKey(deviceKey: string, name: string): boolean {
    if (this.primaryIdentity?.deviceKey === deviceKey) {
      this.primaryIdentity.mdnsServiceName = name;
      this.server.setMdnsServiceName(name);
      this.onDocksChanged?.();
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
        if (mk2 < 0) {
          // Outside the emulated grid (293S 6th column) — display-only keys
          // with no switches; nothing to dispatch.
          return;
        }
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
    // Sleep/wake re-init sent CLE ALL — repaint the extra-key widgets it wiped.
    driver.on('reinit', () => this.primaryWidgets?.repaint());
    driver.on(
      'log',
      ({ level, component, message }: { level: LogLevel; component: string; message: string }) =>
        log(level, component, message),
    );
    driver.on('disconnect', () => {
      log('info', model.id, 'disconnected');
      // Capture the app's last frames before applyDeviceModel wipes the cache —
      // replayed on replug (the app won't re-push over its surviving TCP pair).
      this.savedPrimaryFrames = this.webui.dockFramesSnapshot(0);
      this.savedPrimaryModelId = model.id;
      this.stopPrimaryWidgets();
      this.currentDriver = null;
      this.realDriver = null;
      this.webui.notifyDriverStatus('real', false);
      // Reset to default model when nothing is connected
      this.applyDeviceModel(DEFAULT_MODEL);
      if (this.driverMode === 'real') this.scheduleReconnect();
      this.onTrayChange();
      this.onDocksChanged?.();
    });
  }

  /** True when an Elgato-branded model (MK.2/Mini) is enumerated on USB —
   *  enumeration only, independent of whether hid_open would succeed. Used to
   *  gate the "Elgato app is blocking access" screen so it doesn't fire when
   *  no Elgato hardware is actually present (e.g. a Mirabox is connected, or
   *  nothing is connected, while the Elgato app happens to be running). */
  private elgatoHardwarePresent(): boolean {
    return DEVICE_MODELS.some(
      (model) => model.driverKind === 'elgato-hid' && this.isModelPresent(model),
    );
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
        if (found) await closeDriver(found);
        return;
      }

      if (!found) {
        log('warn', 'hid', `no device found — retrying in ${RECONNECT_DELAY_MS / 1000}s`);
        this.webui.notifyElgatoDevicePresent(this.elgatoHardwarePresent());
        this.scheduleReconnect();
        this.onTrayChange();
        return;
      }
      this.webui.notifyElgatoDevicePresent(false);
      this.realDriver = found;
      // Prefer the stable USB-serial key; fall back to the (volatile) hidPath,
      // or a per-model key when even that is unset (VID/PID-fallback open,
      // off-macOS, no usage-matched path) — same fallback as extras.
      const hidPath = this.realDriver.hidPath;
      const serial = hidPath ? hidSerialForPath(hidPath) : null;
      const deviceKey = deviceKeyFor(hidPath ?? `model:${this.realDriver.model.id}`, serial);
      this.primaryIdentity = this.webui.getOrCreateDeviceIdentity(deviceKey, MDNS_SERVICE_NAME);
      this.applyPrimaryIdentity(this.primaryIdentity);
      this.applyDeviceModel(this.realDriver.model, {
        serial: this.realDriver.deviceSerial,
        firmware: this.realDriver.deviceFirmware,
      });
    }

    this.reconnectAttemptCount = 0;
    log('info', 'hid', `connected: ${this.realDriver.model.name}`);
    this.currentDriver = this.realDriver;
    this.seedPrimaryFromIdentity();
    this.webui.notifyDriverStatus('real', true);
    this.onTrayChange();
    sendSplashImages(this.realDriver);
    this.repaintPrimaryFromSavedFrames();
    this.startPrimaryWidgets();
    this.onDocksChanged?.();
  }

  /** After a USB replug, repaint the deck with the CORA frames the Elgato app
   *  last pushed (captured on disconnect). The app keeps its TCP pairing across
   *  the replug and never re-pushes, so without this the deck stays on the
   *  splash. Only replays when the same model reconnected; also restores the
   *  WebUI preview that applyDeviceModel blanked on reconnect. */
  private repaintPrimaryFromSavedFrames(): void {
    const frames = this.savedPrimaryFrames;
    this.savedPrimaryFrames = null;
    const driver = this.currentDriver;
    if (!frames || !driver || this.savedPrimaryModelId !== driver.model.id) return;
    for (const [key, { data, format }] of frames) {
      driver.renderCoraImage?.(key, data, format);
      this.webui.notifyDockImage(0, key, data, format);
    }
  }

  /** (Re)start the primary's extra-key widget scheduler (paints immediately,
   *  then once a second re-renders and repaints only changed content). No-op
   *  for models without extraKeys or before identity. */
  private startPrimaryWidgets(): void {
    this.stopPrimaryWidgets();
    const driver = this.currentDriver;
    const identity = this.primaryIdentity;
    if (!driver || !identity) return;
    this.primaryWidgets = new ExtraKeyWidgets(driver, (wireId) =>
      this.webui.extraKeyConfigFor(identity.deviceKey, wireId),
    );
    this.primaryWidgets.start();
  }

  private stopPrimaryWidgets(): void {
    this.primaryWidgets?.stop();
    this.primaryWidgets = null;
  }

  /** WebUI extra-key config change for the dock at `index` — repaint its
   *  widgets (the config itself resolves per tick, no re-wire needed). */
  repaintExtraKeysForDock(index: number): void {
    if (index === 0) {
      this.primaryWidgets?.repaint();
      return;
    }
    this.extraCoordinator.repaintExtraKeys(index);
  }

  /** WebUI "Run now" for a command-widget extra key on the dock at `index`. */
  forceRunExtraKey(index: number, wireId: number): void {
    if (index === 0) {
      this.primaryWidgets?.forceRun(wireId);
      return;
    }
    this.extraCoordinator.forceRunExtraKey(index, wireId);
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
    this.stopPrimaryWidgets();
    const prevCurrent = this.currentDriver;
    const prevReal = this.realDriver;
    this.currentDriver = null;
    this.realDriver = null;
    if (prevReal && prevReal !== prevCurrent) await closeDriver(prevReal);
    if (prevCurrent) await closeDriver(prevCurrent);
    // Drain idle real-driver workers kept alive for reconnect retries (present-
    // but-unopenable devices). One-off terminate per worker, off the hot retry
    // loop — safe, and prevents leaking worker threads when switching to mock.
    for (const d of this.idleDrivers.values()) await closeDriver(d);
    this.idleDrivers.clear();
    // Extra docks are real-mode only — tear them all down across a mode switch.
    // Going to real, scanExtras() rebuilds them once the primary reconnects.
    await this.stopAllExtraSessions();
    this.driverMode = newMode;
    if (newMode === 'mock') {
      await this.connectMock();
    } else {
      this.webui.notifyDriverStatus('real', false);
      void this.tryRealConnect();
    }
    this.onDocksChanged?.();
  }

  // ── Multi-device coordinator (extra docks) ─────────────────────────────────
  // Thin delegation to ExtraDockCoordinator (driver-manager-extras.ts) — see
  // that file for the scan/create/teardown implementation.

  /** Begin polling for extra distinct-model devices to expose as their own
   *  docks. Idempotent. Extras are created only after the primary connects so
   *  the primary probe claims its device first. */
  startScan(): void {
    this.extraCoordinator.startScan();
  }

  stopScan(): void {
    this.extraCoordinator.stopScan();
  }

  /** Test-only seam: run one extra-device scan pass synchronously-awaitable,
   *  without the setInterval timer. Mirrors the __set* seam style. */
  async __scanOnce(): Promise<void> {
    await this.extraCoordinator.scanOnce();
  }

  /** Tear down every extra dock and reset the index pool. Used by switchMode and
   *  by app.ts on shutdown. */
  async stopAllExtraSessions(): Promise<void> {
    await this.extraCoordinator.stopAllExtraSessions();
  }

  /** Every live dock's status for the WebUI: primary (index 0, if connected)
   *  then extras (sorted by index). Real mode with no driver → extras only. */
  getDockStatuses(): DockStatus[] {
    const extras = this.extraCoordinator.getDockStatuses();
    if (this.driverMode === 'real' && this.currentDriver === null) return extras;
    const primary = buildPrimaryDockStatus({
      model: this.currentModel,
      brightness: this.primaryBrightness,
      deviceInfo: this.primaryDeviceInfo,
      identity: this.primaryIdentity,
      primaryConnected: this.server.hasClient,
      elgatoConnected: this.childServer.hasClient,
    });
    return [primary, ...extras];
  }
}
