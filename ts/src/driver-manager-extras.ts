// Multi-device coordinator: one live extra dock per physical HID interface
// (keyed by hidPath, so two units of the SAME model each get their own), drawn
// from a pool of free session indices. `deps` are closures over DriverManager's
// mutable state — always current, and no runtime import cycle.
import { log } from './logger.js';
import { closeDriver, type WorkerHidDriver } from './hid-worker-host.js';
import type { DeviceModel, DeviceModelOverride } from './devices/driver.js';
import type { DriverMode } from './driver-manager-discovery.js';
import { HID_POLL_INTERVAL_MS, MAX_DEVICE_SESSIONS, MDNS_SERVICE_NAME } from './types.js';
import type {
  DockStatus,
  EncoderSettings,
  ExtraKeyConfig,
  TouchStripMode,
  TouchWindowRegion,
} from './types.js';
import { DEVICE_MODELS, findModelById } from './devices/registry.js';
import {
  DeviceSession,
  sessionIdentity,
  type DockFrames,
  type SessionServersFactory,
} from './device-session.js';
import { deviceKeyFor, sharedSerialModelId } from './device-identity.js';
import { coraPortConflict } from './cora-startup.js';
import type { DeviceIdentitySettings } from './settings-store.js';
import { touchStripOptionsOf } from './settings-store.js';

export interface ExtraDockCoordinatorDeps {
  getShuttingDown: () => boolean;
  getDriverMode: () => DriverMode;
  isProbeInFlight: () => boolean;
  sessionServersFactory: SessionServersFactory | null;
  getRealDriver: () => WorkerHidDriver | null;
  /** Refresh supported HID paths off-thread before each discovery pass. */
  refreshHidSnapshot: () => Promise<number>;
  /** Every connected HID interface path for this model (one per physical unit),
   *  from deckbridge-native enumeration. Drives per-unit docking of same-model
   *  duplicates. [] when absent or the model can't be path-targeted. */
  listModelPaths: (model: DeviceModel) => string[];
  /** Serial lookup from the completed discovery snapshot. Never enumerates. */
  serialForPath: (hidPath: string) => string | null;
  /** Registry model + the user's device tuning for it (settings.json
   *  modelOverrides), resolved by DriverManager. In safe mode
   *  (`--no-overrides`) `override` is undefined and `model` is the registry
   *  entry unchanged. */
  effectiveModelFor: (model: DeviceModel) => {
    model: DeviceModel;
    override?: DeviceModelOverride;
  };
  makeRealDriver: (model: DeviceModel, override?: DeviceModelOverride) => WorkerHidDriver;
  /** Reuse (or vend) the idle worker parked for this model.id, mirroring the
   *  primary probe's idleDrivers pattern — shared with DriverManager via
   *  these two callbacks rather than a second map. */
  takeIdleDriver: (modelId: string) => WorkerHidDriver | undefined;
  parkIdleDriver: (modelId: string, driver: WorkerHidDriver) => void;
  /** Look up (or generate + persist) the stable per-physical-device identity
   *  for `deviceKey` — delegates to WebUIServer, the sole settings.json
   *  writer (device-identity.ts is pure). */
  getOrCreateDeviceIdentity: (deviceKey: string, defaultMdnsName: string) => DeviceIdentitySettings;
  /** A dock was created/torn down or its child CORA client (dis)connected;
   *  DriverManager notifies the WebUI. */
  onSessionsChanged?: () => void;
  onAction?: (dockIndex: number, message: string) => void;
  /** Per-dock mirror of raw CORA key images (WebUI selected-dock preview). */
  onImage?: (dockIndex: number, keyIndex: number, data: Buffer, format: 'jpeg' | 'bmp') => void;
  /** WebUI strip + side-key preview mirrors; DeviceSession owns the device-side paint. */
  onTouchImage?: (dockIndex: number, data: Uint8Array, region?: TouchWindowRegion) => void;
  onExtraKeyImage?: (dockIndex: number, wireId: number, bmp: Uint8Array | null) => void;
  /** This dock's cached CORA frames, for repainting after a live tuning swap. */
  dockFramesSnapshot?: (dockIndex: number) => DockFrames;
  /** Per-device "ignore brightness from Elgato app" override, resolved by the
   *  dock's deviceKey (each dock has its own persisted flag). */
  isBrightnessOverride: (deviceKey: string) => boolean;
  /** Per-device extra-key config (293S 6th column), resolved by deviceKey +
   *  wire id — delegates to WebUIServer's persisted settings. */
  extraKeyConfigFor: (deviceKey: string, wireId: number) => ExtraKeyConfig | undefined;
  /** Per-device touch-strip mode + encoder override, resolved live by deviceKey. */
  touchStripModeFor: (deviceKey: string) => TouchStripMode;
  touchStripRepaintMsFor: (deviceKey: string) => number;
  encoderSettingsFor: (deviceKey: string) => EncoderSettings | undefined;
}

