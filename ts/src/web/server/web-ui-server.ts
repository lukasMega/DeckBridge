import { EventEmitter } from 'node:events';
import { Broadcaster } from './broadcaster.js';
import { matchRoute } from './router.js';
import { routes } from './routes.js';
import { forbidden, notFound } from './http.js';
import { DEFAULT_MODEL } from '../../devices/registry.js';
import { pluginsDir } from '../../settings-store.js';
import type { Settings, DeviceIdentitySettings } from '../../settings-store.js';
import { listPluginFiles, pluginKeyStatus } from '../../plugin-host.js';
import type { PluginStatus } from '../../plugin-host.js';
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
  DeviceIdentity,
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
import {
  MDNS_SERVICE_NAME,
  WEBUI_PORT,
  webuiBindAddr,
  DEFAULT_BRIGHTNESS,
  DEFAULT_BRIGHTNESS_OVERRIDE,
} from '../../types.js';

export { isAllowedWebRequest, isValidMacAddress, pickFallbackPort } from './web-request-guard.js';

type ImageFormat = 'jpeg' | 'bmp';
type DockFrame = { data: Buffer; format: ImageFormat };
type ReqError = { error: string; status: number };

export class WebUIServer extends EventEmitter implements WebUIController {
  private server: TjsServeServer | null = null;
  private readonly bus = new Broadcaster();
  private readonly activity = new ActivityBuffers(this.bus);
  private readonly settings: PersistedSettings;

  readonly imageState = new Map<number, Buffer>();
  /** Wire format of each key's last CORA frame, so a repaint after an
   *  image-mode override reuses the right format. */
  readonly imageFormat = new Map<number, ImageFormat>();
  private readonly imageVersion = new Map<number, number>();
  /** Per-dock cache of the last raw CORA frame per key. The live channel
   *  (imageState + WS) shows only the SELECTED dock; this cache makes switching
   *  instant (the Elgato app never re-pushes unprompted). */
  private readonly dockImages = new Map<number, Map<number, DockFrame>>();
  get selectedDock(): number {
    return this.settings.selectedDock;
  }
  resizeEnabled = true;
  // brightness/brightnessOverride/imageModeOverride are per-device: the live
  // value lives in settings.devices[] keyed by the selected dock's deviceKey
  // (getters below). These two are the runtime-only fallback when there is NO
  // deviceKey (mock mode / pre-connect) — never persisted, so mock stays
  // runtime-only. See 2026-07-15_per-device-settings.md.
  private runtimeBrightnessOverride = DEFAULT_BRIGHTNESS_OVERRIDE;
  private runtimeImageModeOverride: ImageModeOverride = null;

  /** brightnessOverride of the SELECTED dock (WebUI toggle). */
  get brightnessOverride(): boolean {
    return this.isBrightnessOverride(this.selectedDeviceKey());
  }
  /** Per-device brightnessOverride — read by the Elgato-brightness ignore
   *  closures in DriverManager/DeviceSession (per dock, not global). */
  isBrightnessOverride(deviceKey: string): boolean {
    const e = this.settings.entryFor(deviceKey);
    return e
      ? (e.brightnessOverride ?? DEFAULT_BRIGHTNESS_OVERRIDE)
      : this.runtimeBrightnessOverride;
  }
  /** Same, by dock index (app.ts's Elgato→primary brightness gate). */
  isBrightnessOverrideForDock(index: number): boolean {
    return this.isBrightnessOverride(this.deviceKeyForDock(index));
  }
  /** imageModeOverride of the SELECTED dock; null = model default. */
  get imageModeOverride(): ImageModeOverride {
    const e = this.settings.entryFor(this.selectedDeviceKey());
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
  private docks: DockStatus[] = [];
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
  }

  // `listen = false` (--no-webui): settings still load (identity/brightness/extra-keys
  // persistence must work headless too), but the HTTP/WS listener and broadcast timers
  // never start — port stays closed, notify*/log/snapshot are no-ops with zero clients.
  async start(listen = true): Promise<void> {
    // Direct state load — never fires broadcasts/hardware events before
    // anything is listening.
    await this.settings.load();
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

  // Keep async: callers chain `stop().catch(...)` on the returned promise, so a synchronous
  // throw from this.server?.stop() surfaces as a rejection instead of escaping the call.
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
    this.imageState.set(mk2Index, data);
    this.imageFormat.set(mk2Index, format);
    const v = this.bumpVersion(mk2Index);
    // No browser open → skip the base64 + JSON.stringify entirely. State above
    // is still updated so new WS clients snapshot the correct version. With N
    // clients the encoded string is built once and reused for all N sends.
    if (this.bus.size === 0) return;
    this.bus.broadcast('image', { mk2Index, v, data: data.toString('base64'), format });
  }

