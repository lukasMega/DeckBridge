// One extra emulated Network Dock (session index 1..MAX_DEVICE_SESSIONS-1): own CORA server pair on
// strided ports, own mDNS advert + identity, own WorkerHidDriver on its own worker thread. No
// WebUI/tray coupling — session 0 (DriverManager) keeps those, and the WebUI stays primary-only in v1.
import { log } from './logger.js';
import type { LogLevel } from './logger.js';
import {
  ELGATO_TCP_PORT,
  ELGATO_CHILD_PORT,
  CORA_PORT_STRIDE,
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  DEFAULT_MAC_ADDRESS_STRING,
  DEFAULT_BRIGHTNESS,
  MDNS_SERVICE_NAME,
} from './types.js';
import type {
  ExtraKeyConfig,
  KeyEvent,
  ImageEvent,
  DockStatus,
  ImageModeOverride,
  DialEvent,
  TouchInputEvent,
  TouchWindowRegion,
  TouchStripMode,
} from './types.js';
import type { DeviceIdentitySettings } from './settings-store.js';
import { advertisedGeometry, advertisedModel } from './devices/registry.js';
import { deviceInputToMk2Index } from './translator.js';
import { sendSplashImages } from './splash-sender.js';
import { ExtraKeyWidgets } from './extra-keys.js';
import { EncoderActions, type EncoderOverride } from './encoders.js';
import { emulationProfiles } from './devices/model-overrides.js';
import type { DeviceDriver, DeviceModel, DeviceModelOverride } from './devices/driver.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';
import type { DeviceConfig } from './elgato-types.js';
import type { WorkerHidDriver } from './hid-worker-host.js';

/** Physical serial/firmware forwarded when model.cora.usePhysicalIdentity. */
export interface DeviceInfo {
  serial?: string;
  firmware?: string;
}

/** Identity for an extra dock: ports from CORA_PORT_STRIDE off the primary pair (a
 *  runtime resource, legitimately scan-order-dependent), everything else from
 *  getOrCreateDeviceIdentity — stable across restart/replug. */
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

/** The identity fields a dock reports — satisfied by both SessionIdentity (an
 *  extra) and DeviceIdentitySettings (the primary). */
type DockIdentity = Omit<SessionIdentity, 'index' | 'primaryPort' | 'childPort'>;

export interface DockStatusInput {
  model: DeviceModel;
  index: number;
  primaryPort: number;
  /** Undefined only for the primary before its first connect → DEFAULT_* identity. */
  identity: DockIdentity | undefined;
  brightness: number;
  primaryConnected: boolean;
  elgatoConnected: boolean;
  /** Absent (not just empty) omits realDeviceIdentity — the pre-connect primary. */
  deviceInfo: DeviceInfo | undefined;
}

/** The one place a DockStatus is built: the primary dock (driver-manager-primary)
 *  and every extra session report the same fields in the same order. */
// oxlint-disable-next-line complexity -- flat fallback chain, not branching logic
export function buildDockStatus(s: DockStatusInput): DockStatus {
  const { model, identity, deviceInfo } = s;
  // Mirrors applyModelToServers: only childSerialNumber/childFirmwareVersion are ever patched
  // with the physical device's own values, and only when usePhysicalIdentity is set — everything
  // else is the dock's own fixed identity (dockSerial/mdns) or the shared defaults.
  const usePhysical = model.cora.usePhysicalIdentity;
  const encoderCount = physicalEncoderCount(model);
  return {
    index: s.index,
    ...(model.keyMap.extraKeys ? { extraKeys: model.keyMap.extraKeys } : {}),
    ...(model.widgetDisplays
      ? { widgetDisplays: model.widgetDisplays.map(({ wireId, label }) => ({ wireId, label })) }
      : {}),
    ...(encoderCount ? { encoderCount } : {}),
    modelId: model.id,
    modelName: model.name,
    keyCount: model.keyCount,
    columns: model.columns,
    rows: model.rows,
    primaryPort: s.primaryPort,
    primaryConnected: s.primaryConnected,
    elgatoConnected: s.elgatoConnected,
    brightness: s.brightness,
    dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
    childFirmwareVersion: childFirmwareFor(model, deviceInfo),
    serialNumber: identity?.dockSerial ?? DEFAULT_DOCK_SERIAL_NUMBER,
    childSerialNumber:
      (usePhysical && deviceInfo?.serial) || identity?.childSerial || DEFAULT_CHILD_SERIAL_NUMBER,
    productId: model.cora.productId,
    macAddress: identity?.macAddress ?? DEFAULT_MAC_ADDRESS_STRING,
    mdnsServiceName: identity?.mdnsServiceName ?? MDNS_SERVICE_NAME,
    deviceKey: identity?.deviceKey ?? '',
    ...(deviceInfo
      ? {
          realDeviceIdentity: {
            modelName: model.name,
            ...(deviceInfo.serial ? { serialNumber: deviceInfo.serial } : {}),
            ...(deviceInfo.firmware ? { firmwareVersion: deviceInfo.firmware } : {}),
          },
        }
      : {}),
  };
}

