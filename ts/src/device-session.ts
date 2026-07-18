// One extra emulated Network Dock (session index 1..MAX_DEVICE_SESSIONS-1).
//
// Session 0 (the primary) stays the existing DriverManager singleton path —
// it owns the WebUI/tray, default ports, mock mode. An extra session is a
// self-contained dock: its own CORA server pair on strided ports, its own mDNS
// advert and identity, and one WorkerHidDriver (one hidapi handle) on its own
// worker thread. Extras have NO WebUI/tray coupling — the WebUI stays
// single-device (primary only) in v1.
import { log } from './logger.js';
import type { LogLevel } from './logger.js';
import {
  ELGATO_TCP_PORT,
  ELGATO_CHILD_PORT,
  CORA_PORT_STRIDE,
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_BRIGHTNESS,
} from './types.js';
import type {
  ExtraKeyConfig,
  KeyEvent,
  ImageEvent,
  DockStatus,
  ImageModeOverride,
} from './types.js';
import type { DeviceIdentitySettings } from './settings-store.js';
import { modelToChildGeometry } from './capabilities.js';
import { deviceInputToMk2Index } from './translator.js';
import { sendSplashImages } from './splash-sender.js';
import { ExtraKeyWidgets } from './extra-keys.js';
import type { DeviceModel } from './devices/driver.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';
import type { DeviceConfig } from './elgato-types.js';
import type { WorkerHidDriver } from './hid-worker-host.js';

/** Physical serial/firmware forwarded when model.cora.usePhysicalIdentity. */
export interface DeviceInfo {
  serial?: string;
  firmware?: string;
}

/** Identity for an extra dock: ports from CORA_PORT_STRIDE off the primary
 *  pair (a runtime resource, legitimately scan-order-dependent), everything
 *  else (mdns/serials/mac/deviceKey) from the per-physical-device identity
 *  resolved by the caller via device-identity.ts's getOrCreateDeviceIdentity —
 *  stable across restarts/replug, unlike the old session-index scheme. The
 *  dock/child serials' distinguishing suffix (chars 10-11) must stay INSIDE
 *  the first 12 chars: the desktop app keys devices by the serial truncated
 *  to 12 (see pairing challenge 0x06 — serial.substring(0,12)), so a suffix in
 *  chars 12-13 collides with the primary and the app silently drops the extra
 *  child as a duplicate. */
export interface SessionIdentity {
  index: number; // 1..MAX_DEVICE_SESSIONS-1 (extras only) — port assignment only
  primaryPort: number; // ELGATO_TCP_PORT + CORA_PORT_STRIDE * index
  childPort: number; // ELGATO_CHILD_PORT + CORA_PORT_STRIDE * index
  deviceKey: string;
  mdnsServiceName: string;
  dockSerial: string;
  childSerial: string;
  macAddress: string;
}

export function sessionIdentity(index: number, identity: DeviceIdentitySettings): SessionIdentity {
  return {
    index,
    primaryPort: ELGATO_TCP_PORT + CORA_PORT_STRIDE * index,
    childPort: ELGATO_CHILD_PORT + CORA_PORT_STRIDE * index,
    deviceKey: identity.deviceKey,
    mdnsServiceName: identity.mdnsServiceName,
    dockSerial: identity.dockSerial,
    childSerial: identity.childSerial,
    macAddress: identity.macAddress,
  };
}

/** The CORA server pair for one dock. Built by a SessionServersFactory so this
 *  module compiles against the current ElgatoServer API — the factory (wired in
 *  app.ts) is what constructs the servers with the identity's ports/serials. */
export interface SessionServers {
  server: ElgatoServer;
  childServer: ElgatoChildServer;
}
export type SessionServersFactory = (identity: SessionIdentity) => SessionServers;

/** True when the model maps device wire input codes to CORA (MK.2) indices. */
function hasInputKeyMap(model: DeviceModel): boolean {
  return model.keyMap.wireInputToCora != null || model.keyMap.inputOffset != null;
}

