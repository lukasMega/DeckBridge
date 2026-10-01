import { EventEmitter } from 'node:events';
import { Broadcaster } from './broadcaster.js';
import { matchRoute } from './router.js';
import { routes } from './routes.js';
import { forbidden, json, notFound } from './http.js';
import { ExtraKeysController } from './extra-keys-controller.js';
import { ImageChannel } from './image-channel.js';
import type { ImageFormat } from './image-channel.js';
import { SettingsFileController } from './settings-file-controller.js';
import { ModelOverridesController } from './model-overrides-controller.js';
import { DockRegistry } from './dock-registry.js';
import { isAllowedWebRequest, resolveListenPort } from './web-request-guard.js';
import { ActivityBuffers } from './activity-buffers.js';
import type { RawMockInput } from './mock-input.js';
import { PersistedSettings } from '../../infra/settings.js';
import type {
  ControllerHost,
  DeviceModelInfo,
  DriverMode,
  LogLevel,
  MockDeviceConfig,
  ReqError,
  StateResponse,
  Stats,
  StatusSnapshot,
  WebUIController,
  WebUIControllers,
} from './types.js';
import type { KeyState, CommEntry, DockStatus, ClientApp } from '../../shared/types.js';
import { WEBUI_PORT, webuiBindAddr } from '../../shared/types.js';
import { StatusPublisher } from './status-publisher.js';
import { buildStateResponse, selectedDeviceIdentity } from './state-response.js';
import { LoggingController } from './logging-controller.js';
import { DevicePrefsController } from './device-prefs-controller.js';
import { EncodersController } from './encoders-controller.js';
import { liveDiagnosticsInputs, type HidInventoryFn } from './diagnostics-sources.js';
import { UpdateController } from './update-controller.js';
import { ElgatoAppController } from './elgato-app-controller.js';

export { isAllowedWebRequest, isValidMacAddress, pickFallbackPort } from './web-request-guard.js';

const mockConfigHelpers = __MOCK_BUILD__ ? await import('./mock-config.js') : null;
const mockInputHelpers = __MOCK_BUILD__ ? await import('./mock-input.js') : null;

