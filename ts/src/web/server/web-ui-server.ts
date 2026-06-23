import { EventEmitter } from 'node:events';
import { Broadcaster } from './broadcaster.js';
import { matchRoute } from './router.js';
import { routes } from './routes.js';
import { forbidden, notFound } from './http.js';
import { DEFAULT_MODEL } from '../../devices/registry.js';
import type {
  DeviceModelInfo,
  DriverMode,
  KeyEventEntry,
  LogEntry,
  LogLevel,
  MockDeviceConfig,
  StateResponse,
  Stats,
  StatusSnapshot,
  WebUIController,
} from './types.js';
import type { KeyState, CommEntry, ImageModeOverride } from '../../types.js';
import {
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  DEFAULT_MAC_ADDRESS_STRING,
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

export function isValidMacAddress(addr: string): boolean {
  const parts = addr.split(':');
  return parts.length === 6 && parts.every((p) => /^[0-9a-f]{2}$/i.test(p));
}

const ALLOWED_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

// Guards against DNS rebinding and cross-site requests (CSRF/WS hijack): the WebUI binds to
// 127.0.0.1, but without these checks any website open in the user's browser could still
// reach it via a rebound hostname or a cross-origin fetch/WebSocket.
//
// Host/Origin are matched as `<hostname>:<port>` (the form real browsers send) or bare
// `<hostname>` (no port) — txiki's own `fetch`/serve omit the port from these headers even for
// non-default ports, which the test suite relies on. Accepting the bare form for our fixed
// loopback hostnames doesn't weaken the DNS-rebinding check: the hostname itself must still be
// localhost/127.0.0.1/[::1].
export function isAllowedWebRequest(
  host: string | null,
  origin: string | null,
  port: number,
): boolean {
  if (!host) return false;
  const hostLower = host.toLowerCase();
  if (!ALLOWED_HOSTNAMES.some((h) => hostLower === h || hostLower === `${h}:${port}`)) {
    return false;
  }

  if (origin !== null) {
    const originLower = origin.toLowerCase();
    if (
      !ALLOWED_HOSTNAMES.some(
        (h) => originLower === `http://${h}` || originLower === `http://${h}:${port}`,
      )
    ) {
      return false;
    }
  }

  return true;
}

async function isPortInUse(port: number): Promise<boolean> {
  try {
    const conn = await tjs.connect('tcp', '127.0.0.1', port);
    conn.close();
    return true;
  } catch {
    return false;
  }
}

const FALLBACK_PORT_MIN = 64000;
const FALLBACK_PORT_RANGE = 1001;
const FALLBACK_PORT_ATTEMPTS = 5;

export function pickFallbackPort(): number {
  return FALLBACK_PORT_MIN + Math.floor(Math.random() * FALLBACK_PORT_RANGE); // eslint-disable-line sonarjs/pseudo-random
}

export class WebUIServer extends EventEmitter implements WebUIController {
  private server: TjsServeServer | null = null;
  private readonly bus = new Broadcaster();

  readonly imageState = new Map<number, Buffer>();
  /** Per-key wire format of the last CORA frame, set in `notifyImageUpdate`.
   *  Used to repaint with the right format after an image-mode override. */
  readonly imageFormat = new Map<number, 'jpeg' | 'bmp'>();
  private readonly imageVersion = new Map<number, number>();
  resizeEnabled = true;
  brightnessOverride = DEFAULT_BRIGHTNESS_OVERRIDE;
  /** WebUI runtime image-fit override (resize ⇄ pad-black/avg/edge); null =
   *  use the active model's default. Runtime-only — resets on restart. */
  imageModeOverride: ImageModeOverride = null;
  private brightness = DEFAULT_BRIGHTNESS;
  private driverMode: DriverMode = 'real';
  private driverConnected = false;
  private elgatoConnected = false;
  private elgatoRemoteAddr: string | null = null;
  private readonly logBuffer: LogEntry[] = [];
  private readonly commBuffer: CommEntry[] = [];
  private readonly commFlushQueue: CommEntry[] = [];
  private commFlushTimer: number | null = null;
  private readonly keyEventBuffer: KeyEventEntry[] = [];
  private readonly stats: Stats = { uptimeMs: 0, elgatoRxPkts: 0, elgatoTxPkts: 0, imagesSent: 0 };
  private elgatoAppRunning = false;
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

  constructor(
    port = WEBUI_PORT,
    deviceModels: DeviceModelInfo[] = [],
    initialDriverMode: DriverMode = 'real',
  ) {
    super();
    this._port = port;
    this.deviceModels = deviceModels;
    this.driverMode = initialDriverMode;
  }

  async start(): Promise<void> {
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

  /** Explicit "repaint everything" signal (e.g. after a brightness change),
   *  decoupled from the per-key image-update path. */
  notifyRepaint(): void {
    this.bus.broadcast('repaint', {});
  }

  /** Drop all cached per-key images (model change / disconnect). */
  resetImages(): void {
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

  notifyBrightnessOverride(enabled: boolean): void {
    this.brightnessOverride = enabled;
    this.bus.broadcast('brightnessOverride', { enabled });
    if (enabled) this.emit('setBrightness', this.brightness);
  }

  /** WebUI runtime image-mode override: store, broadcast, and let app.ts wire
   *  the actual driver update + repaint via the 'setImageOverride' event. */
  notifyImageMode(mode: ImageModeOverride): void {
    this.imageModeOverride = mode;
    this.bus.broadcast('imageMode', { mode });
    this.emit('setImageOverride', mode);
  }

  notifyBrightness(level: number): void {
    this.brightness = level;
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
    this.bus.broadcast('status', this.snapshot());
  }

  notifyElgatoAppRunning(running: boolean): void {
    if (this.elgatoAppRunning === running) return;
    this.elgatoAppRunning = running;
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
      brightness: this.brightness,
      modelId: this.modelId,
      modelName: this.modelName,
      keyCount: this.keyCount,
      columns: this.columns,
      rows: this.rows,
      elgatoAppRunning: this.elgatoAppRunning,
      localIp: this._localIp,
      imageModeOverride: this.imageModeOverride,
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
    };
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
}
