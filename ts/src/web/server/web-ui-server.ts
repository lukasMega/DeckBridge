import { EventEmitter } from 'node:events';
import { Broadcaster } from './broadcaster.js';
import { matchRoute } from './router.js';
import { routes } from './routes.js';
import { forbidden, notFound } from './http.js';
import { DEFAULT_MODEL } from '../../devices/registry.js';
import type { DeviceIdentitySettings } from '../../settings-store.js';
import { ExtraKeysController } from './extra-keys-controller.js';
import { ImageChannel } from './image-channel.js';
import type { ImageFormat, DockFrame } from './image-channel.js';
import { SettingsIdentityController } from './settings-identity-controller.js';
import { DockRegistry } from './dock-registry.js';
import {
  FALLBACK_PORT_ATTEMPTS,
  isAllowedWebRequest,
  isPortInUse,
  pickFallbackPort,
} from './web-request-guard.js';
import { ActivityBuffers } from './activity-buffers.js';
import { defaultMockConfig, mergeMockConfig } from './mock-config.js';
import { PersistedSettings } from './persisted-settings.js';
import type {
  DeviceModelInfo,
  DriverMode,
  LogLevel,
  MockDeviceConfig,
  PluginsInfo,
  StateResponse,
  Stats,
  StatusSnapshot,
  WebUIController,
} from './types.js';
import type {
  KeyState,
  CommEntry,
  ExtraKeyConfig,
  ImageModeOverride,
  DockStatus,
  ClientApp,
} from '../../types.js';
import { WEBUI_PORT, webuiBindAddr, DEFAULT_BRIGHTNESS_OVERRIDE } from '../../types.js';

export { isAllowedWebRequest, isValidMacAddress, pickFallbackPort } from './web-request-guard.js';

type ReqError = { error: string; status: number };

export class WebUIServer extends EventEmitter implements WebUIController {
  private server: TjsServeServer | null = null;
  private readonly bus = new Broadcaster();
  private readonly activity = new ActivityBuffers(this.bus);
  private readonly settings: PersistedSettings;
  private readonly dockRegistry: DockRegistry;
  private readonly extraKeys: ExtraKeysController;
  private readonly settingsIdentity: SettingsIdentityController;
  private readonly imageChannel = new ImageChannel(this.bus, () => this.selectedDock);

  get imageState(): Map<number, Buffer> {
    return this.imageChannel.imageState;
  }
  get imageFormat(): Map<number, ImageFormat> {
    return this.imageChannel.imageFormat;
  }
  get selectedDock(): number {
    return this.dockRegistry.selectedDock;
  }
  resizeEnabled = true;
  // brightness/brightnessOverride/imageModeOverride live per-device in settings.devices[]; these two are the runtime-only fallback with no deviceKey (mock/pre-connect) — never persisted.
  private runtimeBrightnessOverride = DEFAULT_BRIGHTNESS_OVERRIDE;
  private runtimeImageModeOverride: ImageModeOverride = null;

  /** brightnessOverride of the SELECTED dock (WebUI toggle). */
  get brightnessOverride(): boolean {
    return this.isBrightnessOverride(this.dockRegistry.selectedDeviceKey());
  }
  /** Per-device brightnessOverride — read by DriverManager/DeviceSession's Elgato-brightness ignore (per dock). */
  isBrightnessOverride(deviceKey: string): boolean {
    const e = this.settings.entryFor(deviceKey);
    return e
      ? (e.brightnessOverride ?? DEFAULT_BRIGHTNESS_OVERRIDE)
      : this.runtimeBrightnessOverride;
  }
  /** Same, by dock index (app.ts's Elgato→primary brightness gate). */
  isBrightnessOverrideForDock(index: number): boolean {
    return this.isBrightnessOverride(this.dockRegistry.deviceKeyFor(index));
  }
  /** imageModeOverride of the SELECTED dock; null = model default. */
  get imageModeOverride(): ImageModeOverride {
    const e = this.settings.entryFor(this.dockRegistry.selectedDeviceKey());
    return e ? (e.imageModeOverride ?? null) : this.runtimeImageModeOverride;
  }