  /** Dock-aware image mirror: always cache the frame for its dock; feed the
   *  live channel only when that dock is selected. */
  notifyDockImage(
    dock: number,
    mk2Index: number,
    data: Buffer,
    format: ImageFormat = 'jpeg',
  ): void {
    let cache = this.dockImages.get(dock);
    if (!cache) {
      cache = new Map();
      this.dockImages.set(dock, cache);
    }
    cache.set(mk2Index, { data, format });
    if (dock === this.selectedDock) this.notifyImageUpdate(mk2Index, data, format);
  }

  /** Snapshot of a dock's cached raw CORA frames (for repaint-on-replug).
   *  Fresh map; buffers are shared and treated as immutable. */
  dockFramesSnapshot(dock: number): Map<number, DockFrame> {
    return new Map(this.dockImages.get(dock) ?? []);
  }

  /** Switch the live preview to another dock: swap in its cached frames and
   *  replay them (clients clear their grid on the selectedDock status change). */
  selectDock(index: number): void {
    if (index === this.selectedDock) return;
    this.settings.selectedDock = index;
    this.imageState.clear();
    this.imageFormat.clear();
    this.broadcastStatus();
    // Per-device values live in dedicated client store fields, not the status
    // snapshot — re-push the new dock's values to keep slider + toggles in sync.
    this.bus.broadcast('brightness', { level: this.selectedBrightness() });
    this.broadcastSelectedDeviceState();
    this.settings.persist();
    const cache = this.dockImages.get(index);
    if (!cache) return;
    for (const [key, { data, format }] of cache) this.notifyImageUpdate(key, data, format);
  }