// Index 0 is the primary dock, so extras draw from 1..maxDocks-1 — an empty pool
// (maxDocks 1, the default) is what makes single-deck mode dock nothing.
const freshIndexPool = (maxDocks: number) =>
  Array.from({ length: Math.max(0, maxDocks - 1) }, (_, k) => k + 1);

export class ExtraDockCoordinator {
  private readonly deps: ExtraDockCoordinatorDeps;

  // Keyed by hidPath (physical unit), NOT model.id — lets N same-model units
  // each hold their own session.
  private extraSessions = new Map<string, DeviceSession>();
  // Per-hidPath post-pairing brightness resend timers.
  private brightnessResendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Total docks allowed, primary included. 1 (the default) = single deck: no
   *  extras pool, and the scan timer never runs. Raised by setMaxDocks(). */
  private maxDocks = 1;
  private freeIndices: number[] = freshIndexPool(1);
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** app.ts asked for scanning; whether it actually runs also depends on maxDocks. */
  private scanWanted = false;
  private scanInFlight = false;
  private extraCreateInFlight = false;

  constructor(deps: ExtraDockCoordinatorDeps) {
    this.deps = deps;
  }

  /** Ask for polling of extra devices to expose as their own docks. Idempotent,
   *  and deferred: nothing is scanned until multi-deck is enabled
   *  (setMaxDocks > 1), so startup order between the two calls is free. Extras
   *  are created only after the primary connects (see scanExtras) so the primary
   *  probe claims its device first. */
  startScan(): void {
    this.scanWanted = true;
    this.syncTimer();
  }

  stopScan(): void {
    this.scanWanted = false;
    this.syncTimer();
  }

  /** Raise/lower the dock cap (WebUI multi-deck toggle, via DriverManager).
   *  Dropping back to a single deck tears down every extra dock — leaving one
   *  live would keep an mDNS advert and a CORA port pair up with no UI to
   *  remove them. */
  async setMaxDocks(maxDocks: number): Promise<void> {
    const next = Math.min(Math.max(1, Math.trunc(maxDocks)), MAX_DEVICE_SESSIONS);
    if (next === this.maxDocks) return;
    this.maxDocks = next;
    if (next <= 1) {
      // Teardown BEFORE the timer sync, so no tick can race an in-flight create.
      await this.stopAllExtraSessions();
    } else {
      const held = new Set([...this.extraSessions.values()].map((s) => s.identity.index));
      this.freeIndices = freshIndexPool(next).filter((i) => !held.has(i));
    }
    this.syncTimer();
    log('info', 'coord', `dock cap: ${next}`);
  }

  /** The timer runs only when app.ts wants scanning AND a second dock is allowed
   *  — single-deck mode must not enumerate USB every tick, which is the whole
   *  point of the default. */
  private syncTimer(): void {
    const shouldRun = this.scanWanted && this.maxDocks > 1;
    if (shouldRun === (this.scanTimer !== null)) return;
    if (!shouldRun) {
      if (this.scanTimer !== null) clearInterval(this.scanTimer);
      this.scanTimer = null;
      return;
    }
    this.scanTimer = setInterval(() => {
      this.scanExtras().catch((e: unknown) =>
        log('error', 'coord', `scanExtras failed: ${(e as Error).message}`),
      );
    }, HID_POLL_INTERVAL_MS);
  }

  /** Test-only seam: run one extra-device scan pass synchronously-awaitable,
   *  without the setInterval timer. Mirrors the __set* seam style. */
  async scanOnce(): Promise<void> {
    await this.scanExtras();
  }