  /** Scalar state mirrored 1:1 into the status snapshot. */
  private readonly status = {
    driverMode: 'real' as DriverMode,
    driverConnected: false,
    elgatoConnected: false,
    elgatoRemoteAddr: null as string | null,
    clientApp: 'unknown' as ClientApp,
    modelId: DEFAULT_MODEL.id,
    modelName: DEFAULT_MODEL.name,
    keyCount: DEFAULT_MODEL.keyCount,
    columns: DEFAULT_MODEL.columns,
    rows: DEFAULT_MODEL.rows,
    elgatoAppRunning: false,
    elgatoDevicePresent: false,
    localIp: '127.0.0.1',
  };
  private readonly stats: Stats = { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 };
  private readonly startTime = Date.now();
  setLocalIp(ip: string): void {
    this.status.localIp = ip;
  }
  private _port: number;
  get port(): number {
    return this._port;
  }
  private readonly deviceModels: DeviceModelInfo[];
  private mockConfig: MockDeviceConfig = defaultMockConfig();

  constructor(
    port = WEBUI_PORT,
    deviceModels: DeviceModelInfo[] = [],
    initialDriverMode: DriverMode = 'real',
    settingsCacheRoot?: string,
  ) {
    super();
    this._port = port;
    this.deviceModels = deviceModels;
    this.status.driverMode = initialDriverMode;
    this.settings = new PersistedSettings(settingsCacheRoot);
    this.dockRegistry = new DockRegistry(this.settings);
    this.extraKeys = new ExtraKeysController(
      this.settings,
      this.bus,
      () => this.dockRegistry.selectedDeviceKey(),
      () => this.dockRegistry.selectedStatus(),
      (event, ...args) => this.emit(event, ...args),
    );
    this.settingsIdentity = new SettingsIdentityController(
      this.settings,
      () => this.status.driverMode,
      () => this.mockConfig,
      () => this.dockRegistry.selectedStatus(),
      () => this.selectedDock,
      () => this.dockRegistry.selectedDeviceKey(),
      () => this.imageModeOverride,
      (index) => this.trySelectDock(index),
      () => this.broadcastSelectedDeviceState(),
      (event, ...args) => this.emit(event, ...args),
    );
  }

  // `listen = false` (--no-webui): settings still load (identity/brightness/extra-keys must work
  // headless too), but the HTTP/WS listener + broadcast timers never start — notify*/log/snapshot become no-ops.
  async start(listen = true): Promise<void> {
    await this.settings.load(); // direct load — no broadcasts/hardware events fire before anything listens
    if (!listen) return;
    if (await isPortInUse(this._port)) {
      for (let attempt = 0; attempt < FALLBACK_PORT_ATTEMPTS; attempt++) {
        const candidate = pickFallbackPort();
        if (!(await isPortInUse(candidate))) {
          this._port = candidate;
          break;
        }
      }
    }
    this.server = tjs.serve({
      port: this._port,
      listenIp: webuiBindAddr(),
      fetch: (req, extra) => this.handleRequest(req, extra),
      websocket: this.bus.websocketHandlers((ws) => this.bus.sendTo(ws, 'status', this.snapshot())),
    });

    this.bus.start(() => {
      this.stats.uptimeMs = Date.now() - this.startTime;
      this.bus.broadcast('stats', this.stats);
    });
  }

  // Keep async: callers chain `stop().catch(...)`, so a sync throw from server?.stop() surfaces as a rejection, not an escape.
  // eslint-disable-next-line @typescript-eslint/require-await -- intentional async (see above)
  async stop(): Promise<void> {
    this.activity.stop();
    this.bus.stop();
    this.server?.stop();
    this.server = null;
  }

