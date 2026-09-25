// Primary dock (index 0) presentation state, split out of driver-manager.ts:
// per-device identity, brightness, extra-key widgets, and the saved-frame
// replay across a USB replug. The connection lifecycle (probe/reconnect/mode
// switching) stays in DriverManager, which passes the live driver in.
import {
  ELGATO_TCP_PORT,
  DEFAULT_BRIGHTNESS,
  DEFAULT_MAC_ADDRESS,
  MDNS_SERVICE_NAME,
} from './types.js';
import type {
  DialEvent,
  DockStatus,
  KeyState,
  TouchStripMode,
  TouchWindowRegion,
} from './types.js';
import { DEFAULT_MODEL } from './devices/registry.js';
import { ExtraKeyWidgets } from './extra-keys.js';
import { EncoderActions } from './encoders.js';
import { ExtraKeyActions } from './command-actions.js';
import { buildDockStatus, repaintFrames } from './device-session.js';
import type { DeviceInfo } from './device-session.js';
import type { DeviceDriver, DeviceModel, DeviceModelOverride } from './devices/driver.js';
import type { ElgatoServer, ElgatoChildServer } from './elgato.js';

import type { WebUIServer } from './web/server';
import type { DeviceIdentitySettings } from './settings-store.js';
import { touchStripOptionsOf } from './settings-store.js';

/** "aa:bb:cc:dd:ee:ff" → the 6 bytes CORA's deviceConfig wants, else `fallback`
 *  (a persisted identity and the mock config both feed setDeviceConfig). */
export function macToBytes(mac: string, fallback: number[]): number[] {
  const parts = mac.split(':');
  return parts.length === 6 ? parts.map((p) => parseInt(p, 16)) : fallback;
}

export interface PrimaryDockDeps {
  webui: WebUIServer;
  server: ElgatoServer;
  /** Its strip frames start the widgets' repaint-mode hold-off (noteTouchFrame). */
  childServer?: Pick<ElgatoChildServer, 'on'>;
}

export class PrimaryDock {
  private readonly deps: PrimaryDockDeps;

  model: DeviceModel = DEFAULT_MODEL;
  brightness = DEFAULT_BRIGHTNESS;
  /** Physical serial/firmware from the real driver on connect; reported by
   *  status() when model.cora.usePhysicalIdentity, else DEFAULT_*. */
  deviceInfo: DeviceInfo | undefined;
  /** Stable per-physical-device identity (mac/serials/mdns), resolved on
   *  connect (extras' analog is SessionIdentity). Undefined pre-connect →
   *  status() uses DEFAULT_*. */
  identity: DeviceIdentitySettings | undefined;

  /** Display widgets on the extra keys (293S 6th column, display-only).
   *  Created per connect; config resolves per tick from persisted settings. */
  private widgets: ExtraKeyWidgets | null = null;

  /** Knob override; resolves this dock's current identity per event. */
  private readonly encoders = new EncoderActions(() => {
    const key = this.identity?.deviceKey;
    if (key === undefined) return undefined;
    const { webui } = this.deps;
    return { mode: webui.touchStripModeFor(key), encoders: webui.encoderSettingsFor(key) };
  });

  /** Extra-key press commands; resolves this dock's current identity per press. */
  private readonly extraKeyActions = new ExtraKeyActions((wireId) => {
    const key = this.identity?.deviceKey;
    return key === undefined ? undefined : this.deps.webui.extraKeyConfigFor(key, wireId);
  });

  /** The Elgato app's last CORA frames, captured on USB disconnect: the app
   *  keeps its TCP pairing across a replug and never re-pushes, so these are
   *  replayed over the splash on reconnect. Guarded by model id (a different
   *  device must not inherit them); cleared after replay. */
  private savedFrames: Map<number, { data: Buffer; format: 'jpeg' | 'bmp' }> | null = null;
  private savedModelId: string | null = null;

  constructor(deps: PrimaryDockDeps) {
    this.deps = deps;
    deps.childServer?.on('touchImage', ({ region }: { region?: TouchWindowRegion }) =>
      this.widgets?.noteTouchFrame(region),
    );
  }

  /** Resolve (or generate + persist) the identity for `deviceKey` and push it
   *  (mac + dock serial + mdns name) to the running CORA server. Unlike extras
   *  (identity passed at server construction), the primary server is a fixed
   *  singleton created before any device connects — its identity can only
   *  change post-construction. */
  resolveIdentity(deviceKey: string): void {
    const identity = this.deps.webui.getOrCreateDeviceIdentity(deviceKey, MDNS_SERVICE_NAME);
    this.identity = identity;
    const macAddress = macToBytes(identity.macAddress, [...DEFAULT_MAC_ADDRESS]);
    this.deps.server.setDeviceConfig({ serialNumber: identity.dockSerial, macAddress });
    this.deps.server.setMdnsServiceName(identity.mdnsServiceName);
  }

