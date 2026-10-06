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
  MOCK_KEY_PRESS_DURATION_MS,
} from '../shared/types.js';
import type { DockStatus, KeyState, TouchStripMode, TouchWindowRegion } from '../shared/types.js';
import type { ClientApp } from '../shared/types.js';
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
import { begin, settleAll } from './settle.js';
import { LastFrames, wireDockImages } from './dock-frames.js';
import type { ImageFormat } from './dock-frames.js';
import { DockPages } from './dock-pages.js';
import { createDockStandby, dialInput } from './dock-standby.js';
import type { DockStandby } from './dock-standby.js';
import type { PageObservation } from '../shared/page-match.js';
import type { StandbyClock, StandbyTiming } from './standby-policy.js';
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
  /** The Elgato page recognition changed (the WebUI mirrors it). */
  pageObservation?: (obs: PageObservation) => void;
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
  /** Extra status fields only this dock knows (the browser deck's connected pages). */
  statusExtra?: () => Partial<DockStatus>;
  /** Test seams for the standby timers; production passes neither. */
  standbyClock?: StandbyClock;
  standbyTiming?: StandbyTiming;
}

export class Dock {
  readonly index: number;
  readonly cora: CoraDock;
  private readonly ports: { primary: number; child: number };
  private readonly settings: DockSettings;
  private readonly hooks: DockHooks;
  private readonly getShuttingDown: () => boolean;
  private readonly statusExtra: (() => Partial<DockStatus>) | undefined;

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
  private readonly standby: DockStandby;
  /** Page-following side-key layouts: which saved Elgato page the deck shows. */
  readonly pages: DockPages;
  private resendTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Click-to-press releases still pending, by key: one virtual press per key at a time. */
  private readonly virtualPresses = new Map<number, ReturnType<typeof setTimeout>>();
  /** Shared by every stop() caller so duplicates see the same completion/failure. */
  private stopping: Promise<void> | null = null;

  constructor(opts: DockOptions) {
    this.index = opts.index;
    this.cora = opts.cora;
    this.ports = opts.ports;
    this.settings = opts.settings;
    this.hooks = opts.hooks ?? {};
    this.getShuttingDown = opts.getShuttingDown ?? (() => false);
    this.statusExtra = opts.statusExtra;
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
    this.pages = new DockPages({
      index: this.index,
      model: () => this.model,
      prefs: () => this.identityPrefs(),
      repaint: () => this.widgets?.repaint(),
      onObservation: (obs) => this.hooks.pageObservation?.(obs),
    });
    this.extraKeyActions = new ExtraKeyActions(
      (wireId) => this.pages.layoutConfig(wireId),
      undefined,
      (wireId) => this.widgets?.refresh(wireId),
    );
    this.standby = createDockStandby({
      index: this.index,
      driver: () => this.driver,
      frames: this.frames,
      mirror: this.hooks.image,
      widgets: () => this.widgets,
      settings: () => this.prefs().standby(),
      pairedBefore: () => !!this.identityPrefs()?.entry()?.pairedAt,
      cora: this.cora,
      changed: () => this.changed(),
      clock: opts.standbyClock,
      timing: opts.standbyTiming,
    });
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
    const status = buildDockStatus({
      model: this.model,
      index: this.index,
      primaryPort: this.ports.primary,
      identity: this.identity,
      brightness: this.brightness,
      primaryConnected: this.cora.hasClient,
      elgatoConnected: this.cora.childHasClient,
      deviceInfo: this.deviceInfo,
      display: this.standby.display,
    });
    return this.statusExtra ? { ...status, ...this.statusExtra() } : status;
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
    this.pages.reset();
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
    this.pages.reset(); // frames replay below; this also publishes the geometry
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
    // Last: it restarts the standby clock over the splash/replayed frames.
    this.standby.onDriverAttached(this.brightness);
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
    this.standby.onDriverDetached();
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
  stop(): Promise<void> {
    this.stopping ??= this.runStop();
    return this.stopping;
  }

  private async runStop(): Promise<void> {
    // Everything up to the first await is synchronous: producers are dead and the
    // driver detached before any slow close can be observed.
    this.stopped = true;
    this.resendTimer = clearTimer(this.resendTimer);
    this.standby.stop();
    this.pages.stop();
    this.encoders.stop();
    this.extraKeyActions.stop();
    for (const t of this.virtualPresses.values()) clearTimeout(t);
    this.virtualPresses.clear();
    const driver = this.detach();
    try {
      // Concurrent: a driver that never acks close must not hold the CORA ports.
      await settleAll(`dock ${this.index} stop`, [
        begin(() => driver?.close()),
        begin(() => this.cora.stop()),
      ]);
    } finally {
      this.changed();
    }
  }

  /** Click-to-press from the WebUI: the key goes down on the CORA child now and up after a
   *  short hold. A real press on the same key wins (see wireDriver); a second click while one
   *  is pending is ignored, so no release is ever queued twice. */
  simulateKeyPress(mk2Index: number): boolean {
    if (this.stopped || mk2Index < 0 || mk2Index >= this.model.keyCount) return false;
    if (this.virtualPresses.has(mk2Index)) return false;
    this.standby.noteActivity();
    const child = this.cora.childServer;
    child.sendKeyEvent(mk2Index, 'down');
    this.hooks.key?.(mk2Index, 'down'); // no wireId: key-map learn must not take it as evidence
    this.virtualPresses.set(
      mk2Index,
      setTimeout(() => {
        this.virtualPresses.delete(mk2Index);
        child.sendKeyEvent(mk2Index, 'up');
        this.hooks.key?.(mk2Index, 'up');
      }, MOCK_KEY_PRESS_DURATION_MS),
    );
    return true;
  }

  /** Apply + record the requested brightness level (WebUI slider): counts as activity,
   *  so dragging it on a dimmed deck shows the change. */
  setBrightness(level: number): void {
    this.setRequestedBrightness(level);
    this.standby.noteActivity();
  }

  /** The requested level (what is persisted); standby decides the effective one. */
  private setRequestedBrightness(level: number): void {
    this.brightness = level;
    this.standby.setRequested(level);
    this.changed();
  }

  /** Standby settings changed (WebUI/import): re-evaluate; pixel shift needs a repaint. */
  reloadStandby(): void {
    this.standby.reload();
    this.repaintWidgets();
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

  /** A pushed channel changed: paint only widgets whose content changed. */
  paintChangedWidgets(): void {
    this.widgets?.paintChanged();
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
      onAppFrame: () => this.standby.noteAppTraffic(),
      onTouchFrame: (region) => this.widgets?.noteTouchFrame(region),
      onTouchImage: this.hooks.touchImage,
    });
    child.on('brightness', (level: number) => this.onAppBrightness(level));
    child.on('clientConnected', () => this.onElgatoAttached());
    child.on('clientDisconnected', () => {
      this.pages.reset();
      this.standby.onAppDetached();
      this.changed();
    });
    child.on('clientAppDetected', (app: ClientApp) => this.standby.onClientApp(app));
  }