/** Wire the driver events shared by the primary (DriverManager) and every
 *  extra session: key dispatch (wire→mk2 mapping + logging), error/log
 *  forwarding, reinit repaint. 'disconnect' differs per owner and stays with
 *  the caller, as do the primary-only WebUI mirrors (comm/imageSent). */
export function wireCommonDriverEvents(
  driver: WorkerHidDriver,
  model: DeviceModel,
  opts: {
    onKey: (mk2Index: number, state: KeyEvent['state']) => void;
    /** Sleep/wake re-init sent CLE ALL — repaint the extra-key widgets it wiped. */
    onReinit: () => void;
  },
): void {
  driver.on('key', (e: KeyEvent) => {
    let index = e.keyIndex;
    if (hasInputKeyMap(model)) {
      index = deviceInputToMk2Index(e.keyIndex, model);
      // Outside the emulated grid (293S 6th column) — display-only keys
      // with no switches; nothing to dispatch.
      if (index < 0) return;
      const wire = e.keyIndex.toString(16).padStart(2, '0');
      log('info', 'key', `${model.id} wire=0x${wire} → mk2=${index} ${e.state}`);
    } else {
      log('info', 'key', `${model.id} key=${e.keyIndex} ${e.state}`);
    }
    opts.onKey(index, e.state);
  });
  driver.on('error', (err: Error) => log('error', model.id, err.message));
  driver.on('reinit', opts.onReinit);
  driver.on(
    'log',
    ({ level, component, message }: { level: LogLevel; component: string; message: string }) =>
      log(level, component, message),
  );
}

/** Server-facing half of DriverManager.applyDeviceModel (no WebUI). Advertises
 *  the model's PID/geometry/identity to the desktop over both CORA ports. Shared
 *  by the primary (via DriverManager) and every extra session so there is ONE
 *  implementation of the CORA identity/geometry push. */
export function applyModelToServers(
  server: ElgatoServer,
  childServer: ElgatoChildServer,
  model: DeviceModel,
  deviceInfo?: DeviceInfo,
): void {
  const pid = model.cora.productId;
  const geo = model.cora.advertiseGeometry ?? modelToChildGeometry(model);
  const configPatch: Partial<DeviceConfig> = { productId: pid };
  if (model.cora.usePhysicalIdentity) {
    if (deviceInfo?.serial) configPatch.childSerialNumber = deviceInfo.serial;
    if (deviceInfo?.firmware) configPatch.childFirmwareVersion = deviceInfo.firmware;
  }
  server.setDeviceConfig(configPatch);
  server.setChildGeometry(geo);
  server.restartMdns(pid);
  childServer.setChildGeometry(geo);
  server.pushChildCapabilities();
}

export interface DeviceSessionOptions {
  identity: SessionIdentity;
  servers: SessionServers;
  driver: WorkerHidDriver; // already successfully opened by the coordinator
  model: DeviceModel;
  deviceInfo?: DeviceInfo;
  /** Called on the driver's 'disconnect' — the coordinator tears the session
   *  down (remove from map, free the index, stop()). */
  onDisconnect: () => void;
  /** Called whenever this session's status() shape may have changed — start()
   *  completing, stop() completing, or the child CORA client (dis)connecting.
   *  Opaque to DeviceSession: the coordinator uses it to notify the WebUI. */
  onStatusChange?: () => void;
  /** Mirror of each raw CORA key image, called AFTER the driver render is
   *  queued (USB first). Opaque: the coordinator routes it to the WebUI's
   *  selected-dock preview. */
  onImage?: (keyIndex: number, data: Uint8Array, format: 'jpeg' | 'bmp') => void;
  /** True while this dock's "ignore brightness from Elgato app" override is
   *  on — the Elgato-app brightness for this dock is dropped then. Resolved per
   *  dock (by deviceKey) by the coordinator, not a global flag. */
  ignoreElgatoBrightness?: () => boolean;
  /** This dock's persisted brightness/image-mode (from settings.json via
   *  getOrCreateDeviceIdentity) — seeded onto the driver in start(). */
  initialBrightness?: number;
  initialImageMode?: ImageModeOverride;
  /** This dock's persisted extra-key config (by device wire id), resolved per
   *  press by the coordinator (deviceKey captured there) — see extra-keys.ts. */
  extraKeyConfigFor?: (wireId: number) => ExtraKeyConfig | undefined;
}

