// One emulated Network Dock: its CORA server pair (CoraDock), whichever USB
// driver is attached, per-device prefs/widgets/knob/side-key actions, and the
// app's last frames. Dock 0's servers live for the process and DriverManager
// re-attaches drivers across replugs; docks 1.. start and stop with their USB
// unit (dock-scanner.ts).
import { log } from '../shared/logger.js';
import {
  clearTimer,
  DEFAULT_BRIGHTNESS,
  DEFAULT_MAC_ADDRESS,
  MDNS_SERVICE_NAME,
} from '../shared/types.js';
import type { DockStatus, KeyState, TouchStripMode, TouchWindowRegion } from '../shared/types.js';
import type { WidgetPaint } from '../shared/widget-layout.js';
import { sendSplashImages } from '../shared/splash-sender.js';
import { DEFAULT_MODEL, findModelById } from '../devices/registry.js';
import { applyModelOverrides } from '../devices/model-overrides.js';
import type { DockDriver, DeviceModel, DeviceModelOverride } from '../devices/driver.js';
import type { PersistedSettings } from '../infra/settings.js';
import type { DockPrefs } from '../infra/dock-prefs.js';
import { touchStripOptionsOf } from '../infra/settings-store.js';
import { ExtraKeyWidgets } from './extra-keys.js';
import { EncoderActions } from './encoders.js';
import { ExtraKeyActions } from './command-actions.js';
import type { CoraDock } from './cora-dock.js';
import { LastFrames, wireDockImages } from './dock-frames.js';
import type { ImageFormat } from './dock-frames.js';
import {
  buildDockStatus,
  knobRefresh,
  macToBytes,
  tapRefresh,
  wireCommonDriverEvents,
  wireMockDriverEvents,
} from './dock-status.js';
import type { DeviceInfo, DockIdentity, DriverEventSinks } from './dock-status.js';

/** The app's own default-brightness handshake follows pairing; re-push after it. */
const BRIGHTNESS_RESEND_MS = 1000;

/** Where a dock reports out. All optional: a dock without a WebUI mirror just runs. */
export interface DockHooks {
  /** Status may have changed (brightness, identity, pairing, start/stop). */
  changed?: () => void;
  /** The attached USB driver reported an unplug. */
  disconnect?: () => void;
  /** Grid key press (activity feed + key-map learn mode). */
  key?: (mk2Index: number, state: KeyState, wireId?: number) => void;
  action?: (message: string) => void;
  image?: (key: number, data: Buffer, format: ImageFormat) => void;
  touchImage?: (data: Uint8Array, region?: TouchWindowRegion) => void;
  widgetPaint?: (wireId: number, paint: WidgetPaint | null) => void;
  stripWrite?: (wireId: number, jpeg: Uint8Array, full: boolean) => void;
  /** The Elgato app set a brightness this dock applied (WebUI slider). */
  brightness?: (level: number) => void;
  imageSent?: () => void;
  /** The Elgato app's child client attached (after markPaired). */
  elgatoAttached?: () => void;
}

export type DockSettings = Pick<PersistedSettings, 'for' | 'getOrCreateIdentity' | 'markPaired'>;

export interface DockOptions {
  index: number;
  cora: CoraDock;
  /** CORA TCP ports: status + the bind-conflict message. */
  ports: { primary: number; child: number };
  settings: DockSettings;
  /** Known up front for a dock built around one USB unit; else resolveIdentity(). */
  identity?: DockIdentity;
  model?: DeviceModel;
  deviceInfo?: DeviceInfo;
  hooks?: DockHooks;
  getShuttingDown?: () => boolean;
}

export class Dock {
  readonly index: number;
  readonly cora: CoraDock;
  private readonly ports: { primary: number; child: number };
  private readonly settings: DockSettings;
  private readonly hooks: DockHooks;
  private readonly getShuttingDown: () => boolean;

