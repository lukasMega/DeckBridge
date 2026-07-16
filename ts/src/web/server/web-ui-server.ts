import { EventEmitter } from 'node:events';
import { Broadcaster } from './broadcaster.js';
import { matchRoute } from './router.js';
import { routes } from './routes.js';
import { forbidden, notFound } from './http.js';
import { DEFAULT_MODEL } from '../../devices/registry.js';
import { loadSettings, saveSettings, settingsPath, pluginsDir } from '../../settings-store.js';
import type { Settings, DeviceIdentitySettings } from '../../settings-store.js';
import { listPluginFiles, pluginKeyStatus } from '../../plugin-host.js';
import type { PluginStatus } from '../../plugin-host.js';
import { openPathInOS } from '../../os-utils.ts';
import {
  getOrCreateDeviceIdentity as getOrCreateDeviceIdentityPure,
  isStableDeviceKey,
} from '../../device-identity.js';
import {
  FALLBACK_PORT_ATTEMPTS,
  isAllowedWebRequest,
  isPortInUse,
  isValidMacAddress,
  pickFallbackPort,
} from './web-request-guard.js';
import type {
  DeviceIdentity,
  DeviceModelInfo,
  DriverMode,
  KeyEventEntry,
  LogEntry,
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
import {
  isExtraKeyConfig,
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  DEFAULT_MAC_ADDRESS_STRING,
  MDNS_SERVICE_NAME,
  WEBUI_PORT,
  WEBUI_LISTEN_ADDRESS,
  KEY_EVENT_BUFFER_MAX,
  COMM_BUFFER_MAX,
  COMM_BROADCAST_FLUSH_MS,
  LOG_BUFFER_MAX,
  DEFAULT_BRIGHTNESS,
  DEFAULT_BRIGHTNESS_OVERRIDE,
  MOCK_FW_VERSION_MAX_LEN,
  MOCK_SERIAL_MAX_LEN,
  MOCK_PRODUCT_ID_MASK,
} from '../../types.js';

export { isAllowedWebRequest, isValidMacAddress, pickFallbackPort } from './web-request-guard.js';

const IMAGE_MODE_SETTINGS = [null, 'resize', 'pad-black', 'pad-average', 'pad-edge'];

/** Shape guard for a persisted/imported extraKeys map (wire id → config). */
function isExtraKeysRecord(v: unknown): v is Record<string, ExtraKeyConfig> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every(isExtraKeyConfig);
}

/** Migration: extra-key entries were action-based ({action, …}) before the
 *  widget model (2026-07-16). Strip a stale/corrupt map so it can't fail
 *  isDeviceIdentitySettings and drop the whole identity entry (which would
 *  regenerate MAC/serial and force an Elgato re-pair). */
function stripInvalidExtraKeys(d: unknown): void {
  if (typeof d !== 'object' || d === null) return;
  const r = d as Record<string, unknown>;
  if (r.extraKeys !== undefined && !isExtraKeysRecord(r.extraKeys)) delete r.extraKeys;
}

/** Shape guard for a persisted/imported `devices` entry: the identity fields are
 *  required strings; the per-device settings (brightness/override/imageMode) are
 *  optional but, when present, must be well-typed (used on both disk load and
 *  raw-JSON import, so a corrupt entry can't poison runtime state). */
function isDeviceIdentitySettings(d: unknown): d is DeviceIdentitySettings {
  if (typeof d !== 'object' || d === null) return false;
  const r = d as Record<string, unknown>;
  return (
    typeof r.deviceKey === 'string' &&
    typeof r.mdnsServiceName === 'string' &&
    typeof r.macAddress === 'string' &&
    typeof r.dockSerial === 'string' &&
    typeof r.childSerial === 'string' &&
    hasValidDeviceSettings(r)
  );
}

/** The optional per-device settings half of isDeviceIdentitySettings. */
function hasValidDeviceSettings(r: Record<string, unknown>): boolean {
  return (
    (r.brightness === undefined || typeof r.brightness === 'number') &&
    (r.brightnessOverride === undefined || typeof r.brightnessOverride === 'boolean') &&
    (r.imageModeOverride === undefined ||
      IMAGE_MODE_SETTINGS.includes(r.imageModeOverride as null)) &&
    (r.extraKeys === undefined || isExtraKeysRecord(r.extraKeys))
  );
}

export class WebUIServer extends EventEmitter implements WebUIController {
  private server: TjsServeServer | null = null;
  private readonly bus = new Broadcaster();