  /** True if at least one WebUI WS client is connected. */
  hasClients(): boolean {
    return this.bus.size > 0;
  }

  notifyKeyEvent(mk2Index: number, state: KeyState): void {
    this.activity.keyEvent(mk2Index, state);
  }

  notifyComm(entry: Omit<CommEntry, 'ts'>): void {
    this.activity.comm(entry);
  }

  log(level: LogLevel, component: string, message: string): void {
    this.activity.log(level, component, message);
  }

  notifyImageUpdate(mk2Index: number, data: Buffer, format: ImageFormat = 'jpeg'): void {
    this.imageChannel.notifyImageUpdate(mk2Index, data, format);
  }

  notifyDockImage(
    dock: number,
    mk2Index: number,
    data: Buffer,
    format: ImageFormat = 'jpeg',
  ): void {
    this.imageChannel.notifyDockImage(dock, mk2Index, data, format);
  }

  dockFramesSnapshot(dock: number): Map<number, DockFrame> {
    return this.imageChannel.dockFramesSnapshot(dock);
  }

  /** Switch the live preview to another dock: swap in its cached frames and replay them. */
  selectDock(index: number): void {
    if (index === this.selectedDock) return;
    this.dockRegistry.selectedDock = index;
    this.imageChannel.clearLive();
    this.broadcastStatus();
    // Per-device values aren't in the status snapshot — re-push the new dock's to keep slider/toggles in sync.
    this.bus.broadcast('brightness', { level: this.dockRegistry.selectedBrightness() });
    this.broadcastSelectedDeviceState();
    this.settings.persist();
    this.imageChannel.replay(index);
  }

