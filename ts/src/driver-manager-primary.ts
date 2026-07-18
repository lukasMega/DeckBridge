// Primary dock (index 0) presentation state, split out of driver-manager.ts:
// per-device identity, brightness, extra-key widgets, and the saved-frame
// replay across a USB replug. The connection lifecycle (probe/reconnect/mode
// switching) stays in DriverManager, which passes the live driver in.
import {
  ELGATO_TCP_PORT,
  DEFAULT_BRIGHTNESS,
  DEFAULT_MAC_ADDRESS,
  DEFAULT_MAC_ADDRESS_STRING,
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  MDNS_SERVICE_NAME,
} from './types.js';
import type { DockStatus } from './types.js';
import { DEFAULT_MODEL } from './devices/registry.js';
import { ExtraKeyWidgets } from './extra-keys.js';
import type { DeviceInfo } from './device-session.js';
import type { DeviceDriver, DeviceModel } from './devices/driver.js';
import type { ElgatoServer } from './elgato.js';
import type { WebUIServer } from './web/server';
import type { DeviceIdentitySettings } from './settings-store.js';

export interface PrimaryDockDeps {
  webui: WebUIServer;
  server: ElgatoServer;
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

  /** The Elgato app's last CORA frames, captured on USB disconnect: the app
   *  keeps its TCP pairing across a replug and never re-pushes, so these are
   *  replayed over the splash on reconnect. Guarded by model id (a different
   *  device must not inherit them); cleared after replay. */
  private savedFrames: Map<number, { data: Buffer; format: 'jpeg' | 'bmp' }> | null = null;
  private savedModelId: string | null = null;

  constructor(deps: PrimaryDockDeps) {
    this.deps = deps;
  }

  /** Resolve (or generate + persist) the identity for `deviceKey` and push it
   *  (mac + dock serial + mdns name) to the running CORA server. Unlike extras
   *  (identity passed at server construction), the primary server is a fixed
   *  singleton created before any device connects — its identity can only
   *  change post-construction. */
  resolveIdentity(deviceKey: string): void {
    const identity = this.deps.webui.getOrCreateDeviceIdentity(deviceKey, MDNS_SERVICE_NAME);
    this.identity = identity;
    const macParts = identity.macAddress.split(':');
    const macBytes =
      macParts.length === 6 ? macParts.map((p) => parseInt(p, 16)) : [...DEFAULT_MAC_ADDRESS];
    this.deps.server.setDeviceConfig({ serialNumber: identity.dockSerial, macAddress: macBytes });
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
   *  (brightness + image-mode override) before the splash. Only pushes what's
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

  /** (Re)start the extra-key widget scheduler. No-op for models without
   *  extraKeys or before identity. */
  startWidgets(driver: DeviceDriver): void {
    this.stopWidgets();
    const identity = this.identity;
    if (!identity) return;
    this.widgets = new ExtraKeyWidgets(driver, (wireId) =>
      this.deps.webui.extraKeyConfigFor(identity.deviceKey, wireId),
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

  /** Dock status for the WebUI. Mirrors DeviceSession.status() but with the
   *  primary's fixed port + hardcoded-default fallbacks. */
  // oxlint-disable-next-line complexity -- flat fallback chain, not branching logic
  status(primaryConnected: boolean, elgatoConnected: boolean): DockStatus {
    const { model, deviceInfo, identity } = this;
    const usePhysical = model.cora.usePhysicalIdentity;
    return {
      index: 0,
      ...(model.keyMap.extraKeys ? { extraKeys: model.keyMap.extraKeys } : {}),
      modelId: model.id,
      modelName: model.name,
      keyCount: model.keyCount,
      columns: model.columns,
      rows: model.rows,
      primaryPort: ELGATO_TCP_PORT,
      primaryConnected,
      elgatoConnected,
      brightness: this.brightness,
      dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
      childFirmwareVersion: (usePhysical && deviceInfo?.firmware) || DEFAULT_CHILD_FIRMWARE_VERSION,
      serialNumber: identity?.dockSerial ?? DEFAULT_DOCK_SERIAL_NUMBER,
      childSerialNumber:
        (usePhysical && deviceInfo?.serial) || identity?.childSerial || DEFAULT_CHILD_SERIAL_NUMBER,
      productId: model.cora.productId,
      macAddress: identity?.macAddress ?? DEFAULT_MAC_ADDRESS_STRING,
      mdnsServiceName: identity?.mdnsServiceName ?? MDNS_SERVICE_NAME,
      deviceKey: identity?.deviceKey ?? '',
    };
  }
}