  readonly imageState = new Map<number, Buffer>();
  /** Per-key wire format of the last CORA frame, set in `notifyImageUpdate`.
   *  Used to repaint with the right format after an image-mode override. */
  readonly imageFormat = new Map<number, 'jpeg' | 'bmp'>();
  private readonly imageVersion = new Map<number, number>();
  /** Per-dock cache of the last raw CORA frame per key. `imageState`/the WS
   *  image channel always show the SELECTED dock; this cache makes switching
   *  the selection instant (the Elgato app never re-pushes unprompted). */
  private readonly dockImages = new Map<
    number,
    Map<number, { data: Buffer; format: 'jpeg' | 'bmp' }>
  >();
  private _selectedDock = 0;
  get selectedDock(): number {
    return this._selectedDock;
  }
  resizeEnabled = true;
  // brightness/brightnessOverride/imageModeOverride are per-device now: the live
  // value lives in devices[] keyed by the selected dock's deviceKey, and is
  // exposed for the WebUI via the getters below. These two hold the fallback for
  // the case with NO deviceKey (mock mode / before any device connects) — never
  // persisted, so mock stays runtime-only. See 2026-07-15_per-device-settings.md.
  private runtimeBrightnessOverride = DEFAULT_BRIGHTNESS_OVERRIDE;
  private runtimeImageModeOverride: ImageModeOverride = null;

  /** brightnessOverride of the SELECTED dock (for the WebUI toggle). */
  get brightnessOverride(): boolean {
    return this.isBrightnessOverride(this.selectedDeviceKey());
  }
  /** brightnessOverride for a specific device — read by the Elgato-brightness
   *  ignore closures in DriverManager/DeviceSession (per dock, not global). */
  isBrightnessOverride(deviceKey: string): boolean {
    const e = this.deviceEntryFor(deviceKey);
    return e
      ? (e.brightnessOverride ?? DEFAULT_BRIGHTNESS_OVERRIDE)
      : this.runtimeBrightnessOverride;
  }
  /** brightnessOverride for the dock at `index` (used by app.ts's Elgato→primary
   *  brightness gate). */
  isBrightnessOverrideForDock(index: number): boolean {
    return this.isBrightnessOverride(this.deviceKeyForDock(index));
  }
  /** imageModeOverride of the SELECTED dock; null = use the model default. */
  get imageModeOverride(): ImageModeOverride {
    const e = this.deviceEntryFor(this.selectedDeviceKey());
    return e ? (e.imageModeOverride ?? null) : this.runtimeImageModeOverride;
  }
  private driverMode: DriverMode = 'real';
  private driverConnected = false;
  private elgatoConnected = false;
  private elgatoRemoteAddr: string | null = null;
  private clientApp: ClientApp = 'unknown';
  private docks: DockStatus[] = [];
  private readonly logBuffer: LogEntry[] = [];
  private readonly commBuffer: CommEntry[] = [];
  private readonly commFlushQueue: CommEntry[] = [];
  private commFlushTimer: number | null = null;
  private readonly keyEventBuffer: KeyEventEntry[] = [];
  private readonly stats: Stats = { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 };
  private elgatoAppRunning = false;
  private elgatoDevicePresent = false;
  private readonly startTime = Date.now();
  private _localIp = '127.0.0.1';
  setLocalIp(ip: string): void {
    this._localIp = ip;
  }
  private _port: number;
  get port(): number {
    return this._port;
  }
  private readonly deviceModels: DeviceModelInfo[];
  private modelId = DEFAULT_MODEL.id;
  private modelName = DEFAULT_MODEL.name;
  private keyCount = DEFAULT_MODEL.keyCount;
  private columns = DEFAULT_MODEL.columns;
  private rows = DEFAULT_MODEL.rows;
  private mockConfig: MockDeviceConfig = {
    dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
    childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
    serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
    childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
    productId: DEFAULT_MODEL.cora.productId,
    macAddress: DEFAULT_MAC_ADDRESS_STRING,
  };

  // Overridable so tests never read/write the real user cache dir; production
  // callers leave it undefined and settings-store.ts picks the default.
  private readonly settingsCacheRoot?: string;

  // Per-physical-device identity (mac/serials/mdns name), keyed by
  // device-identity.ts's deviceKeyFor(). WebUIServer is the sole settings.json
  // writer, so DriverManager/DeviceSession resolve identities through
  // getOrCreateDeviceIdentity() below rather than touching disk themselves.
  private devices: DeviceIdentitySettings[] = [];

  constructor(
    port = WEBUI_PORT,
    deviceModels: DeviceModelInfo[] = [],
    initialDriverMode: DriverMode = 'real',
    settingsCacheRoot?: string,
  ) {
    super();
    this._port = port;
    this.deviceModels = deviceModels;
    this.driverMode = initialDriverMode;
    this.settingsCacheRoot = settingsCacheRoot;
  }