  /** Validate + apply a select-dock request from the WebUI. */
  trySelectDock(index: unknown): ReqError | null {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return { error: 'index must be a non-negative integer', status: 400 };
    }
    if (index !== 0 && !this.dockRegistry.has(index)) {
      return { error: `no dock with index ${index}`, status: 404 };
    }
    this.selectDock(index);
    return null;
  }

  /** "Repaint everything" signal (e.g. after a brightness change), decoupled from the per-key image-update path. */
  notifyRepaint(): void {
    this.bus.broadcast('repaint', {});
  }

  /** Drop one dock's cached per-key images (model change / disconnect); clears the live channel too when selected. */
  resetImages(dock = 0): void {
    if (this.imageChannel.reset(dock)) this.notifyRepaint();
  }

  notifyResizeToggle(enabled: boolean): void {
    this.resizeEnabled = enabled;
    this.bus.broadcast('resizeToggle', { enabled });
    this.emit('regenPreviews', enabled);
  }

  /** Store a value on the SELECTED dock's persisted entry, or (no deviceKey) a runtime-only fallback field. Shared by notifyBrightnessOverride/notifyImageMode. */
  private mutateSelectedEntryOrRuntime(
    mutate: (e: DeviceIdentitySettings) => void,
    runtimeFallback: () => void,
  ): void {
    const e = this.settings.entryFor(this.dockRegistry.selectedDeviceKey());
    if (e) {
      mutate(e);
      this.settings.persist();
    } else {
      runtimeFallback();
    }
  }

  notifyBrightnessOverride(enabled: boolean): void {
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.brightnessOverride = enabled),
      () => (this.runtimeBrightnessOverride = enabled),
    );
    this.bus.broadcast('brightnessOverride', { enabled });
    // Re-assert brightness so a freshly enabled override wins over whatever Elgato last pushed.
    if (enabled)
      this.emit('setBrightness', this.dockRegistry.selectedBrightness(), this.selectedDock);
  }

  /** Per-device image-mode override: store, broadcast, and let app.ts apply it via 'setImageOverride'. */
  notifyImageMode(mode: ImageModeOverride): void {
    this.mutateSelectedEntryOrRuntime(
      (e) => (e.imageModeOverride = mode),
      () => (this.runtimeImageModeOverride = mode),
    );
    this.bus.broadcast('imageMode', { mode });
    this.emit('setImageOverride', mode, this.selectedDock);
  }

  // Broadcast-only: brightness is persisted per-device via notifyDocks; this just pushes the slider value.
  notifyBrightness(level: number): void {
    this.bus.broadcast('brightness', { level });
  }

  notifyDriverStatus(mode: DriverMode, connected: boolean): void {
    this.status.driverMode = mode;
    this.status.driverConnected = connected;
    this.broadcastStatus();
  }

  notifyElgatoStatus(connected: boolean, remoteAddr?: string): void {
    this.status.elgatoConnected = connected;
    this.status.elgatoRemoteAddr = remoteAddr ?? null;
    if (!connected) this.status.clientApp = 'unknown';
    this.broadcastStatus();
  }

  /** Set a status field + broadcast, only if changed — shared by notifyClientApp/AppRunning/DevicePresent. */
  private setStatusFlag<K extends 'clientApp' | 'elgatoAppRunning' | 'elgatoDevicePresent'>(
    key: K,
    value: (typeof this.status)[K],
  ): void {
    if (this.status[key] === value) return;
    this.status[key] = value;
    this.broadcastStatus();
  }

  /** Which CORA client (Elgato app vs Bitfocus Companion) was detected. Reset to 'unknown' on disconnect. */
  notifyClientApp(app: ClientApp): void {
    this.setStatusFlag('clientApp', app);
  }

  /** Push the current per-dock status list (primary + extras); deduped, since the 2s reconnect scan calls this every tick. */
  notifyDocks(docks: DockStatus[]): void {
    if (!this.dockRegistry.update(docks)) return;
    // Drop image caches of vanished docks; fall back to the primary when the selected dock was unplugged.
    const live = new Set(docks.map((d) => d.index));
    this.imageChannel.pruneDeadDocks(live);
    this.settings.syncDockBrightness(docks);
    this.broadcastStatus();
    // Extra-key configs resolve from the (possibly changed) selected deviceKey; re-push so a replug
    // doesn't leave the client's map stale. Skipped when selectDock(0) below already covers it.
    if (this.selectedDock !== 0 && !live.has(this.selectedDock)) this.selectDock(0);
    else this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
  }

  notifyElgatoAppRunning(running: boolean): void {
    this.setStatusFlag('elgatoAppRunning', running);
  }

  notifyElgatoDevicePresent(present: boolean): void {
    this.setStatusFlag('elgatoDevicePresent', present);
  }

  notifyStats(delta: Partial<Stats>): void {
    Object.assign(this.stats, delta);
  }

  notifyDeviceModel(model: {
    id: string;
    name: string;
    keyCount: number;
    columns: number;
    rows: number;
  }): void {
    const { id: modelId, name: modelName, ...rest } = model;
    Object.assign(this.status, { modelId, modelName, ...rest });
    this.broadcastStatus();
  }

  snapshot(): StatusSnapshot {
    return {
      ...this.status,
      brightness: this.dockRegistry.selectedBrightness(),
      imageModeOverride: this.imageModeOverride,
      docks: this.dockRegistry.list(),
      selectedDock: this.selectedDock,
    };
  }

  private broadcastStatus(): void {
    this.bus.broadcast('status', this.snapshot());
  }

  /** Push the SELECTED dock's per-device values to WS clients. */
  private broadcastSelectedDeviceState(): void {
    this.bus.broadcast('brightnessOverride', { enabled: this.brightnessOverride });
    this.bus.broadcast('imageMode', { mode: this.imageModeOverride });
    this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
  }

  private handleRequest(
    req: Request,
    extra: { server: TjsServeServer },
  ): Response | Promise<Response> | void {
    const url = new URL(req.url);
    if (!isAllowedWebRequest(req.headers.get('Host'), req.headers.get('Origin'), this._port)) {
      return forbidden();
    }
    if (req.headers.get('Upgrade') === 'websocket' && url.pathname === '/api/ws') {
      extra.server.upgrade(req);
      return;
    }
    const matched = matchRoute(routes, req.method, url.pathname);
    return matched ? matched.handler({ req, url, params: matched.params, ui: this }) : notFound();
  }

  // ---- WebUIController surface consumed by the route handlers ----

  fullState(): StateResponse {
    const images: Record<string, number> = {};
    for (const [k] of this.imageState) images[String(k)] = this.imageChannel.versionFor(k);
    return {
      ...this.snapshot(),
      images,
      logs: this.activity.logs,
      commLogs: this.activity.comms,
      keyEvents: this.activity.keyEvents,
      stats: { ...this.stats, uptimeMs: Date.now() - this.startTime },
      mockConfig: this.mockConfig,
      resizeEnabled: this.resizeEnabled,
      brightnessOverride: this.brightnessOverride,
      deviceModels: this.deviceModels,
      deviceIdentity: this.settingsIdentity.identity(),
      extraKeys: this.selectedExtraKeyConfigs(),
    };
  }

  // ---- Extra keys (293S 6th column — see extra-keys.ts / extra-keys-controller.ts) ----

  extraKeyConfigFor(deviceKey: string, wireId: number): ExtraKeyConfig | undefined {
    return this.extraKeys.configFor(deviceKey, wireId);
  }

  private selectedExtraKeyConfigs(): Record<string, ExtraKeyConfig> {
    return this.extraKeys.selectedConfigs();
  }

  trySetExtraKey(wireId: number, cfg: ExtraKeyConfig): ReqError | null {
    return this.extraKeys.trySet(wireId, cfg, this.selectedDock);
  }

  tryRunExtraKeyNow(wireId: number): ReqError | null {
    return this.extraKeys.tryRunNow(wireId, this.selectedDock);
  }

  pluginsInfo(): Promise<PluginsInfo> {
    return this.extraKeys.pluginsInfo();
  }

  getOrCreateDeviceIdentity(deviceKey: string, defaultMdnsName: string): DeviceIdentitySettings {
    return this.settingsIdentity.getOrCreateIdentity(deviceKey, defaultMdnsName);
  }

  updateDeviceMdnsName(deviceKey: string, name: string): boolean {
    return this.settingsIdentity.updateMdnsName(deviceKey, name);
  }

  getImage(key: number): Buffer | undefined {
    const buf = this.imageState.get(key);
    return buf && buf.length > 0 ? buf : undefined;
  }

  applyMockConfig(parsed: Partial<MockDeviceConfig>): MockDeviceConfig {
    mergeMockConfig(this.mockConfig, parsed);
    this.bus.broadcast('mockConfig', this.mockConfig);
    this.emit('mockConfig', { ...this.mockConfig });
    return this.mockConfig;
  }

  trySimulateKey(n: number): ReqError | null {
    if (n < 0 || n >= this.status.keyCount) {
      return { error: `key index must be 0–${this.status.keyCount - 1}`, status: 400 };
    }
    if (this.status.driverMode !== 'mock') {
      return { error: 'key simulation only available in mock mode', status: 409 };
    }
    this.emit('keyPress', n);
    return null;
  }

  /** Persisted brightness for the dock at `index` — re-pushed after Elgato pairing (app.ts) so a device boots at its saved level. */
  brightnessForDock(index: number): number {
    return this.dockRegistry.brightnessFor(index);
  }

  // ---- Settings JSON surface (see settings-identity-controller.ts) ----

  getSettingsJson(): string {
    return this.settingsIdentity.json();
  }

  openSettingsFile(): Promise<void> {
    return this.settingsIdentity.openFile();
  }

  applySettingsJson(raw: string): void {
    this.settingsIdentity.applyJson(raw);
  }
}
