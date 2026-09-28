// DockScanner: docks 1..N, one per physical HID interface (claimed
// by hidPath, so two units of the SAME model each get their own), drawn from a
// pool of free dock indices and kept in DriverManager's dock map. `deps` are
// closures over DriverManager's mutable state — always current, and no runtime
// import cycle.
import { log } from '../shared/logger.js';
import { closeDriver, type WorkerHidDriver } from '../worker/hid-worker-host.js';
import type { DeviceModel } from '../devices/driver.js';
import { HID_POLL_INTERVAL_MS, MAX_DOCKS, MDNS_SERVICE_NAME } from '../shared/types.js';
import { DEVICE_MODELS } from '../devices/registry.js';
import { dockSlot } from './dock-status.js';
import { Dock } from './dock.js';
import { deviceKeyFor, sharedSerialModelId } from '../infra/device-identity.js';
import type { DockScannerDeps, PrimaryUnit } from './dock-scanner-deps.js';

/** The USB unit behind a scanned dock: its claimed path, and the worker (log-level pushes). */
interface ScannedUnit {
  hidPath: string;
  driver: WorkerHidDriver;
}

// Index 0 is the primary dock, so scanned docks draw from 1..maxDocks-1 — an empty pool
// (maxDocks 1, the default) is what makes single-deck mode dock nothing.
const freshIndexPool = (maxDocks: number) =>
  Array.from({ length: Math.max(0, maxDocks - 1) }, (_, k) => k + 1);

export class DockScanner {
  private readonly deps: DockScannerDeps;

  /** By dock index; the Dock itself lives in deps.docks. */
  private readonly units = new Map<number, ScannedUnit>();
  /** Total docks allowed, primary included. 1 (the default) = single deck: no
   *  scan pool, and the scan timer never runs. Raised by setMaxDocks(). */
  private maxDocks = 1;
  private freeIndices: number[] = freshIndexPool(1);
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  /** app.ts asked for scanning; whether it actually runs also depends on maxDocks. */
  private scanWanted = false;
  private scanInFlight = false;
  private createInFlight = false;

  constructor(deps: DockScannerDeps) {
    this.deps = deps;
  }