/** HTTP/WS server of the WebUI. Routes reach the per-concern controllers directly
 *  (RouteContext); this class keeps the cross-controller state and the notify*
 *  surface the core pushes into. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class WebUIServer extends EventEmitter implements WebUIController, WebUIControllers {
  private server: TjsServeServer | null = null;
  private shuttingDown = false;
  private readonly bus = new Broadcaster();
  private readonly activity = new ActivityBuffers(this.bus);
  readonly settings: PersistedSettings;
  private readonly dockRegistry: DockRegistry;
  readonly devicePrefs: DevicePrefsController;
  readonly encoders: EncodersController;
  readonly extraKeys: ExtraKeysController;
  readonly modelOverrides: ModelOverridesController;
  readonly logging: LoggingController;
  readonly updates: UpdateController;
  readonly settingsFile: SettingsFileController;
  readonly elgatoApp: ElgatoAppController;
  private readonly controllers: WebUIControllers;
  readonly imageChannel = new ImageChannel(this.bus, () => this.selectedDock);
  get selectedDock(): number {
    return this.dockRegistry.selectedDock;
  }
  private readonly status: StatusPublisher;
  private readonly stats: Stats = { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 };
  private readonly startTime = Date.now();
  setLocalIp(ip: string): void {
    this.status.setLocalIp(ip);
  }
  private _port: number;
  /** Injected by app.ts once discovery exists; reports show the error until then. */
  private hidInventory: HidInventoryFn = () =>
    Promise.reject(new Error('HID inventory not available'));

  setHidInventory(fn: HidInventoryFn): void {
    this.hidInventory = fn;
  }

  get port(): number {
    return this._port;
  }
  private readonly deviceModels: DeviceModelInfo[];
  declare private mockConfig: MockDeviceConfig | undefined;
  declare applyMockConfig: (parsed: Partial<MockDeviceConfig>) => MockDeviceConfig;
  declare trySimulateKey: (n: number) => ReqError | null;
  declare trySimulateInput: (raw: RawMockInput) => ReqError | null;

  constructor(
    port = WEBUI_PORT,
    deviceModels: DeviceModelInfo[] = [],
    initialDriverMode: DriverMode = 'real',
    settings: PersistedSettings = new PersistedSettings(),
  ) {
    super();
    this._port = port;
    if (__MOCK_BUILD__) this.mockConfig = mockConfigHelpers!.defaultMockConfig();
    this.deviceModels = deviceModels;
    this.settings = settings;
    this.dockRegistry = new DockRegistry(this.settings);
    this.status = new StatusPublisher(
      () => ({
        brightness: this.dockRegistry.selectedBrightness(),
        docks: this.dockRegistry.list(),
        selectedDock: this.selectedDock,
      }),
      (event, payload) => this.bus.broadcast(event, payload),
      initialDriverMode,
    );
    const host: ControllerHost = {
      settings: this.settings,
      emit: (event, ...args) => this.emit(event, ...args),
      broadcast: (event, payload) => this.bus.broadcast(event, payload),
      selectedDeviceKey: () => this.dockRegistry.selectedDeviceKey(),
      selectedDock: () => this.selectedDock,
      selectedDockStatus: () => this.dockRegistry.selectedStatus(),
      trySelectDock: (index) => this.trySelectDock(index),
      broadcastSelected: () => this.broadcastSelectedDeviceState(),
    };
    this.devicePrefs = new DevicePrefsController(host, () =>
      this.dockRegistry.selectedBrightness(),
    );
    this.extraKeys = new ExtraKeysController(host, (wireId) =>
      this.imageChannel.selectedWidgetPaint(wireId),
    );
    this.encoders = new EncodersController(host);
    this.modelOverrides = new ModelOverridesController(
      host,
      () => this.dockRegistry.selectedStatus()?.modelId ?? this.status.modelId,
    );
    this.logging = new LoggingController(host, () =>
      liveDiagnosticsInputs({
        cacheRoot: this.settings.cacheRoot,
        logPath: this.logging.path(),
        logLevel: this.logging.level(),
        uptimeMs: Date.now() - this.startTime,
        overrides: this.modelOverrides,
        state: this.fullState(),
        activity: this.activity,
        settingsJson: this.settings.json(),
        inventory: () => this.hidInventory(),
      }),
    );
    this.updates = new UpdateController(host, __VERSION__);
    this.settingsFile = new SettingsFileController(host, this.logging);
    this.elgatoApp = new ElgatoAppController(host);
    this.controllers = {
      settings: this.settings,
      devicePrefs: this.devicePrefs,
      encoders: this.encoders,
      extraKeys: this.extraKeys,
      modelOverrides: this.modelOverrides,
      logging: this.logging,
      updates: this.updates,
      settingsFile: this.settingsFile,
      elgatoApp: this.elgatoApp,
    };
    if (__MOCK_BUILD__) {
      this.applyMockConfig = (parsed) => {
        const config = this.mockConfig!;
        mockConfigHelpers!.mergeMockConfig(config, parsed);
        this.bus.broadcast('mockConfig', config);
        this.emit('mockConfig', { ...config });
        return config;
      };
      this.trySimulateKey = (n) => {
        const invalid = mockConfigHelpers!.validateSimulatedKey(
          n,
          this.status.keyCount,
          this.status.driverMode,
        );
        if (invalid) return invalid;
        this.emit('keyPress', n);
        return null;
      };
      this.trySimulateInput = (raw) => {
        const checked = mockInputHelpers!.checkMockInput(
          raw,
          this.dockRegistry.selectedStatus(),
          this.status.driverMode,
        );
        if ('error' in checked) return checked;
        this.emit('mockInput', checked.input);
        return null;
      };
    }
  }

  // Settings are loaded by app.ts before construction.
  async start(): Promise<void> {
    this._port = await resolveListenPort(this._port);
    this.server = tjs.serve({
      port: this._port,
      listenIp: webuiBindAddr(),
      fetch: (req, extra) => this.handleRequest(req, extra),
      websocket: this.bus.websocketHandlers((ws) => {
        this.bus.sendTo(ws, 'status', this.snapshot());
        this.imageChannel.sendSnapshot(ws);
      }),
    });

    this.bus.start(() => {
      this.stats.uptimeMs = Date.now() - this.startTime;
      this.bus.broadcast('stats', this.stats);
    });
  }

  /** Synchronous, from shutdown's quiesce: later mutations would race the final settings write. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async stop(): Promise<void> {
    this.activity.stop();
    this.bus.stop();
    const server = this.server;
    this.server = null;
    await server?.close();
  }

  hasClients(): boolean {
    return this.bus.size > 0;
  }

  /** `wireId` (raw device code, pre-keyMap) is what key-map learn mode records. */
  notifyDeviceAction(dockIndex: number, message: string): void {
    this.bus.broadcast('deviceAction', { dockIndex, message });
  }

  notifyKeyEvent(mk2Index: number, state: KeyState, wireId?: number): void {
    this.activity.keyEvent(mk2Index, state, wireId);
  }

  notifyComm(entry: Omit<CommEntry, 'ts'>): void {
    this.activity.comm(entry);
  }

  log(level: LogLevel, component: string, message: string): void {
    this.activity.log(level, component, message);
  }

  notifyDockImage(dock: number, mk2Index: number, data: Buffer, fmt: ImageFormat = 'jpeg'): void {
    this.imageChannel.notifyDockImage(dock, mk2Index, data, fmt);
  }

  selectDock(index: number): void {
    if (index === this.selectedDock) return;
    this.dockRegistry.selectedDock = index;
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

  /** Drop one dock's cached frames (model change / disconnect); the browser clears
   *  its previews when that dock is the one shown. */
  resetImages(dock = 0): void {
    if (this.imageChannel.reset(dock)) this.bus.broadcast('imagesReset', {});
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

  notifyClientApp(app: ClientApp): void {
    this.status.setFlag('clientApp', app);
  }

  /** Push the current per-dock status list (primary + extras); deduped, since the 3s reconnect scan calls this every tick. */
  notifyDocks(docks: DockStatus[]): void {
    if (!this.dockRegistry.update(docks)) return;
    // Drop image caches of vanished docks; fall back to the primary when the selected dock was unplugged.
    const live = new Set(docks.map((d) => d.index));
    this.imageChannel.pruneDeadDocks(live);
    this.settings.syncDockBrightness(docks);
    this.status.publish();
    // Re-push per-device values after a replug (the selected deviceKey may have changed); selectDock(0) covers it too.
    if (this.selectedDock !== 0 && !live.has(this.selectedDock)) this.selectDock(0);
    else this.broadcastSelectedDeviceState();
  }

  notifyElgatoAppConflict(conflict: boolean): void {
    this.status.setFlag('elgatoAppConflict', conflict);
  }

  notifyElgatoDevicePresent(present: boolean): void {
    this.status.setFlag('elgatoDevicePresent', present);
  }

  notifyStats(delta: Partial<Stats>): void {
    Object.assign(this.stats, delta);
  }

  notifyDeviceModel(model: Parameters<StatusPublisher['setDeviceModel']>[0]): void {
    this.status.setDeviceModel(model);
  }

  snapshot(): StatusSnapshot {
    return this.status.snapshot();
  }

  private broadcastSelectedDeviceState(): void {
    this.devicePrefs.broadcastSelected(this.extraKeys.selectedConfigs());
    this.encoders.broadcastSelected();
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
    // The WS is broadcast-only, so HTTP is the only mutation path.
    if (this.shuttingDown && url.pathname.startsWith('/api/') && !SAFE_METHODS.has(req.method)) {
      return json({ error: 'shutting down' }, 503);
    }
    const matched = matchRoute(routes, req.method, url.pathname);
    if (!matched) return notFound();
    return matched.handler({ ...this.controllers, req, url, params: matched.params, ui: this });
  }

  fullState(): StateResponse {
    const selected = this.dockRegistry.selectedStatus();
    return buildStateResponse({
      snapshot: this.snapshot(),
      activity: this.activity,
      stats: { ...this.stats, uptimeMs: Date.now() - this.startTime },
      ...(__MOCK_BUILD__ ? { mockConfig: this.mockConfig } : {}),
      brightnessOverride: this.devicePrefs.brightnessOverride,
      deviceModels: this.deviceModels,
      deviceIdentity: selectedDeviceIdentity(
        this.status.driverMode,
        __MOCK_BUILD__ ? this.mockConfig : undefined,
        selected,
      ),
      realDeviceIdentity: selected?.realDeviceIdentity,
      extraKeys: this.extraKeys.selectedConfigs(),
      ...this.devicePrefs.touchStripState(),
      encoders: this.encoders.selected(),
      logLevel: this.logging.level(),
      logFilePath: this.logging.path(),
      multiDeck: this.settings.multiDeck,
      updateInfo: this.updates.info(),
      elgatoAutoRestart: this.elgatoApp.state(),
    });
  }
}
