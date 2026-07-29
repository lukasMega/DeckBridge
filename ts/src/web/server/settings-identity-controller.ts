// Device identity resolution + the settings.json import/export surface (the write path itself
// lives in persisted-settings.ts — this is just the WebUIServer-facing glue around it).
import type { PersistedSettings } from './persisted-settings.js';
import type { Settings, DeviceIdentitySettings } from '../../settings-store.js';
import { defaultMockConfig } from './mock-config.js';
import type { DeviceIdentity, DriverMode, MockDeviceConfig } from './types.js';
import type { DockStatus, ImageModeOverride } from '../../types.js';
import { MDNS_SERVICE_NAME } from '../../types.js';

type ReqError = { error: string; status: number };

export class SettingsIdentityController {
  constructor(
    private readonly settings: PersistedSettings,
    private readonly driverMode: () => DriverMode,
    private readonly mockConfig: () => MockDeviceConfig,
    private readonly selectedDockStatus: () => DockStatus | undefined,
    private readonly selectedDock: () => number,
    private readonly selectedDeviceKey: () => string,
    private readonly imageModeOverride: () => ImageModeOverride,
    private readonly trySelectDock: (index: unknown) => ReqError | null,
    private readonly broadcastSelectedDeviceState: () => void,
    private readonly emit: (event: string, ...args: unknown[]) => boolean,
  ) {}

  /** Identifiers sent to the Elgato app for the SELECTED dock (Settings, read-only): mockConfig in
   *  mock mode (mock is only ever dock 0, no deviceKey → WebUI hides the rename control), else the
   *  selected dock's identity from DriverManager, else fixed defaults before the first notifyDocks. */
  identity(): DeviceIdentity {
    if (this.driverMode() === 'mock') {
      return { ...this.mockConfig(), mdnsServiceName: MDNS_SERVICE_NAME };
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

  /** Stable identity for `deviceKey` — called by DriverManager/DeviceSession on connect. */
  getOrCreateIdentity(deviceKey: string, defaultMdnsName: string): DeviceIdentitySettings {
    return this.settings.getOrCreateIdentity(deviceKey, defaultMdnsName);
  }

  /** WebUI "Device Identity" edit: rename `deviceKey`'s persisted mDNS name. Caller (app.ts) still
   *  pushes the change live via DriverManager.applyMdnsNameForDeviceKey. */
  updateMdnsName(deviceKey: string, name: string): boolean {
    return this.settings.updateMdnsName(deviceKey, name);
  }

  json(): string {
    return this.settings.json();
  }

  openFile(): Promise<void> {
    return this.settings.openFile();
  }

  /** Parse `raw`, validate it's an object, assign known fields, persist. Throws on malformed
   *  JSON/non-object; unknown/invalid individual fields are ignored (not fatal). */
  applyJson(raw: string): void {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings must be a JSON object');
    }
    const s = parsed as Settings;
    // devices[] first, so the selected dock's entry is in place before we (re)select + re-apply.
    if (this.settings.importDevices(s.devices)) this.reapplySelectedDeviceLive();
    // selectedDock is best-effort — an index absent on this host (file imported from a machine
    // with more docks) is ignored; trySelectDock() fires its own broadcast + reapply on change.
    if (typeof s.selectedDock === 'number' && Number.isInteger(s.selectedDock)) {
      if (!this.trySelectDock(s.selectedDock)) this.reapplySelectedDeviceLive();
    }
  }

  /** Push the selected dock's persisted brightness/override/imageMode to its driver + WS clients
   *  (used after a settings import). */
  private reapplySelectedDeviceLive(): void {
    const idx = this.selectedDock();
    this.broadcastSelectedDeviceState();
    this.emit('setImageOverride', this.imageModeOverride(), idx);
    this.emit('extraKeyChanged', idx);
    const e = this.settings.entryFor(this.selectedDeviceKey());
    if (typeof e?.brightness === 'number') this.emit('setBrightness', e.brightness, idx);
  }
}