  /** Live-rename the mDNS advert when `deviceKey` matches this dock. */
  applyMdnsName(deviceKey: string, name: string): boolean {
    if (this.identity?.deviceKey !== deviceKey) return false;
    this.identity.mdnsServiceName = name;
    this.deps.server.setMdnsServiceName(name);
    return true;
  }

  /** Seed the freshly connected driver with its persisted per-device settings
   *  (brightness, image-mode override, strip options) before the splash. Only pushes what's
   *  actually persisted — absent = use the device/model default. */
  seedFromIdentity(driver: DeviceDriver): void {
    if (!this.identity) return;
    if (this.identity.brightness !== undefined) {
      this.brightness = this.identity.brightness;
      driver.setBrightness(this.brightness);
    }
    if (this.identity.imageModeOverride != null) {
      driver.setImageOverride?.(this.identity.imageModeOverride);
    }
    const stripOptions = touchStripOptionsOf(this.identity);
    if (stripOptions) driver.setTouchStripOptions?.(stripOptions);
  }

  /** Apply + record a brightness level so status() reflects it. */
  setBrightness(driver: DeviceDriver | null, level: number): void {
    this.brightness = level;
    driver?.setBrightness(level);
  }

  /** On USB disconnect: capture the app's last frames (before applyDeviceModel
   *  wipes the cache) for replay on replug, and stop the widget scheduler. */
  onDisconnect(modelId: string): void {
    this.savedFrames = this.deps.webui.dockFramesSnapshot(0);
    this.savedModelId = modelId;
    this.stopWidgets();
  }

  /** After a USB replug, repaint the deck with the saved CORA frames (see
   *  savedFrames). Only replays when the same model reconnected; also restores
   *  the WebUI preview that applyDeviceModel blanked. */
  repaintFromSavedFrames(driver: DeviceDriver): void {
    const frames = this.savedFrames;
    this.savedFrames = null;
    if (!frames || this.savedModelId !== driver.model.id) return;
    for (const [key, { data, format }] of frames) {
      driver.renderCoraImage?.(key, data, format);
      this.deps.webui.notifyDockImage(0, key, data, format);
    }
  }

  /** Live device tuning (image-only change): swap the spec on the running
   *  driver and re-render what is on the panel, instead of a close→reopen. */
  applyLiveTuning(
    driver: DeviceDriver,
    overrides: DeviceModelOverride | undefined,
    effectiveModel: DeviceModel,
  ): void {
    driver.applyOverrides?.(overrides, effectiveModel);
    this.model = effectiveModel;
    repaintFrames(driver, this.deps.webui.dockFramesSnapshot(0));
    // Extra-key icons are rendered by the widget scheduler, not by CORA frames.
    this.repaintWidgets();
  }

  /** (Re)start the extra-key widget scheduler. No-op for models without
   *  extraKeys or before identity. */
  startWidgets(driver: DeviceDriver): void {
    this.stopWidgets();
    const identity = this.identity;
    if (!identity) return;
    this.widgets = new ExtraKeyWidgets(
      driver,
      (wireId) => this.deps.webui.extraKeyConfigFor(identity.deviceKey, wireId),
      this.deps.webui.touchStripModeFor(identity.deviceKey),
      () => this.deps.webui.devicePrefs.touchStripRepaintMsFor(identity.deviceKey),
    );
    this.widgets.start();
  }

  stopWidgets(): void {
    this.widgets?.stop();
    this.widgets = null;
  }

  repaintWidgets(): void {
    this.widgets?.repaint();
  }

  forceRunWidget(wireId: number): void {
    this.widgets?.forceRun(wireId);
  }

  /** Switch who paints the touch strip (WebUI mode selector). */
  setTouchStripMode(mode: TouchStripMode): void {
    this.widgets?.setTouchStripMode(mode);
  }

  /** True when the knob override consumed `event` — it must not reach the app. */
  handleDial(event: DialEvent): boolean {
    return this.encoders.handleDial(event);
  }

  /** Press on an extra key with a switch — runs its configured command. */
  handleExtraKey(wireId: number, state: KeyState): void {
    this.extraKeyActions.handleKey(wireId, state);
  }

  /** Dock status for the WebUI. Same builder as DeviceSession.status(), with the
   *  primary's fixed port and (pre-connect) its DEFAULT_* identity fallbacks. */
  status(primaryConnected: boolean, elgatoConnected: boolean): DockStatus {
    return buildDockStatus({
      model: this.model,
      index: 0,
      primaryPort: ELGATO_TCP_PORT,
      identity: this.identity,
      brightness: this.brightness,
      primaryConnected,
      elgatoConnected,
      deviceInfo: this.deviceInfo,
    });
  }
}