export class DeviceSession {
  readonly identity: SessionIdentity;
  private readonly server: ElgatoServer;
  private readonly childServer: ElgatoChildServer;
  private readonly driver: WorkerHidDriver;
  private readonly model: DeviceModel;
  private readonly deviceInfo?: DeviceInfo;
  private readonly onDisconnect: () => void;
  private readonly onStatusChange?: () => void;
  private readonly onImage?: (keyIndex: number, data: Uint8Array, format: 'jpeg' | 'bmp') => void;
  private readonly ignoreElgatoBrightness?: () => boolean;
  private readonly initialBrightness?: number;
  private readonly initialImageMode: ImageModeOverride;
  private readonly extraKeyConfigFor?: (wireId: number) => ExtraKeyConfig | undefined;
  private readonly extraKeys: ExtraKeyWidgets;
  private brightness = DEFAULT_BRIGHTNESS;
  private stopped = false;

  constructor(opts: DeviceSessionOptions) {
    this.identity = opts.identity;
    this.server = opts.servers.server;
    this.childServer = opts.servers.childServer;
    this.driver = opts.driver;
    this.model = opts.model;
    this.deviceInfo = opts.deviceInfo;
    this.onDisconnect = opts.onDisconnect;
    this.onStatusChange = opts.onStatusChange;
    this.onImage = opts.onImage;
    this.ignoreElgatoBrightness = opts.ignoreElgatoBrightness;
    this.initialBrightness = opts.initialBrightness;
    this.brightness = opts.initialBrightness ?? DEFAULT_BRIGHTNESS;
    this.initialImageMode = opts.initialImageMode ?? null;
    this.extraKeyConfigFor = opts.extraKeyConfigFor;
    this.extraKeys = new ExtraKeyWidgets(this.driver, (wireId) => this.extraKeyConfigFor?.(wireId));
  }

  /** The underlying driver — used by DriverManager.getDriverForDock so app.ts
   *  can apply this dock's image-mode override + repaint. */
  getDriver(): WorkerHidDriver {
    return this.driver;
  }

  /** Current dock status for the WebUI (primary index 0 + extras). Pure read —
   *  no side effects. */
  status(): DockStatus {
    const usePhysical = this.model.cora.usePhysicalIdentity;
    return {
      index: this.identity.index,
      ...(this.model.keyMap.extraKeys ? { extraKeys: this.model.keyMap.extraKeys } : {}),
      modelId: this.model.id,
      modelName: this.model.name,
      keyCount: this.model.keyCount,
      columns: this.model.columns,
      rows: this.model.rows,
      primaryPort: this.identity.primaryPort,
      primaryConnected: this.server.hasClient,
      elgatoConnected: this.childServer.hasClient,
      brightness: this.brightness,
      // Mirrors applyModelToServers: only childSerialNumber/childFirmwareVersion
      // are ever patched with the physical device's own values, and only when
      // usePhysicalIdentity is set — everything else is this session's own
      // fixed SessionIdentity (dockSerial/mdns) or the shared defaults.
      dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
      childFirmwareVersion:
        (usePhysical && this.deviceInfo?.firmware) || DEFAULT_CHILD_FIRMWARE_VERSION,
      serialNumber: this.identity.dockSerial,
      childSerialNumber: (usePhysical && this.deviceInfo?.serial) || this.identity.childSerial,
      productId: this.model.cora.productId,
      macAddress: this.identity.macAddress,
      mdnsServiceName: this.identity.mdnsServiceName,
      deviceKey: this.identity.deviceKey,
    };
  }

