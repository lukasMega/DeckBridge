import { EventEmitter } from 'node:events';
import { Broadcaster } from './broadcaster.js';
import { matchRoute } from './router.js';
import { routes } from './routes.js';
import { forbidden, notFound } from './http.js';
import type { DeviceIdentitySettings } from '../../settings-store.js';
import { ExtraKeysController } from './extra-keys-controller.js';
import { ImageChannel } from './image-channel.js';
import type { ImageFormat, DockFrame } from './image-channel.js';
import { SettingsIdentityController } from './settings-identity-controller.js';
import { ModelOverridesController } from './model-overrides-controller.js';
import type { DeviceOverridesView } from './model-overrides-controller.js';
import type { DeviceModelOverride } from '../../devices/driver.js';
import { DockRegistry } from './dock-registry.js';
import { isAllowedWebRequest, resolveListenPort } from './web-request-guard.js';
import { ActivityBuffers } from './activity-buffers.js';
import { defaultMockConfig, mergeMockConfig, validateSimulatedKey } from './mock-config.js';
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
import { WEBUI_PORT, webuiBindAddr } from '../../types.js';
import { StatusPublisher } from './status-publisher.js';
import { buildStateResponse } from './state-response.js';
import { LoggingController } from './logging-controller.js';
import { DevicePrefsController } from './device-prefs-controller.js';
import { liveDiagnosticsInputs } from './diagnostics-sources.js';
import type { DiagnosticsOptions } from './diagnostics.js';

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
  private readonly modelOverrides: ModelOverridesController;
  private readonly logging: LoggingController;
  private readonly devicePrefs: DevicePrefsController;
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

  // brightness/brightnessOverride/imageModeOverride live per-device in
  // settings.devices[] — see device-prefs-controller.ts.
  get brightnessOverride(): boolean {
    return this.devicePrefs.brightnessOverride;
  }
  isBrightnessOverride(deviceKey: string): boolean {
    return this.devicePrefs.isBrightnessOverride(deviceKey);
  }
  /** Same, by dock index (app.ts's Elgato→primary brightness gate). */
  isBrightnessOverrideForDock(index: number): boolean {
    return this.devicePrefs.isBrightnessOverride(this.dockRegistry.deviceKeyFor(index));
  }
  get imageModeOverride(): ImageModeOverride {
    return this.devicePrefs.imageModeOverride;
  }

  private readonly status: StatusPublisher;
  private readonly stats: Stats = { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 };
  private readonly startTime = Date.now();
  setLocalIp(ip: string): void {
    this.status.setLocalIp(ip);
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
    private readonly settingsCacheRoot?: string,
  ) {
    super();
    this._port = port;
    this.deviceModels = deviceModels;
    this.settings = new PersistedSettings(settingsCacheRoot);
    this.dockRegistry = new DockRegistry(this.settings);
    this.status = new StatusPublisher(
      () => ({
        brightness: this.dockRegistry.selectedBrightness(),
        imageModeOverride: this.imageModeOverride,
        docks: this.dockRegistry.list(),
        selectedDock: this.selectedDock,
      }),
      (event, payload) => this.bus.broadcast(event, payload),
      initialDriverMode,
    );
    this.devicePrefs = new DevicePrefsController(
      this.settings,
      () => this.dockRegistry.selectedDeviceKey(),
      () => this.selectedDock,
      () => this.dockRegistry.selectedBrightness(),
      (event, payload) => this.bus.broadcast(event, payload),
      (event, ...args) => this.emit(event, ...args),
    );
    this.extraKeys = new ExtraKeysController(
      this.settings,
      this.bus,
      () => this.dockRegistry.selectedDeviceKey(),
      () => this.dockRegistry.selectedStatus(),
      (event, ...args) => this.emit(event, ...args),
    );
    this.settingsIdentity = new SettingsIdentityController(
      (level) => this.trySetLogLevel(level),
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
    this.modelOverrides = new ModelOverridesController(
      this.settings,
      () => this.status.modelId,
      (event, ...args) => this.emit(event, ...args),
    );
    this.logging = new LoggingController(
      this.settings,
      () =>
        liveDiagnosticsInputs({
          cacheRoot: this.settingsCacheRoot,
          logPath: this.logFilePath(),
          logLevel: this.logLevel(),
          uptimeMs: Date.now() - this.startTime,
          overrides: this.modelOverrides,
          state: this.fullState(),
          activity: this.activity,
          settingsJson: this.getSettingsJson(),
        }),
      (event, payload) => this.bus.broadcast(event, payload),
      (event, ...args) => this.emit(event, ...args),
    );
  }

  // Device tuning (model overrides) — see devices/model-overrides.ts

  /** Read by DriverManager at probe time; undefined = registry defaults. */
  modelOverrideFor(modelId: string): DeviceModelOverride | undefined {
    return this.modelOverrides.overrideFor(modelId);
  }

  /** Every persisted override, for the diagnostics bundle's loud section. */
  allModelOverrides(): Record<string, DeviceModelOverride> {
    return this.modelOverrides.all();
  }

  deviceOverridesView(modelId?: unknown): DeviceOverridesView | ReqError {
    return this.modelOverrides.view(modelId);
  }

  trySetModelOverride(modelId: unknown, overrides: unknown): ReqError | null {
    return this.modelOverrides.trySet(modelId, overrides);
  }

  tryResetModelOverride(modelId: unknown): ReqError | null {
    return this.modelOverrides.tryReset(modelId);
  }

  // `listen = false` (--no-webui): settings still load (identity/brightness/extra-keys must work
  // headless too), but the HTTP/WS listener + broadcast timers never start — notify*/log/snapshot become no-ops.
  async start(listen = true): Promise<void> {
    await this.settings.load(); // direct load — no broadcasts/hardware events fire before anything listens
    // app.ts already applied the persisted level before startup (it re-reads
    // settings.json to get it in force from the first log line); this only
    // mirrors the resolved value for /api/state.
    if (!listen) return;
    this._port = await resolveListenPort(this._port);
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

  /** `wireId` (raw device code, pre-keyMap) is what key-map learn mode records. */
  notifyKeyEvent(mk2Index: number, state: KeyState, wireId?: number): void {
    this.activity.keyEvent(mk2Index, state, wireId);
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

  notifyDockImage(dock: number, mk2Index: number, data: Buffer, fmt: ImageFormat = 'jpeg'): void {
    this.imageChannel.notifyDockImage(dock, mk2Index, data, fmt);
  }

  dockFramesSnapshot(dock: number): Map<number, DockFrame> {
    return this.imageChannel.dockFramesSnapshot(dock);
  }

  /** Switch the live preview to another dock: swap in its cached frames and replay them. */
  selectDock(index: number): void {
    if (index === this.selectedDock) return;
    this.dockRegistry.selectedDock = index;
    this.imageChannel.clearLive();
    this.status.publish();
    // Per-device values aren't in the status snapshot — re-push the new dock's to keep slider/toggles in sync.
    this.devicePrefs.broadcastBrightness(this.dockRegistry.selectedBrightness());
    this.broadcastSelectedDeviceState();
    this.settings.persist();
    this.imageChannel.replay(index);
  }

  /** Validate + apply a select-dock request from the WebUI. */
  trySelectDock(index: unknown): ReqError | null {
    const invalid = this.dockRegistry.validateSelect(index);
    if (invalid) return invalid;
    this.selectDock(index as number);
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

  notifyBrightnessOverride(enabled: boolean): void {
    this.devicePrefs.setBrightnessOverride(enabled);
  }

  notifyImageMode(mode: ImageModeOverride): void {
    this.devicePrefs.setImageMode(mode);
  }

  notifyBrightness(level: number): void {
    this.devicePrefs.broadcastBrightness(level);
  }

  notifyDriverStatus(mode: DriverMode, connected: boolean): void {
    this.status.setDriverStatus(mode, connected);
  }

  notifyElgatoStatus(connected: boolean, remoteAddr?: string): void {
    this.status.setElgatoStatus(connected, remoteAddr);
  }

  /** Which CORA client (Elgato app vs Bitfocus Companion) was detected. Reset to 'unknown' on disconnect. */
  notifyClientApp(app: ClientApp): void {
    this.status.setFlag('clientApp', app);
  }

  /** Push the current per-dock status list (primary + extras); deduped, since the 2s reconnect scan calls this every tick. */
  notifyDocks(docks: DockStatus[]): void {
    if (!this.dockRegistry.update(docks)) return;
    // Drop image caches of vanished docks; fall back to the primary when the selected dock was unplugged.
    const live = new Set(docks.map((d) => d.index));
    this.imageChannel.pruneDeadDocks(live);
    this.settings.syncDockBrightness(docks);
    this.status.publish();
    // Extra-key configs resolve from the (possibly changed) selected deviceKey; re-push so a replug
    // doesn't leave the client's map stale. Skipped when selectDock(0) below already covers it.
    if (this.selectedDock !== 0 && !live.has(this.selectedDock)) this.selectDock(0);
    else this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
  }

  notifyElgatoAppRunning(running: boolean): void {
    this.status.setFlag('elgatoAppRunning', running);
  }

  notifyElgatoDevicePresent(present: boolean): void {
    this.status.setFlag('elgatoDevicePresent', present);
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
    this.status.setDeviceModel(model);
  }

  snapshot(): StatusSnapshot {
    return this.status.snapshot();
  }

  private broadcastSelectedDeviceState(): void {
    this.devicePrefs.broadcastSelected(this.selectedExtraKeyConfigs());
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

  // WebUIController surface consumed by the route handlers
  fullState(): StateResponse {
    return buildStateResponse({
      snapshot: this.snapshot(),
      imageVersions: this.imageChannel,
      imageKeys: this.imageState.keys(),
      activity: this.activity,
      stats: { ...this.stats, uptimeMs: Date.now() - this.startTime },
      mockConfig: this.mockConfig,
      resizeEnabled: this.resizeEnabled,
      brightnessOverride: this.brightnessOverride,
      deviceModels: this.deviceModels,
      deviceIdentity: this.settingsIdentity.identity(),
      realDeviceIdentity: this.dockRegistry.selectedStatus()?.realDeviceIdentity,
      extraKeys: this.selectedExtraKeyConfigs(),
      logLevel: this.logLevel(),
      logFilePath: this.logFilePath(),
    });
  }

  // Extra keys (293S 6th column — see extra-keys.ts / extra-keys-controller.ts)

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
    const invalid = validateSimulatedKey(n, this.status.keyCount, this.status.driverMode);
    if (invalid) return invalid;
    this.emit('keyPress', n);
    return null;
  }

  /** Persisted brightness for the dock at `index` — re-pushed after Elgato pairing (app.ts) so a device boots at its saved level. */
  brightnessForDock(index: number): number {
    return this.dockRegistry.brightnessFor(index);
  }

  // Settings JSON surface (see settings-identity-controller.ts)

  getSettingsJson(): string {
    return this.settingsIdentity.json();
  }

  openSettingsFile(): Promise<void> {
    return this.settingsIdentity.openFile();
  }

  applySettingsJson(raw: string): void {
    this.settingsIdentity.applyJson(raw);
  }

  // Logging + diagnostics (see logging-controller.ts / docs/troubleshooting.md)

  trySetLogLevel(level: unknown): ReqError | null {
    return this.logging.trySetLevel(level);
  }

  logLevel(): string {
    return this.logging.level();
  }

  logFilePath(): string {
    return this.logging.path();
  }

  openLogsFolder(): Promise<void> {
    return this.logging.openFolder();
  }

  buildDiagnosticsReport(opt: DiagnosticsOptions = {}): Promise<string> {
    return this.logging.buildReport(opt);
  }

  async saveDiagnosticsReport(opt: DiagnosticsOptions = {}): Promise<string | null> {
    const path = await this.logging.saveReport(opt);
    if (path === null) this.log('error', 'webui', 'diagnostics save failed');
    return path;
  }
}