  private scanTarget(): WorkerHidDriver | null {
    if (this.maxDocks <= 1) return null; // single-deck default: never dock a second unit
    if (this.deps.getShuttingDown()) return null;
    if (this.deps.getDriverMode() !== 'real') return null;
    if (this.deps.isProbeInFlight()) return null;
    if (!this.deps.sessionServersFactory) return null;
    if (this.extraCreateInFlight) return null;
    if (this.freeIndices.length === 0) return null;
    return this.deps.getRealDriver();
  }

  private async scanExtras(): Promise<void> {
    if (this.scanInFlight) return;
    if (this.scanTarget() === null) return;
    this.scanInFlight = true;
    try {
      const enumerateMs = await this.deps.refreshHidSnapshot();
      log('debug', 'coord', `worker enumerate took ${enumerateMs}ms`);

      // State can change while the worker is blocked inside native discovery.
      const currentRealDriver = this.scanTarget();
      if (currentRealDriver === null) return;

      const pick = this.pickUnclaimedPath(currentRealDriver);
      if (!pick) return;
      this.extraCreateInFlight = true;
      try {
        await this.createExtraSession(pick.model, pick.hidPath);
      } finally {
        this.extraCreateInFlight = false;
      }
    } finally {
      this.scanInFlight = false;
    }
  }

  /** The lowest-sorted unclaimed HID path (claimed = the primary's own interface plus
   *  every live extra's) — the next physical unit to dock. Lowest wins so scan ticks are
   *  deterministic; exactly one dock opens per tick. If the primary opened without a
   *  known path (off-macOS VID/PID fallback), its unit is indistinguishable from a
   *  duplicate, so skip that whole model rather than risk double-opening it. */
  private pickUnclaimedPath(
    realDriver: WorkerHidDriver,
  ): { model: DeviceModel; hidPath: string } | null {
    const primaryPath = realDriver.hidPath;
    const claimed = new Set<string>(this.extraSessions.keys());
    if (primaryPath) claimed.add(primaryPath);
    const skipModelId = primaryPath ? null : realDriver.model.id;

    let pick: { model: DeviceModel; hidPath: string } | null = null;
    // Pure snapshot filtering. Native discovery already completed inside the
    // dedicated worker, so this loop cannot stall CORA or WebUI timers.
    const t0 = Date.now();
    let seen = 0;
    for (const model of DEVICE_MODELS) {
      if (model.id === skipModelId) continue;
      for (const path of this.deps.listModelPaths(model)) {
        seen++;
        if (claimed.has(path)) continue;
        if (!pick || path < pick.hidPath) pick = { model, hidPath: path };
      }
    }
    log('debug', 'coord', `enumerate took ${Date.now() - t0}ms, ${seen} device interface(s)`);
    return pick;
  }

