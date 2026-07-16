// Multi-device coordinator (extra docks), split out of driver-manager.ts.
// One live extra dock per physical HID interface (keyed by hidPath, so two units
// of the SAME model each get their own dock), plus a pool of free session indices
// (1..MAX_DEVICE_SESSIONS-1, lowest wins) that indices return to on teardown.
// scanTimer polls for newly-present unclaimed paths; extraCreateInFlight
// serializes creation so a slow open()/start() can't overlap the next scan
// tick. Owned by DriverManager as a private field; deps are closures over
// DriverManager's own mutable state so this coordinator always sees the
// current value (probeInFlight, driverMode, realDriver, etc.) without a
// runtime import cycle.
import { log } from './logger.js';
import { closeDriver, type WorkerHidDriver } from './hid-worker-host.js';
import type { DeviceModel } from './devices/driver.js';
import type { DriverMode } from './driver-manager.js';
import { MAX_DEVICE_SESSIONS, RECONNECT_DELAY_MS, MDNS_SERVICE_NAME } from './types.js';
import type { DockStatus, ExtraKeyConfig } from './types.js';
import { DEVICE_MODELS } from './devices/registry.js';
import { DeviceSession, sessionIdentity, type SessionServersFactory } from './device-session.js';
import { deviceKeyFor } from './device-identity.js';
import { hidSerialForPath } from './ffi/hidapi.js';
import type { DeviceIdentitySettings } from './settings-store.js';

export interface ExtraDockCoordinatorDeps {
  getShuttingDown: () => boolean;
  getDriverMode: () => DriverMode;
  isProbeInFlight: () => boolean;
  sessionServersFactory: SessionServersFactory | null;
  getRealDriver: () => WorkerHidDriver | null;
  /** Every connected HID interface path for this model (one per physical unit),
   *  from deckbridge-native enumeration. Drives per-unit docking of same-model
   *  duplicates. [] when absent or the model can't be path-targeted. */
  listModelPaths: (model: DeviceModel) => string[];
  makeRealDriver: (model: DeviceModel) => WorkerHidDriver;
  /** Reuse (or vend) the idle worker parked for this model.id, mirroring the
   *  primary probe's idleDrivers pattern — shared with DriverManager via
   *  these two callbacks rather than a second map. */
  takeIdleDriver: (modelId: string) => WorkerHidDriver | undefined;
  parkIdleDriver: (modelId: string, driver: WorkerHidDriver) => void;
  /** Look up (or generate + persist) the stable per-physical-device identity
   *  for `deviceKey` — delegates to WebUIServer, the sole settings.json
   *  writer (device-identity.ts is pure). */
  getOrCreateDeviceIdentity: (deviceKey: string, defaultMdnsName: string) => DeviceIdentitySettings;
  /** Called whenever the set of extra sessions, or any one session's status()
   *  shape, may have changed — a dock created, torn down, or its child CORA
   *  client (dis)connected. Opaque to the coordinator: DriverManager uses it
   *  to notify the WebUI. */
  onSessionsChanged?: () => void;
  /** Per-dock mirror of raw CORA key images (WebUI selected-dock preview). */
  onImage?: (dockIndex: number, keyIndex: number, data: Uint8Array, format: 'jpeg' | 'bmp') => void;
  /** Per-device "ignore brightness from Elgato app" override, resolved by the
   *  dock's deviceKey (each dock has its own persisted flag). */
  isBrightnessOverride: (deviceKey: string) => boolean;
  /** Per-device extra-key config (293S 6th column), resolved by deviceKey +
   *  wire id — delegates to WebUIServer's persisted settings. */
  extraKeyConfigFor: (deviceKey: string, wireId: number) => ExtraKeyConfig | undefined;
}

export class ExtraDockCoordinator {
  private readonly deps: ExtraDockCoordinatorDeps;

  // Keyed by hidPath (physical unit), NOT model.id — lets N same-model units
  // each hold their own session.
  private extraSessions = new Map<string, DeviceSession>();
  private freeIndices: number[] = Array.from({ length: MAX_DEVICE_SESSIONS - 1 }, (_, k) => k + 1);
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private extraCreateInFlight = false;

  constructor(deps: ExtraDockCoordinatorDeps) {
    this.deps = deps;
  }

  /** Begin polling for extra distinct-model devices to expose as their own
   *  docks. Idempotent. Extras are created only after the primary connects
   *  (see scanExtras) so the primary probe claims its device first. */
  startScan(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = setInterval(() => {
      this.scanExtras().catch((e: unknown) =>
        log('error', 'coord', `scanExtras failed: ${(e as Error).message}`),
      );
    }, RECONNECT_DELAY_MS);
  }