  /** Effective model (registry + device tuning); swapped by applyTuning. */
  model: DeviceModel;
  /** Physical serial/firmware, reported when model.cora.usePhysicalIdentity. */
  deviceInfo: DeviceInfo | undefined;
  /** Undefined before the first connect → status() uses the DEFAULT_* identity. */
  identity: DockIdentity | undefined;
  brightness = DEFAULT_BRIGHTNESS;
  driver: DockDriver | null = null;

  /** The Elgato app's last CORA frames: replayed on replug, re-rendered on live tuning. */
  private readonly frames = new LastFrames();
  /** Display widgets on the extra keys / strip zones; created per attach. */
  private widgets: ExtraKeyWidgets | null = null;
  private readonly encoders: EncoderActions;
  private readonly extraKeyActions: ExtraKeyActions;
  private resendTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: DockOptions) {
    this.index = opts.index;
    this.cora = opts.cora;
    this.ports = opts.ports;
    this.settings = opts.settings;
    this.hooks = opts.hooks ?? {};
    this.getShuttingDown = opts.getShuttingDown ?? (() => false);
    this.model = opts.model ?? DEFAULT_MODEL;
    this.deviceInfo = opts.deviceInfo;
    this.identity = opts.identity;
    this.brightness = this.identityPrefs()?.brightness() ?? DEFAULT_BRIGHTNESS;
    // Both resolve the dock's current identity per event.
    this.encoders = new EncoderActions(
      () => {
        const prefs = this.identityPrefs();
        return prefs && { mode: prefs.stripMode(), encoders: prefs.encoders() };
      },
      undefined,
      (index) => knobRefresh(this.widgets, this.model, index),
    );
    this.extraKeyActions = new ExtraKeyActions(
      (wireId) => this.identityPrefs()?.extraKeyConfig(wireId),
      undefined,
      (wireId) => this.widgets?.refresh(wireId),
    );
    this.wireCora();
  }

  /** Live per-device prefs, with the runtime fallback before identity. */
  prefs(): DockPrefs {
    return this.settings.for(this.identity?.deviceKey ?? '');
  }

  /** Undefined before identity: no per-device settings apply yet. */
  private identityPrefs(): DockPrefs | undefined {
    return this.identity && this.settings.for(this.identity.deviceKey);
  }

  status(): DockStatus {
    return buildDockStatus({
      model: this.model,
      index: this.index,
      primaryPort: this.ports.primary,
      identity: this.identity,
      brightness: this.brightness,
      primaryConnected: this.cora.hasClient,
      elgatoConnected: this.cora.childHasClient,
      deviceInfo: this.deviceInfo,
    });
  }

  /** Resolve (or generate + persist) the identity for `deviceKey` and push it to the
   *  already-running CORA server — for a dock whose servers outlive its devices. */
  resolveIdentity(deviceKey: string): void {
    const identity = this.settings.getOrCreateIdentity(deviceKey, MDNS_SERVICE_NAME);
    this.identity = identity;
    const macAddress = macToBytes(identity.macAddress, [...DEFAULT_MAC_ADDRESS]);
    this.cora.server.setDeviceConfig({ serialNumber: identity.dockSerial, macAddress });
    this.cora.setMdnsServiceName(identity.mdnsServiceName);
  }

  /** Live-rename the mDNS advert (WebUI "Device Identity" edit). */
  renameMdns(name: string): void {
    if (!this.identity) return;
    this.identity.mdnsServiceName = name;
    this.cora.setMdnsServiceName(name);
    this.changed();
  }

  /** Advertise `model` over this dock's CORA pair. */
  setModel(model: DeviceModel, deviceInfo?: DeviceInfo): void {
    this.model = model;
    this.deviceInfo = deviceInfo;
    // A different model on a live driver: the old frames no longer fit the panel.
    if (this.driver) this.frames.clear();
    this.cora.applyModel(model, deviceInfo);
  }

  /** Take over an opened driver: wire it, seed the persisted prefs, splash, replay the
   *  app's last frames (same model only), start the widgets. */
  attach(driver: DockDriver, mock = false): void {
    if (this.stopped) {
      // A driver opened while the dock stopped: never wire it, still release it.
      void driver.close().catch(() => undefined);
      return;
    }
    if (this.driver) this.detach();
    this.driver = driver;
    const real = !__MOCK_BUILD__ || !mock;
    this.wireDriver(driver, real);
    this.seed(driver);
    if (real) {
      sendSplashImages(driver);
      this.frames.replay(driver, this.hooks.image);
    } else {
      this.frames.clear();
    }
    this.startWidgets(driver);
    this.changed();
  }

  /** Stop the widgets and drop every listener; the caller closes the driver. */
  detach(): DockDriver | null {
    const driver = this.driver;
    if (!driver) return null;
    this.widgets?.stop();
    this.widgets = null;
    driver.removeAllListeners();
    this.driver = null;
    return driver;
  }

  /** Bring up a dock built around one USB unit. Single attempt (maxAttempts: 1): a
   *  bind error throws to the caller, whose scan tick is the retry. */
  async start(driver: DockDriver): Promise<void> {
    await this.cora.startWithRetry({
      log,
      primaryPort: this.ports.primary,
      childPort: this.ports.child,
      maxAttempts: 1,
    });
    // stop() during the bind leaves nothing to attach to; the caller still owns the driver.
    if (this.stopped) throw new Error(`dock ${this.index} stopped during start`);
    this.cora.applyModel(this.model, this.deviceInfo);
    this.attach(driver);
  }

  /** Idempotent teardown: close the attached driver, stop the CORA pair
   *  (cancels the pairing watchdog; server.stop() also stops mDNS). */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.resendTimer = clearTimer(this.resendTimer);
    this.encoders.stop();
    this.extraKeyActions.stop();
    await this.detach()
      ?.close()
      .catch(() => undefined);
    await this.cora.stop();
    this.changed();
  }

  /** Apply + record a brightness level (WebUI slider or Elgato app). */
  setBrightness(level: number): void {
    this.brightness = level;
    this.driver?.setBrightness(level);
    this.changed();
  }

  /** Live device tuning (image-only change) for `modelId` ('' = any): swap the spec on
   *  the running driver and re-render the panel's frames + widget icons instead of a
   *  close→reopen. */
  applyTuning(
    modelId: string,
    overrideFor: (modelId: string) => DeviceModelOverride | undefined,
  ): void {
    const driver = this.driver;
    if (!driver || (modelId && driver.model.id !== modelId)) return;
    // From the REGISTRY entry, not driver.model: re-merging over an already merged
    // model would keep a value the user has just cleared.
    const registryModel = findModelById(driver.model.id);
    if (!registryModel) return;
    const override = overrideFor(registryModel.id);
    log(
      'info',
      'driverMgr',
      `dock ${this.index}: applying device tuning live to ${registryModel.id}`,
    );
    const effectiveModel = applyModelOverrides(registryModel, override);
    driver.applyOverrides(override, effectiveModel);
    this.model = effectiveModel;
    this.frames.repaint(driver);
    // Extra-key icons are rendered by the widget scheduler, not by CORA frames.
    this.widgets?.repaint();
  }

  /** Repaint the extra-key widgets (reinit / WebUI config change). */
  repaintWidgets(): void {
    this.widgets?.repaint();
  }

  /** WebUI "Run now" for a command-widget extra key. */
  forceRunWidget(wireId: number): void {
    this.widgets?.forceRun(wireId);
  }

  /** Switch who paints the touch strip (WebUI mode selector). */
  setTouchStripMode(mode: TouchStripMode): void {
    this.widgets?.setTouchStripMode(mode);
  }

  private changed(): void {
    this.hooks.changed?.();
  }

  private wireCora(): void {
    const child = this.cora.childServer;
    wireDockImages(child, {
      driver: () => this.driver,
      frames: this.frames,
      onImage: this.hooks.image,
      onTouchFrame: (region) => this.widgets?.noteTouchFrame(region),
      onTouchImage: this.hooks.touchImage,
    });
    child.on('brightness', (level: number) => this.onAppBrightness(level));
    child.on('clientConnected', () => this.onElgatoAttached());
    child.on('clientDisconnected', () => this.changed());
  }

  private onAppBrightness(level: number): void {
    if (this.prefs().brightnessOverride()) {
      log('debug', 'elgato', `dock ${this.index}: brightness ${level} ignored (override on)`);
      return;
    }
    log('info', 'elgato', `dock ${this.index}: brightness set to ${level}`);
    this.setBrightness(level);
    this.hooks.brightness?.(level);
  }

  private onElgatoAttached(): void {
    // A fresh session re-sends every image, so an overloaded driver may take them again.
    this.driver?.resumeImages?.();
    if (this.identity) this.settings.markPaired(this.identity.deviceKey);
    this.hooks.elgatoAttached?.();
    this.scheduleBrightnessResend();
    this.changed();
  }

  /** Re-push the saved brightness once pairing settles: the app's own
   *  default-brightness handshake would otherwise stomp the user's setting. */
  private scheduleBrightnessResend(): void {
    clearTimer(this.resendTimer);
    this.resendTimer = setTimeout(() => {
      this.resendTimer = null;
      if (this.stopped || this.getShuttingDown()) return;
      this.setBrightness(this.prefs().brightness() ?? this.brightness);
    }, BRIGHTNESS_RESEND_MS);
  }

  private wireDriver(driver: DockDriver, real: boolean): void {
    const child = this.cora.childServer;
    const sinks: DriverEventSinks = {
      onAction: this.hooks.action,
      onKey: (index, state, wireId) => {
        child.sendKeyEvent(index, state);
        this.hooks.key?.(index, state, wireId);
      },
      onExtraKey: (wireId, state) => this.extraKeyActions.handleKey(wireId, state),
      // The knob override / a widget tap refresh consumes the event; else the app gets it.
      onDial: (event) => {
        if (!this.encoders.handleDial(event)) child.sendDial(event);
      },
      onTouch: (event) => {
        if (!tapRefresh(this.widgets, this.model, event)) child.sendTouch(event);
      },
      onReinit: () => this.widgets?.repaint(),
      onStripWrite: this.hooks.stripWrite,
    };
    if (__MOCK_BUILD__ && !real) {
      wireMockDriverEvents(driver, sinks);
      return;
    }
    wireCommonDriverEvents(driver, this.model, sinks);
    driver.on('disconnect', () => {
      log('info', this.model.id, 'disconnected');
      this.hooks.disconnect?.();
    });
    if (this.hooks.imageSent) driver.on('imageSent', this.hooks.imageSent);
    // USB can't keep up with the app: drop its session (it reconnects and re-sends
    // everything) rather than queue without bound or lose strip patches silently.
    driver.on('overload', () => child.dropClient());
  }

  /** Push the persisted per-device settings before the splash; absent = device default. */
  private seed(driver: DockDriver): void {
    const prefs = this.identityPrefs();
    if (!prefs) return;
    const level = prefs.brightness();
    if (level !== undefined) {
      this.brightness = level;
      driver.setBrightness(level);
    }
    const entry = prefs.entry();
    const stripOptions = entry && touchStripOptionsOf(entry);
    if (stripOptions) driver.setTouchStripOptions(stripOptions);
  }

  /** No-op before identity or for models without extra keys / strip zones. */
  private startWidgets(driver: DockDriver): void {
    const prefs = this.identityPrefs();
    if (!prefs) return;
    this.widgets = new ExtraKeyWidgets(
      driver,
      (wireId) => prefs.extraKeyConfig(wireId),
      prefs.stripMode(),
      () => prefs.repaintMs(),
      this.hooks.widgetPaint,
      { tapFeedback: () => prefs.tapFeedback() },
    );
    this.widgets.start();
  }
}