  private async createExtraSession(registryModel: DeviceModel, hidPath: string): Promise<void> {
    const factory = this.deps.sessionServersFactory;
    if (!factory) return; // narrowing — scanExtras already guarded this

    // Device tuning applies to extras exactly as it does to the primary: the
    // effective model drives CORA geometry/input mapping/splash here, and the
    // raw override travels to the worker, which re-derives it from its own
    // registry copy (so no override can select a different driver).
    const { model, override } = this.deps.effectiveModelFor(registryModel);

    // Reuse a worker from a prior failed open (SIGBUS-safe pattern, see
    // idleDrivers / probeAndOpen) or spawn a fresh one. Clear any stale
    // listeners a prior owner (primary probe, or an aborted session) left on a
    // reused worker — DeviceSession.start() wires its own after a good open.
    let driver = this.deps.takeIdleDriver(model.id);
    if (!driver) {
      driver = this.deps.makeRealDriver(model, override);
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

    // Re-check after the open() await: setMaxDocks(1) during it already ran
    // stopAllExtraSessions(), so inserting this session now would orphan a dock
    // the user just switched off. Mirrors the post-snapshot scanTarget re-check.
    const index = this.maxDocks > 1 ? this.allocIndex() : null;
    if (index === null) {
      log('warn', 'coord', `no free session index (cap ${this.maxDocks}) — closing ${model.id}`);
      await closeDriver(driver);
      return;
    }

    // The stable USB-serial key (VID:PID:serial); the targeted hidPath is always
    // known here (we picked a specific unit), and its serial disambiguates two
    // same-model units. v1 models share a hardcoded serial across every unit (see
    // deviceKeyFor JSDoc) — append the model id so two different v1 decks don't
    // collapse into one identity.
    const serial = this.deps.serialForPath(hidPath);
    const deviceKey = deviceKeyFor(hidPath, serial, sharedSerialModelId(model));
    const deviceIdentity = this.deps.getOrCreateDeviceIdentity(
      deviceKey,
      `${MDNS_SERVICE_NAME} (${model.name})`,
    );
    const stripOptions = touchStripOptionsOf(deviceIdentity);
    if (stripOptions) driver.setTouchStripOptions(stripOptions);
    const identity = sessionIdentity(index, deviceIdentity);
    const servers = factory(identity);
    servers.childServer.on(
      'touchImage',
      ({ data, region }: { data: Uint8Array; region?: TouchWindowRegion }) =>
        this.deps.onTouchImage?.(index, data, region),
    );
    const session = new DeviceSession({
      identity,
      servers,
      driver,
      model,
      deviceInfo: {
        serial: driver.deviceSerial ?? serial ?? undefined,
        firmware: driver.deviceFirmware,
      },
      onDisconnect: () => {
        void this.teardownExtraSession(hidPath, index);
      },
      onStatusChange: this.deps.onSessionsChanged,
      onAction: (message) => this.deps.onAction?.(index, message),
      onExtraKeyImage: (wireId, bmp) => this.deps.onExtraKeyImage?.(index, wireId, bmp),
      onImage: (keyIndex, data, format) => this.deps.onImage?.(index, keyIndex, data, format),
      ignoreElgatoBrightness: () => this.deps.isBrightnessOverride(deviceKey),
      initialBrightness: deviceIdentity.brightness,
      extraKeyConfigFor: (wireId) => this.deps.extraKeyConfigFor(deviceKey, wireId),
      touchStripMode: this.deps.touchStripModeFor(deviceKey),
      touchStripRepaintMs: () => this.deps.touchStripRepaintMsFor(deviceKey),
      encoderOverride: () => ({
        mode: this.deps.touchStripModeFor(deviceKey),
        encoders: this.deps.encoderSettingsFor(deviceKey),
      }),
    });
    this.extraSessions.set(hidPath, session);
    servers.childServer.on('clientConnected', () =>
      this.scheduleBrightnessResend(hidPath, session, deviceIdentity),
    );

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
      const { primaryPort, childPort } = identity;
      log('error', 'coord', coraPortConflict(primaryPort, childPort, (e as Error).message));
      this.extraSessions.delete(hidPath);
      await session.stop();
      this.releaseIndex(index);
    }
  }

  /** Re-push the saved brightness ~1s after pairing, as app.ts does for the
   *  primary: the app's default-brightness handshake would stomp it.
   *  `deviceIdentity` is the live settings entry, so this reads the current value. */
  private scheduleBrightnessResend(
    hidPath: string,
    session: DeviceSession,
    deviceIdentity: DeviceIdentitySettings,
  ): void {
    this.clearBrightnessResendTimer(hidPath);
    const timer = setTimeout(() => {
      this.brightnessResendTimers.delete(hidPath);
      if (this.extraSessions.get(hidPath) === session)
        session.setBrightness(deviceIdentity.brightness ?? session.status().brightness);
    }, 1000);
    this.brightnessResendTimers.set(hidPath, timer);
  }

  /** Cleared on teardown so it can't fire against a closed driver. */
  private clearBrightnessResendTimer(hidPath: string): void {
    const timer = this.brightnessResendTimers.get(hidPath);
    if (timer) clearTimeout(timer);
    this.brightnessResendTimers.delete(hidPath);
  }

  /** Disconnect-driven teardown: the physical unit went away. Free the index so a
   *  new unit can reuse it. Keyed by hidPath (the physical interface). */
  private async teardownExtraSession(hidPath: string, index: number): Promise<void> {
    const session = this.extraSessions.get(hidPath);
    if (!session) return;
    this.extraSessions.delete(hidPath);
    this.clearBrightnessResendTimer(hidPath);
    this.releaseIndex(index);
    await session.stop();
    log('info', 'coord', `extra dock down: ${hidPath} idx=${index}`);
    this.deps.onSessionsChanged?.();
  }