/** Knobs on the physical panel: the model's own count, else the most any of its
 *  CORA emulations declares — AKP05E's knobs are described only by its Plus profile,
 *  and exist (for the encoder override) whichever profile it advertises. */
function physicalEncoderCount(model: DeviceModel): number {
  const emulated = emulationProfiles(model).map((profile) => profile.encoderCount ?? 0);
  return Math.max(model.encoderCount ?? 0, ...emulated);
}

export type DockFrames = Map<number, { data: Buffer; format: 'jpeg' | 'bmp' }>;

/** Re-send a dock's cached CORA frames through its driver — the transform runs
 *  again, so this is how a live spec change reaches the panel. The frames
 *  themselves are unchanged, so the WebUI preview is left alone. */
export function repaintFrames(driver: DeviceDriver, frames: DockFrames): void {
  for (const [key, { data, format }] of frames) driver.renderCoraImage?.(key, data, format);
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

/** Wire the driver events shared by the primary (DriverManager) and every extra session: key
 * dispatch (wire→mk2 mapping + logging), error/log forwarding, reinit repaint. 'disconnect'
 * differs per owner and stays with the caller, as do the primary-only WebUI mirrors (comm/imageSent). */
export function wireCommonDriverEvents(
  driver: WorkerHidDriver,
  model: DeviceModel,
  opts: {
    /** `wireId` is the raw device code the press arrived on (pre-keyMap);
     *  undefined for identity-mapped models. Key-map learn mode needs it —
     *  a wrong map is exactly what it is there to fix. */
    onKey: (mk2Index: number, state: KeyEvent['state'], wireId?: number) => void;
    /** Encoder press/rotate (Stream Deck + emulation). Dropped by the child
     *  server when the advertised geometry declares no encoders. */
    onDial?: (event: DialEvent) => void;
    /** Touch-strip gesture (Stream Deck + emulation). */
    onTouch?: (event: TouchInputEvent) => void;
    /** Sleep/wake re-init sent CLE ALL — repaint the extra-key widgets it wiped. */
    onReinit: () => void;
  },
): void {
  driver.on('key', (e: KeyEvent) => {
    if (!hasInputKeyMap(model)) {
      log('info', 'key', `${model.id} key=${e.keyIndex} ${e.state}`);
      opts.onKey(e.keyIndex, e.state);
      return;
    }
    const index = deviceInputToMk2Index(e.keyIndex, model);
    // Outside the emulated grid (293S 6th column) — display-only keys
    // with no switches; nothing to dispatch.
    if (index < 0) return;
    const wire = e.keyIndex.toString(16).padStart(2, '0');
    log('info', 'key', `${model.id} wire=0x${wire} → mk2=${index} ${e.state}`);
    opts.onKey(index, e.state, e.keyIndex);
  });
  driver.on('dial', (e: DialEvent) => opts.onDial?.(e));
  driver.on('touch', (e: TouchInputEvent) => opts.onTouch?.(e));
  driver.on('error', (err: Error) => log('error', model.id, err.message));
  driver.on('reinit', opts.onReinit);
  driver.on(
    'log',
    ({ level, component, message }: { level: LogLevel; component: string; message: string }) =>
      log(level, component, message),
  );
}

/** Child firmware reported over CORA: the physical device's own when the model
 *  forwards it, else the advertised profile's line (the desktop rejects 1.01.x for a
 *  Stream Deck +), else the shared default. */
function childFirmwareFor(model: DeviceModel, deviceInfo: DeviceInfo | undefined): string {
  if (model.cora.usePhysicalIdentity && deviceInfo?.firmware) return deviceInfo.firmware;
  return advertisedModel(model).cora.childFirmwareVersion ?? DEFAULT_CHILD_FIRMWARE_VERSION;
}

/** Server-facing half of DriverManager.applyDeviceModel (no WebUI): advertises the
 *  model's PID/geometry/identity to the desktop over both CORA ports. Shared by the
 *  primary and every extra session. */
export function applyModelToServers(
  server: ElgatoServer,
  childServer: ElgatoChildServer,
  model: DeviceModel,
  deviceInfo?: DeviceInfo,
): void {
  const pid = model.cora.productId;
  const geo = advertisedGeometry(model);
  // Always patched: the servers outlive a model, so a Plus firmware must not stick
  // after the device is unplugged or re-paired as an MK.2.
  const configPatch: Partial<DeviceConfig> = {
    productId: pid,
    childFirmwareVersion: childFirmwareFor(model, deviceInfo),
  };
  if (model.cora.usePhysicalIdentity && deviceInfo?.serial) {
    configPatch.childSerialNumber = deviceInfo.serial;
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
  /** This dock's persisted touch-strip mode. Default DEFAULT_TOUCH_STRIP_MODE. */
  touchStripMode?: TouchStripMode;
  /** This dock's strip mode + encoder settings, resolved per dial event (deviceKey
   *  captured by the coordinator). Absent = knobs always reach the Elgato app. */
  encoderOverride?: () => EncoderOverride | undefined;
}

export class DeviceSession {
  readonly identity: SessionIdentity;
  private readonly server: ElgatoServer;
  private readonly childServer: ElgatoChildServer;
  private readonly driver: WorkerHidDriver;
  /** Effective model. Replaced by applyLiveTuning on an image-only device-tuning
   *  change; CORA geometry/input mapping are unaffected by that section. */
  private model: DeviceModel;
  private readonly deviceInfo?: DeviceInfo;
  private readonly onDisconnect: () => void;
  private readonly onStatusChange?: () => void;
  private readonly onImage?: (keyIndex: number, data: Uint8Array, format: 'jpeg' | 'bmp') => void;
  private readonly ignoreElgatoBrightness?: () => boolean;
  private readonly initialBrightness?: number;
  private readonly initialImageMode: ImageModeOverride;
  private readonly extraKeyConfigFor?: (wireId: number) => ExtraKeyConfig | undefined;
  private readonly extraKeys: ExtraKeyWidgets;
  private readonly encoders: EncoderActions;
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
    this.extraKeys = new ExtraKeyWidgets(
      this.driver,
      (wireId) => this.extraKeyConfigFor?.(wireId),
      opts.touchStripMode,
    );
    this.encoders = new EncoderActions(() => opts.encoderOverride?.());
  }

  /** The underlying driver — used by DriverManager.getDriverForDock so app.ts
   *  can apply this dock's image-mode override + repaint. */
  getDriver(): WorkerHidDriver {
    return this.driver;
  }

  /** Current dock status for the WebUI (primary index 0 + extras). Pure read —
   *  no side effects. */
  status(): DockStatus {
    return buildDockStatus({
      model: this.model,
      index: this.identity.index,
      primaryPort: this.identity.primaryPort,
      identity: this.identity,
      brightness: this.brightness,
      primaryConnected: this.server.hasClient,
      elgatoConnected: this.childServer.hasClient,
      // `?? {}`: an extra dock always reports realDeviceIdentity, even before the
      // driver knows the serial/firmware.
      deviceInfo: this.deviceInfo ?? {},
    });
  }

  /** Live device tuning (image-only change): swap the spec on this dock's
   *  worker and re-render its cached CORA frames + extra-key icons, instead of
   *  tearing the session down and redocking. */
  applyLiveTuning(
    overrides: DeviceModelOverride | undefined,
    effectiveModel: DeviceModel,
    frames?: DockFrames,
  ): void {
    this.driver.applyOverrides(overrides, effectiveModel);
    this.model = effectiveModel;
    if (frames) repaintFrames(this.driver, frames);
    this.extraKeys.repaint();
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
    // Seed this dock's persisted per-device settings before the splash so it boots at
    // the user's saved brightness/image-mode. Only push when actually persisted — an
    // absent value means "use the device/model default", so we skip the redundant HID write.
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

  /** Switch who paints the touch strip (WebUI mode selector). */
  setTouchStripMode(mode: TouchStripMode): void {
    this.extraKeys.setTouchStripMode(mode);
  }

  /** Mirror DriverManager.attachRealDriverListeners minus every WebUI hook. */
  private wireListeners(): void {
    wireCommonDriverEvents(this.driver, this.model, {
      onKey: (index, state) => this.childServer.sendKeyEvent(index, state),
      onDial: (event) => {
        if (!this.encoders.handleDial(event)) this.childServer.sendDial(event);
      },
      onTouch: (event) => this.childServer.sendTouch(event),
      onReinit: () => this.repaintExtraKeys(),
    });
    this.driver.on('disconnect', () => {
      log('info', this.model.id, 'disconnected');
      this.onDisconnect();
    });
    // Raw CORA image → worker: transform + write off the main thread. The onImage
    // mirror runs after the driver call and costs one callback — the WebUI only
    // encodes/broadcasts when this dock is the selected preview.
    this.childServer.on('image', ({ keyIndex, data, format }: ImageEvent) => {
      this.driver.renderCoraImage(keyIndex, data, format);
      this.onImage?.(keyIndex, data, format);
    });
    this.childServer.on(
      'touchImage',
      ({ data, region }: { data: Uint8Array; region?: TouchWindowRegion }) => {
        this.driver.renderTouchImage(data, region);
      },
    );
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
