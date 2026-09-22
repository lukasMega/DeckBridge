// Device identity resolution + the settings.json import/export surface (the write path itself
// lives in persisted-settings.ts — this is just the WebUIServer-facing glue around it).
import type { Settings, DeviceIdentitySettings } from '../../settings-store.js';
import { defaultMockConfig } from './mock-config.js';
import type {
  ControllerHost,
  DeviceIdentity,
  DriverMode,
  MockDeviceConfig,
  ReqError,
} from './types.js';
import type { ImageModeOverride } from '../../types.js';
import { DEFAULT_TOUCH_STRIP_MODE, MDNS_SERVICE_NAME } from '../../types.js';

export class SettingsIdentityController {
  constructor(
    private readonly host: ControllerHost,
    private readonly applyLogLevel: (level: unknown) => void,
    private readonly driverMode: () => DriverMode,
    private readonly mockConfig: () => MockDeviceConfig,
    private readonly imageModeOverride: () => ImageModeOverride,
    private readonly trySelectDock: (index: unknown) => ReqError | null,
    private readonly broadcastSelectedDeviceState: () => void,
  ) {}

  /** Identifiers sent to the Elgato app for the SELECTED dock (Settings, read-only): mockConfig in
   *  mock mode (mock is only ever dock 0, no deviceKey → WebUI hides the rename control), else the
   *  selected dock's identity from DriverManager, else fixed defaults before the first notifyDocks. */
  identity(): DeviceIdentity {
    if (this.driverMode() === 'mock') {
      return { ...this.mockConfig(), mdnsServiceName: MDNS_SERVICE_NAME };
    }
    const dock = this.host.selectedDockStatus();
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

  /** Stable identity for `deviceKey` — called by DriverManager/DeviceSession on connect. */
  getOrCreateIdentity(deviceKey: string, defaultMdnsName: string): DeviceIdentitySettings {
    return this.host.settings.getOrCreateIdentity(deviceKey, defaultMdnsName);
  }

  /** WebUI "Device Identity" edit: rename `deviceKey`'s persisted mDNS name. Caller (app.ts) still
   *  pushes the change live via DriverManager.applyMdnsNameForDeviceKey. */
  updateMdnsName(deviceKey: string, name: string): boolean {
    return this.host.settings.updateMdnsName(deviceKey, name);
  }

  json(): string {
    return this.host.settings.json();
  }

  openFile(): Promise<void> {
    return this.host.settings.openFile();
  }

  /** Parse `raw`, validate it's an object, assign known fields, persist. Throws on malformed
   *  JSON/non-object; unknown/invalid individual fields are ignored (not fatal). */
  applyJson(raw: string): void {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings must be a JSON object');
    }
    const s = parsed as Settings;
    if (s.logLevel !== undefined) this.applyLogLevel(s.logLevel);
    // Multi-deck travels with the file: importing one that enables it must
    // actually raise the cap, not just persist the flag (app.ts listens).
    if (typeof s.multiDeck === 'boolean') {
      this.host.settings.setMultiDeck(s.multiDeck);
      this.host.emit('setMultiDeck', s.multiDeck);
    }
    // Device tuning: invalid entries are dropped with a warn inside
    // importModelOverrides, never thrown — an imported file must not be able to
    // poison runtime state. '' = "all models", the sessions reopen either way.
    if (Object.hasOwn(parsed, 'modelOverrides')) {
      this.host.settings.importModelOverrides(s.modelOverrides);
      this.host.emit('modelOverridesChanged', '');
    }
    // devices[] first, so the selected dock's entry is in place before we (re)select + re-apply.
    if (this.host.settings.importDevices(s.devices)) this.reapplySelectedDeviceLive();
    // selectedDock is best-effort — an index absent on this host (file imported from a machine
    // with more docks) is ignored; trySelectDock() fires its own broadcast + reapply on change.
    if (typeof s.selectedDock === 'number' && Number.isInteger(s.selectedDock)) {
      if (!this.trySelectDock(s.selectedDock)) this.reapplySelectedDeviceLive();
    }
  }

  /** Push the selected dock's persisted brightness/override/imageMode to its driver + WS clients
   *  (used after a settings import). */
  private reapplySelectedDeviceLive(): void {
    const idx = this.host.selectedDock();
    this.broadcastSelectedDeviceState();
    this.host.emit('setImageOverride', this.imageModeOverride(), idx);
    this.host.emit('extraKeyChanged', idx);
    const e = this.host.settings.entryFor(this.host.selectedDeviceKey());
    if (typeof e?.brightness === 'number') this.host.emit('setBrightness', e.brightness, idx);
    if (e) {
      this.host.emit('touchStripModeChanged', idx, e.touchStripMode ?? DEFAULT_TOUCH_STRIP_MODE);
    }
  }
}