  /** Tear down every extra dock and reset the index pool. Used by switchMode and
   *  by app.ts on shutdown. */
  async stopAllExtraSessions(): Promise<void> {
    const sessions = [...this.extraSessions.values()];
    for (const hidPath of this.extraSessions.keys()) this.clearBrightnessResendTimer(hidPath);
    this.extraSessions.clear();
    this.freeIndices = freshIndexPool(this.maxDocks);
    for (const s of sessions) {
      await s.stop();
    }
    this.deps.onSessionsChanged?.();
  }

  /** Route a WebUI brightness change to the extra dock with this index.
   *  Returns false when no live extra session has the index. */
  setDockBrightness(index: number, level: number): boolean {
    const session = this.sessionAt(index);
    if (!session) return false;
    session.setBrightness(level);
    return true;
  }

  /** Repaint the extra-key icons of the extra dock with this index (WebUI
   *  config change). No-op when no live extra session has the index. */
  repaintExtraKeys(index: number): void {
    this.sessionAt(index)?.repaintExtraKeys();
  }

  /** WebUI "Run now" for a command-widget extra key on the extra dock with this index. */
  forceRunExtraKey(index: number, wireId: number): void {
    this.sessionAt(index)?.forceRunExtraKey(wireId);
  }

  /** Switch who paints the touch strip on the extra dock at `index`. */
  setTouchStripMode(index: number, mode: TouchStripMode): void {
    this.sessionAt(index)?.setTouchStripMode(mode);
  }

  /** Tear down the extra docks running `modelId` ('' = all) so the next scan
   *  tick re-creates them with the new device tuning. */
  async reloadDeviceTuning(modelId: string): Promise<void> {
    // Snapshot first: teardownExtraSession deletes from the map we're walking.
    const live = Array.from(this.extraSessions.entries());
    for (const [hidPath, session] of live) {
      const status = session.status();
      if (modelId && status.modelId !== modelId) continue;
      await this.teardownExtraSession(hidPath, status.index);
    }
  }

  /** Image-only tuning change: swap the spec on each matching live session and
   *  repaint it, no teardown. `modelId` '' means "every model". */
  applyLiveDeviceTuning(modelId: string): void {
    for (const session of this.extraSessions.values()) {
      const driver = session.getDriver();
      if (modelId && driver.model.id !== modelId) continue;
      const registryModel = findModelById(driver.model.id);
      if (!registryModel) continue;
      const { model, override } = this.deps.effectiveModelFor(registryModel);
      session.applyLiveTuning(
        override,
        model,
        this.deps.dockFramesSnapshot?.(session.status().index),
      );
    }
  }

  /** Push a runtime log-level change to every extra dock's USB worker. */
  setLogLevel(level: string): void {
    for (const s of this.extraSessions.values()) s.getDriver().setLogLevel(level);
  }

  /** The driver behind the extra dock with this index, for app.ts's per-dock
   *  image-mode apply + repaint. null when no live extra session has the index. */
  getDriverForDock(index: number): WorkerHidDriver | null {
    return this.sessionAt(index)?.getDriver() ?? null;
  }

  /** Live-rename the extra dock matching `deviceKey`'s mDNS advert (WebUI
   *  "Device Identity" edit). No-op if no live extra session has that key. */
  applyMdnsNameForDeviceKey(deviceKey: string, name: string): boolean {
    const session = this.findSession((s) => s.identity.deviceKey === deviceKey);
    if (!session) return false;
    session.updateMdnsServiceName(name);
    return true;
  }

  /** Current status of every live extra dock, sorted by index (ascending). */
  getDockStatuses(): DockStatus[] {
    return [...this.extraSessions.values()]
      .map((s) => s.status())
      .toSorted((a, b) => a.index - b.index);
  }

  /** First live extra session satisfying `match`, or null — the WebUI addresses
   *  docks by index or deviceKey, never by the hidPath the map is keyed on. */
  private findSession(match: (s: DeviceSession) => boolean): DeviceSession | null {
    for (const s of this.extraSessions.values()) if (match(s)) return s;
    return null;
  }

  private sessionAt(index: number): DeviceSession | null {
    return this.findSession((s) => s.identity.index === index);
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