  async start(): Promise<void> {
    await this.loadPersistedSettings();
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
      host: WEBUI_LISTEN_ADDRESS,
      fetch: (req, extra) => this.handleRequest(req, extra),
      websocket: this.bus.websocketHandlers((ws) => this.bus.sendTo(ws, 'status', this.snapshot())),
    });

    this.bus.start(() => {
      this.stats.uptimeMs = Date.now() - this.startTime;
      this.bus.broadcast('stats', this.stats);
    });
  }

  // Keep async: callers chain `stop().catch(...)` on the returned promise, so a synchronous
  // throw from this.server?.stop() surfaces as a rejection instead of escaping the call.
  // eslint-disable-next-line @typescript-eslint/require-await -- intentional async (see above)
  async stop(): Promise<void> {
    this.stopCommFlush();
    this.commFlushQueue.length = 0;
    this.bus.stop();
    this.server?.stop();
    this.server = null;
  }

  private stopCommFlush(): void {
    if (this.commFlushTimer !== null) {
      clearInterval(this.commFlushTimer);
      this.commFlushTimer = null;
    }
  }

  /** True if at least one WebUI WS client is connected. */
  hasClients(): boolean {
    return this.bus.size > 0;
  }

  notifyKeyEvent(mk2Index: number, state: KeyState): void {
    const entry: KeyEventEntry = { ts: Date.now(), mk2Index, state };
    this.keyEventBuffer.push(entry);
    if (this.keyEventBuffer.length > KEY_EVENT_BUFFER_MAX) this.keyEventBuffer.shift();
    this.bus.broadcast('keyEvent', entry);
  }

  notifyImageUpdate(mk2Index: number, data: Buffer, format: 'jpeg' | 'bmp' = 'jpeg'): void {
    this.imageState.set(mk2Index, data);
    this.imageFormat.set(mk2Index, format);
    const v = this.bumpVersion(mk2Index);
    // Skip the base64 encode + JSON.stringify entirely when no browser is open.
    // State is updated above so new WS clients receive the correct version
    // number in their initial snapshot. With N clients the encoded string is
    // built once here and reused by Broadcaster.send() for all N sendText calls.
    if (this.bus.size === 0) return;
    this.bus.broadcast('image', { mk2Index, v, data: data.toString('base64'), format });
  }

  /** Dock-aware image mirror: always cache the frame for its dock; feed the
   *  live channel (state + broadcast) only when that dock is selected. */
  notifyDockImage(
    dock: number,
    mk2Index: number,
    data: Buffer,
    format: 'jpeg' | 'bmp' = 'jpeg',
  ): void {
    let cache = this.dockImages.get(dock);
    if (!cache) {
      cache = new Map();
      this.dockImages.set(dock, cache);
    }
    cache.set(mk2Index, { data, format });
    if (dock === this._selectedDock) this.notifyImageUpdate(mk2Index, data, format);
  }

  /** Snapshot of a dock's cached raw CORA frames (for repaint-on-replug).
   *  Returns a fresh map; buffers are shared and treated as immutable. Empty
   *  when nothing is cached for that dock. */
  dockFramesSnapshot(dock: number): Map<number, { data: Buffer; format: 'jpeg' | 'bmp' }> {
    return new Map(this.dockImages.get(dock) ?? []);
  }

  /** Switch the live preview channel to another dock: swap in its cached
   *  frames and replay them to connected clients (clients clear their grid on
   *  the selectedDock change in the status broadcast). */
  selectDock(index: number): void {
    if (index === this._selectedDock) return;
    this._selectedDock = index;
    // brightness/override/imageMode shown in the WebUI resolve from the newly
    // selected dock's device entry (see the getters), so no field to re-sync
    // here — just repaint and persist the selection itself.
    this.imageState.clear();
    this.imageFormat.clear();
    this.bus.broadcast('status', this.snapshot());
    // brightness/override/imageMode are per-device and the client tracks them in
    // dedicated store fields (not the status snapshot), so re-push the newly
    // selected dock's values to keep the slider + toggles in sync.
    this.bus.broadcast('brightness', { level: this.selectedBrightness() });
    this.bus.broadcast('brightnessOverride', { enabled: this.brightnessOverride });
    this.bus.broadcast('imageMode', { mode: this.imageModeOverride });
    this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
    this.persistSettings();
    const cache = this.dockImages.get(index);
    if (!cache) return;
    for (const [key, { data, format }] of cache) this.notifyImageUpdate(key, data, format);
  }

  /** Validate + apply a select-dock request from the WebUI. */
  trySelectDock(index: unknown): { error: string; status: number } | null {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return { error: 'index must be a non-negative integer', status: 400 };
    }
    if (index !== 0 && !this.docks.some((d) => d.index === index)) {
      return { error: `no dock with index ${index}`, status: 404 };
    }
    this.selectDock(index);
    return null;
  }

  /** Explicit "repaint everything" signal (e.g. after a brightness change),
   *  decoupled from the per-key image-update path. */
  notifyRepaint(): void {
    this.bus.broadcast('repaint', {});
  }

  /** Drop the cached per-key images of one dock (model change / disconnect);
   *  clears the live channel too when that dock is the selected one. */
  resetImages(dock = 0): void {
    this.dockImages.delete(dock);
    if (dock !== this._selectedDock) return;
    this.imageState.clear();
    this.imageVersion.clear();
    this.imageFormat.clear();
    this.notifyRepaint();
  }

  notifyResizeToggle(enabled: boolean): void {
    this.resizeEnabled = enabled;
    this.bus.broadcast('resizeToggle', { enabled });
    this.emit('regenPreviews', enabled);
  }

  // brightnessOverride/imageMode mutations target the SELECTED dock's device
  // entry (persisted, keyed by deviceKey); with no deviceKey (mock / pre-connect)
  // they fall back to the runtime-only fields so mock still toggles at runtime.
  notifyBrightnessOverride(enabled: boolean): void {
    const e = this.deviceEntryFor(this.selectedDeviceKey());
    if (e) {
      e.brightnessOverride = enabled;
      this.persistSettings();
    } else {
      this.runtimeBrightnessOverride = enabled;
    }
    this.bus.broadcast('brightnessOverride', { enabled });
    // Re-assert our brightness on the selected dock so a freshly enabled override
    // wins over whatever the Elgato app last pushed.
    if (enabled) this.emit('setBrightness', this.selectedBrightness(), this._selectedDock);
  }

  /** Per-device image-mode override for the selected dock: store, broadcast, and
   *  let app.ts apply it to that dock's driver + repaint via 'setImageOverride'. */
  notifyImageMode(mode: ImageModeOverride): void {
    const e = this.deviceEntryFor(this.selectedDeviceKey());
    if (e) {
      e.imageModeOverride = mode;
      this.persistSettings();
    } else {
      this.runtimeImageModeOverride = mode;
    }
    this.bus.broadcast('imageMode', { mode });
    this.emit('setImageOverride', mode, this._selectedDock);
  }

  // Broadcast-only: brightness is persisted per-device via notifyDocks (which
  // sees every dock's deviceKey + live value); this just pushes the selected
  // dock's slider value to WS clients.
  notifyBrightness(level: number): void {
    this.bus.broadcast('brightness', { level });
  }

  notifyDriverStatus(mode: DriverMode, connected: boolean): void {
    this.driverMode = mode;
    this.driverConnected = connected;
    this.bus.broadcast('status', this.snapshot());
  }

  notifyElgatoStatus(connected: boolean, remoteAddr?: string): void {
    this.elgatoConnected = connected;
    this.elgatoRemoteAddr = remoteAddr ?? null;
    if (!connected) this.clientApp = 'unknown';
    this.bus.broadcast('status', this.snapshot());
  }

  /** Which CORA client (Elgato app vs Bitfocus Companion) we detected on the
   *  current session, from a client-specific query observed on the primary
   *  or child server. Reset to 'unknown' on disconnect. */
  notifyClientApp(app: ClientApp): void {
    if (this.clientApp === app) return;
    this.clientApp = app;
    this.bus.broadcast('status', this.snapshot());
  }

  /** Push the current per-dock status list (primary + extras). Deduped against
   *  the previous list — the 2s reconnect scan calls getDockStatuses() on
   *  every tick, and an unchanged shape must not spam a broadcast. */
  notifyDocks(docks: DockStatus[]): void {
    if (JSON.stringify(docks) === JSON.stringify(this.docks)) return;
    this.docks = docks;
    // Drop image caches of docks that vanished; fall back to the primary when
    // the selected dock was unplugged.
    const live = new Set(docks.map((d) => d.index));
    for (const dock of this.dockImages.keys()) {
      if (!live.has(dock)) this.dockImages.delete(dock);
    }
    this.syncDockBrightnessToSettings(docks);
    this.bus.broadcast('status', this.snapshot());
    // The selected dock's extra-key configs resolve from its (now-changed) live
    // deviceKey; a replug/connect leaves the client's map stale ({} from while it
    // was gone), so re-push it here. Skipped when selectDock(0) below fires (it
    // broadcasts the fallback dock's configs itself).
    if (this._selectedDock !== 0 && !live.has(this._selectedDock)) this.selectDock(0);
    else this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
  }

  notifyElgatoAppRunning(running: boolean): void {
    if (this.elgatoAppRunning === running) return;
    this.elgatoAppRunning = running;
    this.bus.broadcast('status', this.snapshot());
  }

  notifyElgatoDevicePresent(present: boolean): void {
    if (this.elgatoDevicePresent === present) return;
    this.elgatoDevicePresent = present;
    this.bus.broadcast('status', this.snapshot());
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
    this.modelId = model.id;
    this.modelName = model.name;
    this.keyCount = model.keyCount;
    this.columns = model.columns;
    this.rows = model.rows;
    this.bus.broadcast('status', this.snapshot());
  }

  notifyComm(entry: Omit<CommEntry, 'ts'>): void {
    const full: CommEntry = { ts: Date.now(), ...entry };
    this.commBuffer.push(full);
    if (this.commBuffer.length > COMM_BUFFER_MAX) this.commBuffer.shift();

    // Batch live broadcasts: image bursts can produce a 'comm' entry per
    // 1024B chunk (rx + tx), each of which would otherwise become its own
    // WS JSON broadcast competing with the image hot path. Queue and flush
    // on a timer instead; ordering is preserved.
    this.commFlushQueue.push(full);
    if (this.commFlushQueue.length > COMM_BUFFER_MAX) this.commFlushQueue.shift();
    if (this.commFlushTimer === null) {
      this.commFlushTimer = setInterval(() => this.flushCommQueue(), COMM_BROADCAST_FLUSH_MS);
    }
  }

  private flushCommQueue(): void {
    // A synchronous throw here would kill the process (no global hook for
    // sync setInterval callbacks) — keep it non-throwing.
    try {
      if (this.commFlushQueue.length === 0) {
        this.stopCommFlush();
        return;
      }
      const batch = this.commFlushQueue.splice(0, this.commFlushQueue.length);
      this.bus.broadcast('commBatch', batch);
    } catch (e) {
      try {
        this.log('error', 'webui', `comm-flush failed: ${(e as Error).message}`);
      } catch {
        /* logging itself failed — drop */
      }
    }
  }

  log(level: LogLevel, component: string, message: string): void {
    const entry: LogEntry = { ts: Date.now(), level, component, message };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > LOG_BUFFER_MAX) this.logBuffer.shift();
    this.bus.broadcast('log', entry);
  }

  snapshot(): StatusSnapshot {
    return {
      driverMode: this.driverMode,
      driverConnected: this.driverConnected,
      elgatoConnected: this.elgatoConnected,
      elgatoRemoteAddr: this.elgatoRemoteAddr,
      clientApp: this.clientApp,
      brightness: this.selectedBrightness(),
      modelId: this.modelId,
      modelName: this.modelName,
      keyCount: this.keyCount,
      columns: this.columns,
      rows: this.rows,
      elgatoAppRunning: this.elgatoAppRunning,
      elgatoDevicePresent: this.elgatoDevicePresent,
      localIp: this._localIp,
      imageModeOverride: this.imageModeOverride,
      docks: this.docks,
      selectedDock: this._selectedDock,
    };
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
    for (const [k] of this.imageState) images[String(k)] = this.imageVersion.get(k) ?? 1;
    return {
      ...this.snapshot(),
      images,
      logs: this.logBuffer,
      commLogs: this.commBuffer,
      keyEvents: this.keyEventBuffer,
      stats: { ...this.stats, uptimeMs: Date.now() - this.startTime },
      mockConfig: this.mockConfig,
      resizeEnabled: this.resizeEnabled,
      brightnessOverride: this.brightnessOverride,
      deviceModels: this.deviceModels,
      deviceIdentity: this.getDeviceIdentity(),
      extraKeys: this.selectedExtraKeyConfigs(),
    };
  }

  // ---- Extra keys (293S 6th column — see extra-keys.ts) ----

  /** Persisted extra-key config for one device wire id — read per tick by
   *  DriverManager/DeviceSession's widget schedulers. */
  extraKeyConfigFor(deviceKey: string, wireId: number): ExtraKeyConfig | undefined {
    return this.deviceEntryFor(deviceKey)?.extraKeys?.[String(wireId)];
  }

  /** The SELECTED dock's extra-key config map (WebUI panel state). */
  private selectedExtraKeyConfigs(): Record<string, ExtraKeyConfig> {
    return this.deviceEntryFor(this.selectedDeviceKey())?.extraKeys ?? {};
  }

  /** Assign (or clear, with widget 'none') an extra-key widget on the SELECTED
   *  dock. Persists, pushes the new map to WS clients, and emits
   *  'extraKeyChanged' so app.ts repaints that dock's widgets. */
  trySetExtraKey(wireId: number, cfg: ExtraKeyConfig): { error: string; status: number } | null {
    const dock = this.docks.find((d) => d.index === this._selectedDock) ?? this.docks[0];
    if (!dock?.extraKeys?.includes(wireId)) {
      return { error: `selected dock has no extra key ${wireId}`, status: 400 };
    }
    const entry = this.deviceEntryFor(this.selectedDeviceKey());
    if (!entry) return { error: 'no connected device to configure', status: 409 };
    const map = { ...entry.extraKeys };
    if (cfg.widget === 'none') delete map[String(wireId)];
    else map[String(wireId)] = cfg;
    if (Object.keys(map).length > 0) entry.extraKeys = map;
    else delete entry.extraKeys;
    this.persistSettings();
    this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
    this.emit('extraKeyChanged', this._selectedDock);
    return null;
  }

  /** WebUI "Run now" — force an immediate re-run of a command-widget extra
   *  key on the SELECTED dock, bypassing its configured interval. */
  tryRunExtraKeyNow(wireId: number): { error: string; status: number } | null {
    const dock = this.docks.find((d) => d.index === this._selectedDock) ?? this.docks[0];
    if (!dock?.extraKeys?.includes(wireId)) {
      return { error: `selected dock has no extra key ${wireId}`, status: 400 };
    }
    const cfg = this.extraKeyConfigFor(this.selectedDeviceKey(), wireId);
    if (cfg?.widget !== 'command') {
      return { error: `extra key ${wireId} is not configured as a command widget`, status: 400 };
    }
    this.emit('extraKeyRunNow', this._selectedDock, wireId);
    return null;
  }

  /** Plugin-widget data for the extra-key WebUI popup: the plugins dir (empty-
   *  state hint), the *.js files found there (dropdown), and the live status of
   *  each plugin-widget key on the SELECTED dock (keyed by wire id). Read-only —
   *  the poll loops themselves run from the widget scheduler in extra-keys.ts. */
  async pluginsInfo(): Promise<PluginsInfo> {
    const dir = pluginsDir();
    const files = await listPluginFiles(dir);
    const status: Record<string, PluginStatus> = {};
    for (const [wireId, cfg] of Object.entries(this.selectedExtraKeyConfigs())) {
      if (cfg.widget === 'plugin' && cfg.param) {
        status[wireId] = pluginKeyStatus(cfg.param, cfg.pluginArg);
      }
    }
    return { dir, files, status };
  }

  /** The identifiers actually sent to the Elgato app for the CURRENTLY
   *  SELECTED device (`_selectedDock`) — not just the primary: `mockConfig`
   *  while driver mode is 'mock' (only ever dock 0; extras are real-mode
   *  only, so it IS the identity the mock CORA servers advertise), otherwise
   *  the selected dock's own identity as reported in `this.docks` (each
   *  dock's serials/PID/MAC/mDNS name — populated per-dock by DriverManager,
   *  see types.ts/driver-manager.ts/device-session.ts). Falls back to fixed
   *  defaults if `this.docks` hasn't been populated yet (e.g. before the
   *  first notifyDocks). Read-only, for display under Settings. */
  private getDeviceIdentity(): DeviceIdentity {
    if (this.driverMode === 'mock') {
      // Mock docks have no persisted per-device identity (nothing physical to
      // key off) — deviceKey is absent so the WebUI hides the rename control.
      return { ...this.mockConfig, mdnsServiceName: MDNS_SERVICE_NAME };
    }
    const dock = this.docks.find((d) => d.index === this._selectedDock) ?? this.docks[0];
    if (dock) {
      return {
        dockFirmwareVersion: dock.dockFirmwareVersion,
        childFirmwareVersion: dock.childFirmwareVersion,
        serialNumber: dock.serialNumber,
        childSerialNumber: dock.childSerialNumber,
        productId: dock.productId,
        macAddress: dock.macAddress,
        mdnsServiceName: dock.mdnsServiceName,
        deviceKey: dock.deviceKey || undefined,
      };
    }
    return {
      dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
      childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
      serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
      childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
      productId: DEFAULT_MODEL.cora.productId,
      macAddress: DEFAULT_MAC_ADDRESS_STRING,
      mdnsServiceName: MDNS_SERVICE_NAME,
    };
  }

  /** Look up (or generate + persist) the stable identity for `deviceKey` —
   *  called by DriverManager/DeviceSession on connect. Pure generation lives
   *  in device-identity.ts; this is the one place that reads/writes the
   *  devices[] slice of settings.json. */
  getOrCreateDeviceIdentity(deviceKey: string, defaultMdnsName: string): DeviceIdentitySettings {
    const result = getOrCreateDeviceIdentityPure(deviceKey, defaultMdnsName, this.devices);
    if (result.created) {
      this.devices = result.devices;
      this.persistSettings();
    }
    return result.identity;
  }

  /** WebUI "Device Identity" edit: rename `deviceKey`'s persisted mDNS name.
   *  Returns false if `deviceKey` has no persisted identity yet (not seen by
   *  getOrCreateDeviceIdentity — nothing to rename). Caller (app.ts) still
   *  needs to push the change live via DriverManager.applyMdnsNameForDeviceKey. */
  updateDeviceMdnsName(deviceKey: string, name: string): boolean {
    const entry = this.devices.find((d) => d.deviceKey === deviceKey);
    if (!entry) return false;
    entry.mdnsServiceName = name;
    this.persistSettings();
    return true;
  }

  getImage(key: number): Buffer | undefined {
    const buf = this.imageState.get(key);
    return buf && buf.length > 0 ? buf : undefined;
  }

  applyMockConfig(parsed: Partial<MockDeviceConfig>): MockDeviceConfig {
    const stringFields: [keyof MockDeviceConfig, number][] = [
      ['dockFirmwareVersion', MOCK_FW_VERSION_MAX_LEN],
      ['childFirmwareVersion', MOCK_FW_VERSION_MAX_LEN],
      ['serialNumber', MOCK_SERIAL_MAX_LEN],
      ['childSerialNumber', MOCK_SERIAL_MAX_LEN],
    ];
    for (const [key, maxLen] of stringFields) {
      const value = parsed[key];
      if (typeof value === 'string') {
        (this.mockConfig[key] as string) = value.slice(0, maxLen);
      }
    }
    if (typeof parsed.productId === 'number' && Number.isInteger(parsed.productId)) {
      this.mockConfig.productId = parsed.productId & MOCK_PRODUCT_ID_MASK;
    }
    if (typeof parsed.macAddress === 'string' && isValidMacAddress(parsed.macAddress)) {
      this.mockConfig.macAddress = parsed.macAddress;
    }
    this.bus.broadcast('mockConfig', this.mockConfig);
    this.emit('mockConfig', { ...this.mockConfig });
    return this.mockConfig;
  }

  trySimulateKey(n: number): { error: string; status: number } | null {
    if (n < 0 || n >= this.keyCount) {
      return { error: `key index must be 0–${this.keyCount - 1}`, status: 400 };
    }
    if (this.driverMode !== 'mock') {
      return { error: 'key simulation only available in mock mode', status: 409 };
    }
    this.emit('keyPress', n);
    return null;
  }

  private bumpVersion(mk2Index: number): number {
    const v = (this.imageVersion.get(mk2Index) ?? 0) + 1;
    this.imageVersion.set(mk2Index, v);
    return v;
  }

  // ---- Per-device settings resolution (devices[] keyed by deviceKey) ----

  /** deviceKey of the currently selected dock ('' when none / mock). */
  private selectedDeviceKey(): string {
    return this.deviceKeyForDock(this._selectedDock);
  }

  /** deviceKey of the dock at `index`; for the selected dock it falls back to
   *  dock[0] (matching selectedBrightness/getDeviceIdentity). '' = unknown/mock. */
  private deviceKeyForDock(index: number): string {
    const dock =
      this.docks.find((d) => d.index === index) ??
      (index === this._selectedDock ? this.docks[0] : undefined);
    return dock?.deviceKey ?? '';
  }

  private deviceEntryFor(deviceKey: string): DeviceIdentitySettings | undefined {
    return deviceKey ? this.devices.find((d) => d.deviceKey === deviceKey) : undefined;
  }

  /** Live brightness of the selected dock (what the WebUI slider shows). */
  private selectedBrightness(): number {
    const dock = this.docks.find((d) => d.index === this._selectedDock) ?? this.docks[0];
    return dock ? dock.brightness : DEFAULT_BRIGHTNESS;
  }

  /** Persisted brightness for the dock at `index` — re-pushed to hardware after
   *  Elgato pairing (app.ts) so a device boots at the user's saved level. */
  brightnessForDock(index: number): number {
    return this.deviceEntryFor(this.deviceKeyForDock(index))?.brightness ?? DEFAULT_BRIGHTNESS;
  }

  /** Copy each real dock's live brightness into its persisted device entry.
   *  Called from notifyDocks; persists only on an actual change and skips docks
   *  with no deviceKey (mock / not yet identity-resolved). */
  private syncDockBrightnessToSettings(docks: DockStatus[]): void {
    let changed = false;
    for (const dock of docks) {
      const e = this.deviceEntryFor(dock.deviceKey);
      if (e && e.brightness !== dock.brightness) {
        e.brightness = dock.brightness;
        changed = true;
      }
    }
    if (changed) this.persistSettings();
  }

  // ---- Persistent settings file (selectedDock + devices[]) ----

  private currentSettings(): Settings {
    return {
      selectedDock: this._selectedDock,
      ...(this.devices.length > 0 ? { devices: this.devices } : {}),
    };
  }

  /** Loads settings.json (if present) and applies it over the hardcoded
   *  defaults. Fields are assigned directly — not via the notify* setters —
   *  so startup never fires broadcasts/hardware events before anything is
   *  listening. Malformed device entries are dropped (same guard as import).
   *  Legacy path-keyed entries (pre-serial deviceKeys) are also pruned: their
   *  key can never re-match a device again (the IOKit path is volatile), so
   *  they are dead weight that would accumulate one phantom row per replug. */
  private async loadPersistedSettings(): Promise<void> {
    const saved = await loadSettings(this.settingsCacheRoot);
    if (typeof saved.selectedDock === 'number') this._selectedDock = saved.selectedDock;
    if (Array.isArray(saved.devices)) {
      saved.devices.forEach(stripInvalidExtraKeys);
      this.devices = saved.devices
        .filter(isDeviceIdentitySettings)
        .filter((d) => isStableDeviceKey(d.deviceKey));
    }
  }

  /** Settings-JSON-import branch of applySettingsJson: devices[] carries the
   *  identity AND per-device brightness/override/imageMode. Silently ignored
   *  (not thrown) if `devices` is malformed. After replacing the store, the
   *  selected dock's values are pushed live so the raw-JSON editor takes effect
   *  immediately (extras re-seed on their next connect). */
  private applyDevicesFromImport(devices: unknown): void {
    if (!Array.isArray(devices) || !devices.every(isDeviceIdentitySettings)) return;
    this.devices = devices;
    this.persistSettings();
    this.reapplySelectedDeviceLive();
  }

  /** Push the selected dock's persisted brightness/override/imageMode to its
   *  driver + WS clients (used after a settings import). */
  private reapplySelectedDeviceLive(): void {
    const idx = this._selectedDock;
    this.bus.broadcast('brightnessOverride', { enabled: this.brightnessOverride });
    this.bus.broadcast('imageMode', { mode: this.imageModeOverride });
    this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
    this.emit('setImageOverride', this.imageModeOverride, idx);
    this.emit('extraKeyChanged', idx);
    const e = this.deviceEntryFor(this.selectedDeviceKey());
    if (typeof e?.brightness === 'number') this.emit('setBrightness', e.brightness, idx);
  }

  /** Fire-and-forget write-through — called after every mutation of a
   *  persisted field so "persistent" covers every control, not just the raw
   *  JSON editor. Errors are logged inside saveSettings(), never thrown. */
  private persistSettings(): void {
    void saveSettings(this.currentSettings(), this.settingsCacheRoot);
  }

  getSettingsJson(): string {
    return JSON.stringify(this.currentSettings(), null, 2);
  }

  /** Best-effort: opens settings.json in the OS's default handler (e.g.
   *  TextEdit/Notepad), for the "Open settings.json" button in Settings.
   *  Writes the current in-memory settings out first (and awaits it), since
   *  the file may not exist yet (nothing persisted since a fresh install) —
   *  `open` fails silently on a missing path, so this guarantees there's
   *  something to show. Failures beyond that are swallowed in os-utils.ts. */
  async openSettingsFile(): Promise<void> {
    await saveSettings(this.currentSettings(), this.settingsCacheRoot);
    await openPathInOS(settingsPath(this.settingsCacheRoot));
  }

  /** Parses `raw`, validates it's an object, assigns known fields over the
   *  current state, and persists. Throws on malformed JSON/non-object input;
   *  unknown/invalid individual fields are ignored (not fatal). */
  applySettingsJson(raw: string): void {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings must be a JSON object');
    }
    const s = parsed as Settings;
    // devices[] carries every per-device setting now — apply it first so the
    // selected dock's entry is in place before we (re)select + re-apply.
    this.applyDevicesFromImport(s.devices);
    // selectedDock is best-effort: an index that doesn't exist on this host
    // (e.g. a file imported from a machine with more docks) is ignored, not
    // fatal — matching the "invalid fields ignored" contract. selectDock() (via
    // trySelectDock) triggers its own status broadcast + reapply on change.
    if (typeof s.selectedDock === 'number' && Number.isInteger(s.selectedDock)) {
      if (!this.trySelectDock(s.selectedDock)) this.reapplySelectedDeviceLive();
    }
  }
}