  /** Validate + apply a select-dock request from the WebUI. */
  trySelectDock(index: unknown): ReqError | null {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return { error: 'index must be a non-negative integer', status: 400 };
    }
    if (index !== 0 && !this.docks.some((d) => d.index === index)) {
      return { error: `no dock with index ${index}`, status: 404 };
    }
    this.selectDock(index);
    return null;
  }

  /** "Repaint everything" signal (e.g. after a brightness change), decoupled
   *  from the per-key image-update path. */
  notifyRepaint(): void {
    this.bus.broadcast('repaint', {});
  }

  /** Drop one dock's cached per-key images (model change / disconnect); clears
   *  the live channel too when that dock is selected. */
  resetImages(dock = 0): void {
    this.dockImages.delete(dock);
    if (dock !== this.selectedDock) return;
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

  // brightnessOverride/imageMode mutations target the SELECTED dock's persisted
  // device entry; with no deviceKey (mock / pre-connect) they fall back to the
  // runtime-only fields so mock still toggles at runtime.
  notifyBrightnessOverride(enabled: boolean): void {
    const e = this.settings.entryFor(this.selectedDeviceKey());
    if (e) {
      e.brightnessOverride = enabled;
      this.settings.persist();
    } else {
      this.runtimeBrightnessOverride = enabled;
    }
    this.bus.broadcast('brightnessOverride', { enabled });
    // Re-assert our brightness so a freshly enabled override wins over whatever
    // the Elgato app last pushed.
    if (enabled) this.emit('setBrightness', this.selectedBrightness(), this.selectedDock);
  }

  /** Per-device image-mode override for the selected dock: store, broadcast,
   *  and let app.ts apply it to that dock's driver via 'setImageOverride'. */
  notifyImageMode(mode: ImageModeOverride): void {
    const e = this.settings.entryFor(this.selectedDeviceKey());
    if (e) {
      e.imageModeOverride = mode;
      this.settings.persist();
    } else {
      this.runtimeImageModeOverride = mode;
    }
    this.bus.broadcast('imageMode', { mode });
    this.emit('setImageOverride', mode, this.selectedDock);
  }

  // Broadcast-only: brightness is persisted per-device via notifyDocks; this
  // just pushes the selected dock's slider value to WS clients.
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

  /** Which CORA client (Elgato app vs Bitfocus Companion) was detected on the
   *  current session. Reset to 'unknown' on disconnect. */
  notifyClientApp(app: ClientApp): void {
    if (this.status.clientApp === app) return;
    this.status.clientApp = app;
    this.broadcastStatus();
  }

  /** Push the current per-dock status list (primary + extras). Deduped against
   *  the previous list — the 2s reconnect scan calls this every tick, and an
   *  unchanged shape must not spam a broadcast. */
  notifyDocks(docks: DockStatus[]): void {
    if (JSON.stringify(docks) === JSON.stringify(this.docks)) return;
    this.docks = docks;
    // Drop image caches of vanished docks; fall back to the primary when the
    // selected dock was unplugged.
    const live = new Set(docks.map((d) => d.index));
    for (const dock of this.dockImages.keys()) {
      if (!live.has(dock)) this.dockImages.delete(dock);
    }
    this.settings.syncDockBrightness(docks);
    this.broadcastStatus();
    // The selected dock's extra-key configs resolve from its (changed) live
    // deviceKey; a replug leaves the client's map stale, so re-push it here.
    // Skipped when selectDock(0) fires (it broadcasts the fallback's configs).
    if (this.selectedDock !== 0 && !live.has(this.selectedDock)) this.selectDock(0);
    else this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
  }

  notifyElgatoAppRunning(running: boolean): void {
    if (this.status.elgatoAppRunning === running) return;
    this.status.elgatoAppRunning = running;
    this.broadcastStatus();
  }

  notifyElgatoDevicePresent(present: boolean): void {
    if (this.status.elgatoDevicePresent === present) return;
    this.status.elgatoDevicePresent = present;
    this.broadcastStatus();
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
      brightness: this.selectedBrightness(),
      imageModeOverride: this.imageModeOverride,
      docks: this.docks,
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
    for (const [k] of this.imageState) images[String(k)] = this.imageVersion.get(k) ?? 1;
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
      deviceIdentity: this.getDeviceIdentity(),
      extraKeys: this.selectedExtraKeyConfigs(),
    };
  }

  // ---- Extra keys (293S 6th column — see extra-keys.ts) ----

  /** Persisted extra-key config for one device wire id — read per tick by the
   *  widget schedulers in DriverManager/DeviceSession. */
  extraKeyConfigFor(deviceKey: string, wireId: number): ExtraKeyConfig | undefined {
    return this.settings.entryFor(deviceKey)?.extraKeys?.[String(wireId)];
  }

  /** The SELECTED dock's extra-key config map (WebUI panel state). */
  private selectedExtraKeyConfigs(): Record<string, ExtraKeyConfig> {
    return this.settings.entryFor(this.selectedDeviceKey())?.extraKeys ?? {};
  }

  private extraKeyOnSelectedDock(wireId: number): boolean {
    return this.selectedDockStatus()?.extraKeys?.includes(wireId) ?? false;
  }

  /** Assign (or clear, with widget 'none') an extra-key widget on the SELECTED
   *  dock. Persists, pushes the new map to WS clients, and emits
   *  'extraKeyChanged' so app.ts repaints that dock's widgets. */
  trySetExtraKey(wireId: number, cfg: ExtraKeyConfig): ReqError | null {
    if (!this.extraKeyOnSelectedDock(wireId)) {
      return { error: `selected dock has no extra key ${wireId}`, status: 400 };
    }
    const entry = this.settings.entryFor(this.selectedDeviceKey());
    if (!entry) return { error: 'no connected device to configure', status: 409 };
    const map = { ...entry.extraKeys };
    if (cfg.widget === 'none') delete map[String(wireId)];
    else map[String(wireId)] = cfg;
    if (Object.keys(map).length > 0) entry.extraKeys = map;
    else delete entry.extraKeys;
    this.settings.persist();
    this.bus.broadcast('extraKeys', { configs: this.selectedExtraKeyConfigs() });
    this.emit('extraKeyChanged', this.selectedDock);
    return null;
  }

  /** WebUI "Run now" — immediate re-run of a command-widget extra key on the
   *  SELECTED dock, bypassing its configured interval. */
  tryRunExtraKeyNow(wireId: number): ReqError | null {
    if (!this.extraKeyOnSelectedDock(wireId)) {
      return { error: `selected dock has no extra key ${wireId}`, status: 400 };
    }
    const cfg = this.extraKeyConfigFor(this.selectedDeviceKey(), wireId);
    if (cfg?.widget !== 'command') {
      return { error: `extra key ${wireId} is not configured as a command widget`, status: 400 };
    }
    this.emit('extraKeyRunNow', this.selectedDock, wireId);
    return null;
  }

  /** Plugin-widget data for the extra-key WebUI popup: plugins dir, its *.js
   *  files, and live status of each plugin-widget key on the SELECTED dock.
   *  Read-only — the poll loops run from the widget scheduler in extra-keys.ts. */
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

  /** Identifiers sent to the Elgato app for the SELECTED dock, shown under
   *  Settings (read-only): `mockConfig` in mock mode (mock is only ever dock 0
   *  and has no deviceKey, so the WebUI hides the rename control), else the
   *  selected dock's own identity from `this.docks` (populated per-dock by
   *  DriverManager), else fixed defaults before the first notifyDocks. */
  private getDeviceIdentity(): DeviceIdentity {
    if (this.status.driverMode === 'mock') {
      return { ...this.mockConfig, mdnsServiceName: MDNS_SERVICE_NAME };
    }
    const dock = this.selectedDockStatus();
    if (!dock) return { ...defaultMockConfig(), mdnsServiceName: MDNS_SERVICE_NAME };
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

  /** Stable identity for `deviceKey` — called by DriverManager/DeviceSession
   *  on connect. PersistedSettings is the sole settings.json writer. */
  getOrCreateDeviceIdentity(deviceKey: string, defaultMdnsName: string): DeviceIdentitySettings {
    return this.settings.getOrCreateIdentity(deviceKey, defaultMdnsName);
  }

  /** WebUI "Device Identity" edit: rename `deviceKey`'s persisted mDNS name.
   *  Caller (app.ts) still pushes the change live via
   *  DriverManager.applyMdnsNameForDeviceKey. */
  updateDeviceMdnsName(deviceKey: string, name: string): boolean {
    return this.settings.updateMdnsName(deviceKey, name);
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

  private bumpVersion(mk2Index: number): number {
    const v = (this.imageVersion.get(mk2Index) ?? 0) + 1;
    this.imageVersion.set(mk2Index, v);
    return v;
  }

  // ---- Per-device settings resolution (settings.devices[] keyed by deviceKey) ----

  /** The selected dock's status entry, falling back to dock[0]. */
  private selectedDockStatus(): DockStatus | undefined {
    return this.docks.find((d) => d.index === this.selectedDock) ?? this.docks[0];
  }

  /** deviceKey of the currently selected dock ('' when none / mock). */
  private selectedDeviceKey(): string {
    return this.deviceKeyForDock(this.selectedDock);
  }

  /** deviceKey of the dock at `index`; the selected dock falls back to dock[0]
   *  (matching selectedBrightness/getDeviceIdentity). '' = unknown/mock. */
  private deviceKeyForDock(index: number): string {
    const dock =
      index === this.selectedDock
        ? this.selectedDockStatus()
        : this.docks.find((d) => d.index === index);
    return dock?.deviceKey ?? '';
  }

  /** Live brightness of the selected dock (what the WebUI slider shows). */
  private selectedBrightness(): number {
    return this.selectedDockStatus()?.brightness ?? DEFAULT_BRIGHTNESS;
  }

  /** Persisted brightness for the dock at `index` — re-pushed to hardware after
   *  Elgato pairing (app.ts) so a device boots at the user's saved level. */
  brightnessForDock(index: number): number {
    return this.settings.entryFor(this.deviceKeyForDock(index))?.brightness ?? DEFAULT_BRIGHTNESS;
  }

  // ---- Settings JSON surface (persistence itself lives in persisted-settings.ts) ----

  getSettingsJson(): string {
    return this.settings.json();
  }

  async openSettingsFile(): Promise<void> {
    await this.settings.openFile();
  }

  /** Parse `raw`, validate it's an object, assign known fields, persist.
   *  Throws on malformed JSON/non-object; unknown/invalid individual fields
   *  are ignored (not fatal). */
  applySettingsJson(raw: string): void {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings must be a JSON object');
    }
    const s = parsed as Settings;
    // devices[] first, so the selected dock's entry is in place before we
    // (re)select + re-apply.
    if (this.settings.importDevices(s.devices)) this.reapplySelectedDeviceLive();
    // selectedDock is best-effort: an index that doesn't exist on this host
    // (file imported from a machine with more docks) is ignored. selectDock()
    // triggers its own status broadcast + reapply on change.
    if (typeof s.selectedDock === 'number' && Number.isInteger(s.selectedDock)) {
      if (!this.trySelectDock(s.selectedDock)) this.reapplySelectedDeviceLive();
    }
  }

  /** Push the selected dock's persisted brightness/override/imageMode to its
   *  driver + WS clients (used after a settings import). */
  private reapplySelectedDeviceLive(): void {
    const idx = this.selectedDock;
    this.broadcastSelectedDeviceState();
    this.emit('setImageOverride', this.imageModeOverride, idx);
    this.emit('extraKeyChanged', idx);
    const e = this.settings.entryFor(this.selectedDeviceKey());
    if (typeof e?.brightness === 'number') this.emit('setBrightness', e.brightness, idx);
  }
}