  private onAppBrightness(level: number): void {
    if (this.prefs().brightnessOverride()) {
      log('debug', 'elgato', `dock ${this.index}: brightness ${level} ignored (override on)`);
      return;
    }
    log('info', 'elgato', `dock ${this.index}: brightness set to ${level}`);
    this.setRequestedBrightness(level);
    this.hooks.brightness?.(level);
  }

  private onElgatoAttached(): void {
    // A fresh session re-sends every image, so an overloaded driver may take them again.
    this.driver?.resumeImages?.();
    if (this.identity) this.settings.markPaired(this.identity.deviceKey);
    this.standby.onAppAttached();
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
      this.setRequestedBrightness(this.prefs().brightness() ?? this.brightness);
    }, BRIGHTNESS_RESEND_MS);
  }

  private wireDriver(driver: DockDriver, real: boolean): void {
    const child = this.cora.childServer;
    // Before the mock branch: mock docks are tracked too.
    driver.on('frameHash', (key: number, hash: string) => this.pages.noteFrame(key, hash));
    const sinks: DriverEventSinks = {
      onAction: this.hooks.action,
      onKey: (index, state, wireId) => {
        // The device's own report overwrites a pending virtual press: drop its release.
        clearTimeout(this.virtualPresses.get(index));
        this.virtualPresses.delete(index);
        // A swallowed waking press stays off the app; the activity feed / key-map learn still see it.
        if (!this.standby.noteInput({ kind: 'key', mk2: index, state })) {
          child.sendKeyEvent(index, state);
        }
        this.hooks.key?.(index, state, wireId);
      },
      onExtraKey: (wireId, state) => {
        if (!this.standby.noteInput({ kind: 'extraKey', wireId, state })) {
          this.extraKeyActions.handleKey(wireId, state);
        }
      },
      // The knob override / a widget tap refresh consumes the event; else the app gets it.
      onDial: (event) => {
        if (this.standby.noteInput(dialInput(event))) return;
        if (!this.encoders.handleDial(event)) child.sendDial(event);
      },
      onTouch: (event) => {
        if (this.standby.noteInput({ kind: 'touch' })) return;
        if (!tapRefresh(this.widgets, this.model, event)) child.sendTouch(event);
      },
      onReinit: () => {
        this.widgets?.repaint();
        this.standby.onDeviceReinit();
      },
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
    driver.on('imagesDrained', () => this.onImagesDrained(driver));
  }

  /** The worker drained after an overload that paused local producers: put back what was
   *  dropped. CORA frames only replay if the CORA side isn't still suspended (a fresh
   *  session re-sends them anyway). Widgets repaint with their paint cache cleared. */
  private onImagesDrained(driver: DockDriver): void {
    if (this.stopped || this.getShuttingDown() || this.driver !== driver) return;
    log('info', this.model.id, `dock ${this.index}: USB backlog drained, repainting`);
    sendSplashImages(driver);
    this.frames.replay(driver);
    this.widgets?.repaint();
  }

  /** Push the persisted per-device settings before the splash; absent = device default. */
  private seed(driver: DockDriver): void {
    const prefs = this.identityPrefs();
    if (!prefs) return;
    const level = prefs.brightness();
    if (level !== undefined) {
      this.brightness = level;
      this.standby.setRequested(level);
      // Before the splash, as ever; standby re-applies any cap once attached.
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
      (wireId) => this.pages.layoutConfig(wireId),
      prefs.stripMode(),
      () => prefs.repaintMs(),
      this.hooks.widgetPaint,
      { tapFeedback: () => prefs.tapFeedback(), pixelShift: () => prefs.standby().pixelShift },
    );
    this.widgets.start();
  }
}
