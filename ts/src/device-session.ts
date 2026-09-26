// One extra emulated Network Dock (session index 1..MAX_DEVICE_SESSIONS-1): own CORA server pair on
// strided ports, own mDNS advert + identity, own WorkerHidDriver on its own worker thread. No
// WebUI/tray coupling — session 0 (DriverManager) keeps those, and the WebUI stays primary-only in v1.
import { log } from './logger.js';
import { DEFAULT_BRIGHTNESS } from './types.js';
import type {
  ExtraKeyConfig,
  ImageEvent,
  DockStatus,
  TouchWindowRegion,
  TouchStripMode,
} from './types.js';
import { sendSplashImages } from './splash-sender.js';
import { ExtraKeyWidgets } from './extra-keys.js';
import { EncoderActions, type EncoderOverride } from './encoders.js';
import { ExtraKeyActions } from './command-actions.js';
import type { DeviceModel, DeviceModelOverride } from './devices/driver.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';
import type { WorkerHidDriver } from './hid-worker-host.js';
import {
  sessionIdentity,
  buildDockStatus,
  repaintFrames,
  wireCommonDriverEvents,
  applyModelToServers,
} from './device-session-status.js';
import type {
  DeviceInfo,
  SessionIdentity,
  DockFrames,
  SessionServers,
  SessionServersFactory,
} from './device-session-status.js';

export {
  sessionIdentity,
  buildDockStatus,
  repaintFrames,
  wireCommonDriverEvents,
  applyModelToServers,
};
export type { DeviceInfo, SessionIdentity, DockFrames, SessionServers, SessionServersFactory };

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
  onAction?: (message: string) => void;
  /** Mirror of each raw CORA key image, called AFTER the driver render is
   *  queued (USB first). Opaque: the coordinator routes it to the WebUI's
   *  selected-dock preview. */
  onImage?: (keyIndex: number, data: Buffer, format: 'jpeg' | 'bmp') => void;
  /** True while this dock's "ignore brightness from Elgato app" override is
   *  on — the Elgato-app brightness for this dock is dropped then. Resolved per
   *  dock (by deviceKey) by the coordinator, not a global flag. */
  ignoreElgatoBrightness?: () => boolean;
  /** This dock's persisted brightness (from settings.json via
   *  getOrCreateDeviceIdentity) — seeded onto the driver in start(). */
  initialBrightness?: number;
  /** This dock's persisted extra-key config (by device wire id), resolved per
   *  press by the coordinator (deviceKey captured there) — see extra-keys.ts. */
  extraKeyConfigFor?: (wireId: number) => ExtraKeyConfig | undefined;
  /** This dock's persisted touch-strip mode. Default DEFAULT_TOUCH_STRIP_MODE. */
  touchStripMode?: TouchStripMode;
  /** This dock's 'deckbridge-repaint' interval, read live each widget tick. */
  touchStripRepaintMs?: () => number;
  /** WebUI mirror of each side-key widget image (null = cleared). */
  onExtraKeyImage?: (wireId: number, bmp: Uint8Array | null) => void;
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
  private readonly onAction?: (message: string) => void;
  private readonly onImage?: (keyIndex: number, data: Buffer, format: 'jpeg' | 'bmp') => void;
  private readonly ignoreElgatoBrightness?: () => boolean;
  private readonly initialBrightness?: number;
  private readonly extraKeyConfigFor?: (wireId: number) => ExtraKeyConfig | undefined;
  private readonly extraKeys: ExtraKeyWidgets;
  private readonly encoders: EncoderActions;
  private readonly extraKeyActions: ExtraKeyActions;
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
    this.onAction = opts.onAction;
    this.onImage = opts.onImage;
    this.ignoreElgatoBrightness = opts.ignoreElgatoBrightness;
    this.initialBrightness = opts.initialBrightness;
    this.brightness = opts.initialBrightness ?? DEFAULT_BRIGHTNESS;
    this.extraKeyConfigFor = opts.extraKeyConfigFor;
    this.extraKeys = new ExtraKeyWidgets(
      this.driver,
      (wireId) => this.extraKeyConfigFor?.(wireId),
      opts.touchStripMode,
      opts.touchStripRepaintMs,
      opts.onExtraKeyImage,
    );
    this.encoders = new EncoderActions(() => opts.encoderOverride?.());
    this.extraKeyActions = new ExtraKeyActions((wireId) => this.extraKeyConfigFor?.(wireId));
  }

  /** The underlying driver — exposed via DriverManager.getDriverForDock. */
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
    // the user's saved brightness. Only push when actually persisted — an
    // absent value means "use the device/model default", so we skip the redundant HID write.
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
      onAction: this.onAction,
      onKey: (index, state) => this.childServer.sendKeyEvent(index, state),
      onExtraKey: (wireId, state) => this.extraKeyActions.handleKey(wireId, state),
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
        this.extraKeys.noteTouchFrame(region);
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