  stopScan(): void {
    if (this.scanTimer !== null) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /** Test-only seam: run one extra-device scan pass synchronously-awaitable,
   *  without the setInterval timer. Mirrors the __set* seam style. */
  async scanOnce(): Promise<void> {
    await this.scanExtras();
  }

  private async scanExtras(): Promise<void> {
    // Guard order matters: cheapest/most-decisive first.
    if (this.deps.getShuttingDown()) return;
    if (this.deps.getDriverMode() !== 'real') return;
    if (this.deps.isProbeInFlight()) return; // don't race the primary probe
    if (!this.deps.sessionServersFactory) return; // multi-device disabled
    const realDriver = this.deps.getRealDriver();
    if (realDriver === null) return; // extras only AFTER the primary connects
    if (this.extraCreateInFlight) return; // one creation at a time
    if (this.freeIndices.length === 0) return; // all session indices in use

    const pick = this.pickUnclaimedPath(realDriver);
    if (!pick) return;

    this.extraCreateInFlight = true;
    try {
      await this.createExtraSession(pick.model, pick.hidPath);
    } finally {
      this.extraCreateInFlight = false;
    }
  }

  /** The lowest-sorted HID path (across all models) not already claimed by the
   *  primary or a live extra — the next physical unit to dock. Lowest wins so
   *  scan ticks are deterministic; exactly one dock opens per tick. null when
   *  every present unit is already docked.
   *
   *  Claimed = the primary's own interface + every live extra's. The primary's
   *  path is the single source of truth for "don't re-open the primary's unit"
   *  (see the hid_open_path risk in the plan). If the primary opened without a
   *  known path (off-macOS VID/PID fallback), we can't tell its unit from a
   *  duplicate — skip its whole model so we never double-open it. */
  private pickUnclaimedPath(
    realDriver: WorkerHidDriver,
  ): { model: DeviceModel; hidPath: string } | null {
    const primaryPath = realDriver.hidPath;
    const claimed = new Set<string>(this.extraSessions.keys());
    if (primaryPath) claimed.add(primaryPath);
    const skipModelId = primaryPath ? null : realDriver.model.id;

    let pick: { model: DeviceModel; hidPath: string } | null = null;
    for (const model of DEVICE_MODELS) {
      if (model.id === skipModelId) continue;
      for (const path of this.deps.listModelPaths(model)) {
        if (claimed.has(path)) continue;
        if (!pick || path < pick.hidPath) pick = { model, hidPath: path };
      }
    }
    return pick;
  }

  private async createExtraSession(model: DeviceModel, hidPath: string): Promise<void> {
    const factory = this.deps.sessionServersFactory;
    if (!factory) return; // narrowing — scanExtras already guarded this

    // Reuse a worker from a prior failed open (SIGBUS-safe pattern, see
    // idleDrivers / probeAndOpen) or spawn a fresh one. Clear any stale
    // listeners a prior owner (primary probe, or an aborted session) left on a
    // reused worker — DeviceSession.start() wires its own after a good open.
    let driver = this.deps.takeIdleDriver(model.id);
    if (!driver) {
      driver = this.deps.makeRealDriver(model);
    } else {
      driver.removeAllListeners();
    }

    try {
      await driver.open(hidPath);
    } catch (e) {
      // Present but unopenable — park the worker alive (do NOT terminate) and
      // let a later scan retry open() on the same instance.
      log('debug', 'coord', `${model.id} extra open failed: ${(e as Error).message}`);
      this.deps.parkIdleDriver(model.id, driver);
      return;
    }

    const index = this.allocIndex();
    if (index === null) {
      log(
        'warn',
        'coord',
        `no free session index (max ${MAX_DEVICE_SESSIONS}) — closing ${model.id}`,
      );
      await closeDriver(driver);
      return;
    }

    // The stable USB-serial key (VID:PID:serial); the targeted hidPath is always
    // known here (we picked a specific unit), and its serial disambiguates two
    // same-model units.
    const serial = hidSerialForPath(hidPath);
    const deviceKey = deviceKeyFor(hidPath, serial);
    const deviceIdentity = this.deps.getOrCreateDeviceIdentity(
      deviceKey,
      `${MDNS_SERVICE_NAME} (${model.name})`,
    );
    const identity = sessionIdentity(index, deviceIdentity);
    const servers = factory(identity);
    const session = new DeviceSession({
      identity,
      servers,
      driver,
      model,
      deviceInfo: { serial: driver.deviceSerial, firmware: driver.deviceFirmware },
      onDisconnect: () => {
        void this.teardownExtraSession(hidPath, index);
      },
      onStatusChange: this.deps.onSessionsChanged,
      onImage: (keyIndex, data, format) => this.deps.onImage?.(index, keyIndex, data, format),
      ignoreElgatoBrightness: () => this.deps.isBrightnessOverride(deviceKey),
      initialBrightness: deviceIdentity.brightness,
      initialImageMode: deviceIdentity.imageModeOverride ?? null,
      extraKeyConfigFor: (wireId) => this.deps.extraKeyConfigFor(deviceKey, wireId),
    });
    this.extraSessions.set(hidPath, session);

    try {
      await session.start();
      log(
        'info',
        'coord',
        `extra dock up: ${model.name} idx=${index} ports=${identity.primaryPort}/${identity.childPort}`,
      );
      this.deps.onSessionsChanged?.();
    } catch (e) {
      // Almost always a bind error — another DeckBridge / Elgato dock owns the
      // port. Stop the session (closes this freshly-opened worker — fine, it's
      // not the churny unopenable-device case) and free the index for a retry.
      log(
        'error',
        'coord',
        `CORA port ${identity.primaryPort}/${identity.childPort} in use — is another DeckBridge / Elgato dock running? (${(e as Error).message})`,
      );
      this.extraSessions.delete(hidPath);
      await session.stop();
      this.releaseIndex(index);
    }
  }

  /** Disconnect-driven teardown: the physical unit went away. Free the index so a
   *  new unit can reuse it. Keyed by hidPath (the physical interface). */
  private async teardownExtraSession(hidPath: string, index: number): Promise<void> {
    const session = this.extraSessions.get(hidPath);
    if (!session) return;
    this.extraSessions.delete(hidPath);
    this.releaseIndex(index);
    await session.stop();
    log('info', 'coord', `extra dock down: ${hidPath} idx=${index}`);
    this.deps.onSessionsChanged?.();
  }

  /** Tear down every extra dock and reset the index pool. Used by switchMode and
   *  by app.ts on shutdown. */
  async stopAllExtraSessions(): Promise<void> {
    const sessions = [...this.extraSessions.values()];
    this.extraSessions.clear();
    this.freeIndices = Array.from({ length: MAX_DEVICE_SESSIONS - 1 }, (_, k) => k + 1);
    for (const s of sessions) {
      await s.stop();
    }
    this.deps.onSessionsChanged?.();
  }

  /** Route a WebUI brightness change to the extra dock with this index.
   *  Returns false when no live extra session has the index. */
  setDockBrightness(index: number, level: number): boolean {
    for (const s of this.extraSessions.values()) {
      if (s.identity.index === index) {
        s.setBrightness(level);
        return true;
      }
    }
    return false;
  }

  /** Repaint the extra-key icons of the extra dock with this index (WebUI
   *  config change). No-op when no live extra session has the index. */
  repaintExtraKeys(index: number): void {
    for (const s of this.extraSessions.values()) {
      if (s.identity.index === index) {
        s.repaintExtraKeys();
        return;
      }
    }
  }

  /** WebUI "Run now" for a command-widget extra key on the extra dock with this index. */
  forceRunExtraKey(index: number, wireId: number): void {
    for (const s of this.extraSessions.values()) {
      if (s.identity.index === index) {
        s.forceRunExtraKey(wireId);
        return;
      }
    }
  }

  /** The driver behind the extra dock with this index, for app.ts's per-dock
   *  image-mode apply + repaint. null when no live extra session has the index. */
  getDriverForDock(index: number): WorkerHidDriver | null {
    for (const s of this.extraSessions.values()) {
      if (s.identity.index === index) return s.getDriver();
    }
    return null;
  }

  /** Live-rename the extra dock matching `deviceKey`'s mDNS advert (WebUI
   *  "Device Identity" edit). No-op if no live extra session has that key. */
  applyMdnsNameForDeviceKey(deviceKey: string, name: string): boolean {
    for (const s of this.extraSessions.values()) {
      if (s.identity.deviceKey === deviceKey) {
        s.updateMdnsServiceName(name);
        return true;
      }
    }
    return false;
  }

  /** Current status of every live extra dock, sorted by index (ascending). */
  getDockStatuses(): DockStatus[] {
    return [...this.extraSessions.values()]
      .map((s) => s.status())
      .toSorted((a, b) => a.index - b.index);
  }

  /** Lowest free session index (1..MAX_DEVICE_SESSIONS-1), or null if exhausted. */
  private allocIndex(): number | null {
    if (this.freeIndices.length === 0) return null;
    this.freeIndices.sort((a, b) => a - b);
    return this.freeIndices.shift() ?? null;
  }

  private releaseIndex(index: number): void {
    if (!this.freeIndices.includes(index)) this.freeIndices.push(index);
  }
}