  /** Live-rename this dock's mDNS advert (WebUI "Device Identity" edit) — see
   *  ElgatoServer.setMdnsServiceName for why this respawns the mDNS process. */
  updateMdnsServiceName(name: string): void {
    this.identity.mdnsServiceName = name;
    this.server.setMdnsServiceName(name);
    this.notifyStatusChange();
  }

  /** Apply + record a brightness level (WebUI slider or Elgato app). */
  setBrightness(level: number): void {
    this.brightness = level;
    this.driver.setBrightness(level);
    this.notifyStatusChange();
  }

  private notifyStatusChange(): void {
    this.onStatusChange?.();
  }

  /** Bring the dock up. Single attempt: a bind error (port conflict) throws to
   *  the coordinator, which logs it and retries on a later scan tick — no
   *  infinite retry loop here. */
  async start(): Promise<void> {
    await this.server.start();
    await this.childServer.start();
    applyModelToServers(this.server, this.childServer, this.model, this.deviceInfo);
    this.wireListeners();
    // Seed this dock's persisted per-device settings before the splash so it
    // boots at the user's saved brightness/image-mode. Only push when actually
    // persisted — an absent value means "use the device/model default", so we
    // skip the redundant HID write.
    if (this.initialImageMode !== null) this.driver.setImageOverride(this.initialImageMode);
    if (this.initialBrightness !== undefined) this.driver.setBrightness(this.initialBrightness);
    sendSplashImages(this.driver);
    this.extraKeys.start();
    this.notifyStatusChange();
  }

  /** Repaint this dock's extra-key widgets (reinit / WebUI config change).
   *  No-op for models without extraKeys. */
  repaintExtraKeys(): void {
    this.extraKeys.repaint();
  }

  /** WebUI "Run now" for one of this dock's command-widget extra keys. */
  forceRunExtraKey(wireId: number): void {
    this.extraKeys.forceRun(wireId);
  }

  /** Mirror DriverManager.attachRealDriverListeners minus every WebUI hook. */
  private wireListeners(): void {
    wireCommonDriverEvents(this.driver, this.model, {
      onKey: (index, state) => this.childServer.sendKeyEvent(index, state),
      onReinit: () => this.repaintExtraKeys(),
    });
    this.driver.on('disconnect', () => {
      log('info', this.model.id, 'disconnected');
      this.onDisconnect();
    });
    // Raw CORA image → worker: transform + write off the main thread (P1).
    // The onImage mirror runs after the driver call — bytes are already on the
    // main thread, so the mirror costs one callback (the WebUI only encodes/
    // broadcasts when this dock is the selected preview).
    this.childServer.on('image', ({ keyIndex, data, format }: ImageEvent) => {
      this.driver.renderCoraImage(keyIndex, data, format);
      this.onImage?.(keyIndex, data, format);
    });
    this.childServer.on('brightness', (level: number) => {
      if (this.ignoreElgatoBrightness?.()) {
        log('debug', this.model.id, `brightness ${level} from Elgato ignored (override on)`);
        return;
      }
      log('info', this.model.id, `brightness set to ${level}`);
      this.setBrightness(level);
    });
    // Status-only events for the WebUI — connect/disconnect are rare, no comm/
    // image/key mirror for extras (see file header).
    this.childServer.on('clientConnected', () => this.notifyStatusChange());
    this.childServer.on('clientDisconnected', () => this.notifyStatusChange());
  }

  /** Idempotent teardown: drop driver listeners, close the worker, stop both
   *  servers (server.stop() also stops mDNS). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.extraKeys.stop();
    this.driver.removeAllListeners();
    await this.driver.close().catch(() => undefined);
    await this.server.stop().catch(() => undefined);
    await this.childServer.stop().catch(() => undefined);
    this.notifyStatusChange();
  }
}