  /** Ask for polling of extra devices to expose as their own docks. Idempotent,
   *  and deferred: nothing is scanned until multi-deck is enabled
   *  (setMaxDocks > 1), so startup order between the two calls is free. Scanned docks
   *  are created only after the primary connects (see scanForDocks) so the primary
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
   *  Dropping back to a single deck tears down every scanned dock — leaving one
   *  live would keep an mDNS advert and a CORA port pair up with no UI to
   *  remove them. */
  async setMaxDocks(maxDocks: number): Promise<void> {
    const next = Math.min(Math.max(1, Math.trunc(maxDocks)), MAX_DOCKS);
    if (next === this.maxDocks) return;
    this.maxDocks = next;
    if (next <= 1) {
      // Teardown BEFORE the timer sync, so no tick can race an in-flight create.
      await this.stopScannedDocks();
    } else {
      const held = new Set(this.units.keys());
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
      this.scanForDocks().catch((e: unknown) =>
        log('error', 'coord', `scanForDocks failed: ${(e as Error).message}`),
      );
    }, HID_POLL_INTERVAL_MS);
  }

  /** Test-only seam: run one extra-device scan pass synchronously-awaitable,
   *  without the setInterval timer. Mirrors the __set* seam style. */
  async scanOnce(): Promise<void> {
    await this.scanForDocks();
  }

  private scanTarget(): PrimaryUnit | null {
    if (this.maxDocks <= 1) return null; // single-deck default: never dock a second unit
    if (this.deps.getShuttingDown()) return null;
    if (this.deps.getDriverMode() !== 'real') return null;
    if (this.deps.isProbeInFlight()) return null;
    if (!this.deps.coraDockFactory) return null;
    if (this.createInFlight) return null;
    if (this.freeIndices.length === 0) return null;
    return this.deps.getRealDriver();
  }

  private async scanForDocks(): Promise<void> {
    if (this.scanInFlight) return;
    if (this.scanTarget() === null) return;
    this.scanInFlight = true;
    try {
      const enumerateMs = await this.deps.discovery.scan();
      log('debug', 'coord', `worker enumerate took ${enumerateMs}ms`);

      // State can change while the worker is blocked inside native discovery.
      const currentRealDriver = this.scanTarget();
      if (currentRealDriver === null) return;

      const pick = this.pickUnclaimedPath(currentRealDriver);
      if (!pick) return;
      this.createInFlight = true;
      try {
        await this.createDock(pick.model, pick.hidPath);
      } finally {
        this.createInFlight = false;
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
    realDriver: PrimaryUnit,
  ): { model: DeviceModel; hidPath: string } | null {
    const primaryPath = realDriver.hidPath;
    const claimed = new Set<string>([...this.units.values()].map((u) => u.hidPath));
    if (primaryPath) claimed.add(primaryPath);
    const skipModelId = primaryPath ? null : realDriver.model.id;

    let pick: { model: DeviceModel; hidPath: string } | null = null;
    // Pure snapshot filtering. Native discovery already completed inside the
    // dedicated worker, so this loop cannot stall CORA or WebUI timers.
    const t0 = Date.now();
    let seen = 0;
    for (const model of DEVICE_MODELS) {
      if (model.id === skipModelId) continue;
      for (const path of this.deps.discovery.paths(model)) {
        seen++;
        if (claimed.has(path)) continue;
        if (!pick || path < pick.hidPath) pick = { model, hidPath: path };
      }
    }
    log('debug', 'coord', `enumerate took ${Date.now() - t0}ms, ${seen} device interface(s)`);
    return pick;
  }

  private async createDock(registryModel: DeviceModel, hidPath: string): Promise<void> {
    const factory = this.deps.coraDockFactory;
    if (!factory) return; // narrowing — scanForDocks already guarded this

    // Device tuning applies to scanned docks exactly as it does to the primary: the
    // effective model drives CORA geometry/input mapping/splash here, and the
    // raw override travels to the worker, which re-derives it from its own
    // registry copy (so no override can select a different driver).
    const { model, override } = this.deps.effectiveModelFor(registryModel);

    // Reuse a worker from a prior failed open (SIGBUS-safe pattern, see
    // worker-pool.ts) or spawn a fresh one. Clear any stale
    // listeners a prior owner (primary probe, or an aborted dock) left on a
    // reused worker — Dock.attach() wires its own after a good open.
    const { driver, fresh } = this.deps.pool.acquire(model, override);
    if (!fresh) driver.removeAllListeners();

    try {
      await driver.open(hidPath);
    } catch (e) {
      // Present but unopenable — park the worker alive (do NOT terminate) and
      // let a later scan retry open() on the same instance.
      log('debug', 'coord', `${model.id} extra open failed: ${(e as Error).message}`);
      this.deps.pool.park(model.id, driver);
      return;
    }

    // Re-check after the open() await: setMaxDocks(1) during it already ran
    // stopScannedDocks(), so inserting this session now would orphan a dock
    // the user just switched off. Mirrors the post-snapshot scanTarget re-check.
    const index = this.maxDocks > 1 ? this.allocIndex() : null;
    if (index === null) {
      log('warn', 'coord', `no free dock index (cap ${this.maxDocks}) — closing ${model.id}`);
      await closeDriver(driver);
      return;
    }

    // The stable USB-serial key (VID:PID:serial); the targeted hidPath is always
    // known here (we picked a specific unit), and its serial disambiguates two
    // same-model units. v1 models share a hardcoded serial across every unit (see
    // deviceKeyFor JSDoc) — append the model id so two different v1 decks don't
    // collapse into one identity.
    const serial = this.deps.discovery.serial(hidPath);
    const deviceKey = deviceKeyFor(hidPath, serial, sharedSerialModelId(model));
    const deviceIdentity = this.deps.settings.getOrCreateIdentity(
      deviceKey,
      `${MDNS_SERVICE_NAME} (${model.name})`,
    );
    const identity = dockSlot(index, deviceIdentity);
    const dock = new Dock({
      index,
      cora: factory(identity),
      ports: { primary: identity.primaryPort, child: identity.childPort },
      settings: this.deps.settings,
      identity,
      model,
      deviceInfo: {
        serial: driver.deviceSerial ?? serial ?? undefined,
        firmware: driver.deviceFirmware,
      },
      getShuttingDown: this.deps.getShuttingDown,
      hooks: {
        ...this.deps.dockHooks(index),
        disconnect: () => {
          void this.teardownDock(index);
        },
      },
    });
    this.units.set(index, { hidPath, driver });
    this.deps.docks.set(index, dock);

    try {
      await dock.start(driver);
      log(
        'info',
        'coord',
        `dock up: ${model.name} idx=${index} ports=${identity.primaryPort}/${identity.childPort}`,
      );
      this.deps.onChanged();
      this.deps.onDockConnected?.(index, deviceKey);
    } catch (e) {
      // Almost always a bind error — another DeckBridge / Elgato dock owns the
      // port (already logged with the port numbers by CoraDock.startWithRetry,
      // via dock.start()'s single-attempt call). Stop the dock and close this
      // freshly-opened worker (fine, it's not the churny unopenable-device
      // case), then free the index for a retry.
      log('error', 'coord', `dock ${model.id} idx=${index} start failed: ${(e as Error).message}`);
      this.forget(index);
      await dock.stop();
      await closeDriver(driver);
    }
  }

  /** Disconnect-driven teardown: the physical unit went away. Free the index so a
   *  new unit can reuse it. */
  private async teardownDock(index: number): Promise<void> {
    const dock = this.deps.docks.get(index);
    const unit = this.units.get(index);
    if (!dock || !unit) return;
    this.forget(index);
    await dock.stop();
    log('info', 'coord', `dock down: ${unit.hidPath} idx=${index}`);
    this.deps.onChanged();
  }

  /** Drop a scanned dock from the map and free its index (the caller stops it). */
  private forget(index: number): void {
    this.units.delete(index);
    this.deps.docks.delete(index);
    this.releaseIndex(index);
  }

  /** Tear down every scanned dock and reset the index pool. Used by switchMode and
   *  by app.ts on shutdown. */
  async stopScannedDocks(): Promise<void> {
    const docks = [...this.units.keys()].flatMap((i) => this.deps.docks.get(i) ?? []);
    for (const index of this.units.keys()) this.deps.docks.delete(index);
    this.units.clear();
    this.freeIndices = freshIndexPool(this.maxDocks);
    for (const dock of docks) await dock.stop();
    this.deps.onChanged();
  }

  /** Tear down the scanned docks running `modelId` ('' = all) so the next scan
   *  tick re-creates them with the new device tuning. */
  async reloadDeviceTuning(modelId: string): Promise<void> {
    // Snapshot first: teardownDock deletes from the map we're walking.
    for (const [index, { driver }] of Array.from(this.units)) {
      if (modelId && driver.model.id !== modelId) continue;
      await this.teardownDock(index);
    }
  }

  /** Push a runtime log-level change to every scanned dock's USB worker. */
  setLogLevel(level: string): void {
    for (const { driver } of this.units.values()) driver.setLogLevel(level);
  }

  /** Lowest free dock index (1..MAX_DOCKS-1), or null if exhausted. */
  private allocIndex(): number | null {
    if (this.freeIndices.length === 0) return null;
    this.freeIndices.sort((a, b) => a - b);
    return this.freeIndices.shift() ?? null;
  }

  private releaseIndex(index: number): void {
    if (!this.freeIndices.includes(index)) this.freeIndices.push(index);
  }
}
