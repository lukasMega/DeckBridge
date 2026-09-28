// Status/identity/event-wiring helpers for every Dock (dock.ts), kept apart
// so dock.ts stays under the line-count cap.
import { log } from '../shared/logger.js';
import {
  ELGATO_TCP_PORT,
  ELGATO_CHILD_PORT,
  CORA_PORT_STRIDE,
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  DEFAULT_MAC_ADDRESS_STRING,
  MDNS_SERVICE_NAME,
  PLUS_TOUCH_WIDTH,
} from '../shared/types.js';
import type {
  KeyEvent,
  DockStatus,
  DialEvent,
  TouchInputEvent,
  WidgetDisplayInfo,
} from '../shared/types.js';
import type { DeviceIdentitySettings } from '../infra/settings-store.js';
import { advertisedGeometry, advertisedModel, advertisedTouchStrip } from '../devices/registry.js';
import { deviceInputToExtraKey, deviceInputToMk2Index } from '../shared/key-map.js';
import { emulationProfiles } from '../devices/model-overrides.js';
import type {
  DeviceDriver,
  DockDriver,
  DeviceModel,
  DeviceWidgetDisplay,
} from '../devices/driver.js';
import type { ElgatoServer } from '../cora/primary-server.js';
import type { ElgatoChildServer } from '../cora/child-server.js';
import type { DeviceConfig } from '../cora/types.js';
import type { ExtraKeyWidgets } from './extra-keys.js';

/** Physical serial/firmware forwarded when model.cora.usePhysicalIdentity. */
export interface DeviceInfo {
  serial?: string;
  firmware?: string;
}

/** Identity for a scanned dock: ports from CORA_PORT_STRIDE off the primary pair (a
 *  runtime resource, legitimately scan-order-dependent), everything else from
 *  getOrCreateDeviceIdentity — stable across restart/replug. */
export interface DockSlot {
  index: number; // 1..MAX_DOCKS-1 (scanned docks only) — port assignment only
  primaryPort: number; // ELGATO_TCP_PORT + CORA_PORT_STRIDE * index
  childPort: number; // ELGATO_CHILD_PORT + CORA_PORT_STRIDE * index
  deviceKey: string;
  mdnsServiceName: string;
  dockSerial: string;
  childSerial: string;
  macAddress: string;
}

export function dockSlot(index: number, identity: DeviceIdentitySettings): DockSlot {
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

/** The identity fields a dock reports — satisfied by both DockSlot (an
 *  extra) and DeviceIdentitySettings (the primary). */
export type DockIdentity = Omit<DockSlot, 'index' | 'primaryPort' | 'childPort'>;

/** "aa:bb:cc:dd:ee:ff" → the 6 bytes CORA's deviceConfig wants, else `fallback`
 *  (a persisted identity and the mock config both feed setDeviceConfig). */
export function macToBytes(mac: string, fallback: number[]): number[] {
  const parts = mac.split(':');
  return parts.length === 6 ? parts.map((p) => parseInt(p, 16)) : fallback;
}

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
 *  and every scanned dock report the same fields in the same order. */
// oxlint-disable-next-line complexity -- flat fallback chain, not branching logic
export function buildDockStatus(s: DockStatusInput): DockStatus {
  const { model, identity, deviceInfo } = s;
  // Mirrors applyModelToServers: only childSerialNumber/childFirmwareVersion are ever patched
  // with the physical device's own values, and only when usePhysicalIdentity is set — everything
  // else is the dock's own fixed identity (dockSerial/mdns) or the shared defaults.
  const usePhysical = model.cora.usePhysicalIdentity;
  const encoderCount = physicalEncoderCount(model);
  const pressable = pressableExtraKeys(model);
  return {
    index: s.index,
    ...(model.keyMap.extraKeys ? { extraKeys: model.keyMap.extraKeys } : {}),
    ...(pressable.length > 0 ? { pressableExtraKeys: pressable } : {}),
    ...(model.widgetDisplays
      ? { widgetDisplays: model.widgetDisplays.map(widgetDisplayInfo) }
      : {}),
    ...(encoderCount ? { encoderCount } : {}),
    ...(model.cora.advertiseAs ? { coraProfile: model.cora.advertiseAs } : {}),
    ...advertisedTouchStrip(model),
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

/** The extra keys that have a switch — those with an entry in keyMap.extraKeyInputs. */
function pressableExtraKeys(model: DeviceModel): readonly number[] {
  const inputs = model.keyMap.extraKeyInputs ?? [];
  return (model.keyMap.extraKeys ?? []).filter((_, i) => inputs[i] !== undefined);
}

/** True when the model maps device wire input codes to CORA (MK.2) indices. */
function hasInputKeyMap(model: DeviceModel): boolean {
  return model.keyMap.wireInputToCora != null || model.keyMap.inputOffset != null;
}

/** Activity-log line for a knob event (real and mock drivers alike). */
export function dialActionText(e: DialEvent): string {
  let action: string;
  if (e.kind === 'press') action = e.state === 'down' ? 'pressed' : 'released';
  else action = `turned ${e.delta > 0 ? 'right' : 'left'} (${Math.abs(e.delta)})`;
  return `Knob ${e.index + 1} ${action}`;
}

/** Activity-log line for a touch-strip gesture (real and mock drivers alike). */
export function touchActionText(e: TouchInputEvent, model: DeviceModel): string {
  const { touchWidth, encoderCount } = advertisedGeometry(model);
  const zone =
    touchWidth && encoderCount && e.type !== 'swipe'
      ? zoneIndex(e.x, touchWidth, encoderCount) + 1
      : undefined;
  const control = zone !== undefined ? `Knob ${zone} touch` : 'Touch strip';
  const end = e.endX !== undefined ? ` → (${e.endX}, ${e.endY})` : '';
  return `${control} ${e.type} (${e.x}, ${e.y})${end}`;
}

/** Where a dock routes its driver's input events. */
export interface DriverEventSinks {
  onAction?: (message: string) => void;
  /** `wireId` is the raw device code the press arrived on (pre-keyMap);
   *  undefined for identity-mapped models. Key-map learn mode needs it —
   *  a wrong map is exactly what it is there to fix. */
  onKey: (mk2Index: number, state: KeyEvent['state'], wireId?: number) => void;
  /** Press on an extra key with a switch (keyMap.extraKeyInputs); `wireId` is the
   *  extra key's image wire id, as keyed in its ExtraKeyConfig. */
  onExtraKey?: (wireId: number, state: KeyEvent['state']) => void;
  /** Encoder press/rotate (Stream Deck + emulation). Dropped by the child
   *  server when the advertised geometry declares no encoders. */
  onDial?: (event: DialEvent) => void;
  /** Touch-strip gesture (Stream Deck + emulation). */
  onTouch?: (event: TouchInputEvent) => void;
  /** Sleep/wake re-init sent CLE ALL — repaint the extra-key widgets it wiped. */
  onReinit: () => void;
  /** A touch-strip upload reached the device (WebUI strip preview mirror). */
  onStripWrite?: (wireId: number, jpeg: Uint8Array, full: boolean) => void;
}

/** Wire a USB driver's input events: key dispatch (wire→mk2 mapping + logging),
 *  knobs, touch, reinit repaint. 'disconnect' differs per owner and stays with the caller. */
export function wireCommonDriverEvents(
  driver: Pick<DeviceDriver, 'on'>,
  model: DeviceModel,
  opts: DriverEventSinks,
): void {
  driver.on('key', (e: KeyEvent) => {
    const key = hasInputKeyMap(model) ? e.keyIndex : e.keyIndex + 1;
    opts.onAction?.(`Key ${key} ${e.state === 'down' ? 'pressed' : 'released'}`);
    if (!hasInputKeyMap(model)) {
      log('info', 'key', `${model.id} key=${e.keyIndex} ${e.state}`);
      opts.onKey(e.keyIndex, e.state);
      return;
    }
    const index = deviceInputToMk2Index(e.keyIndex, model);
    const wire = e.keyIndex.toString(16).padStart(2, '0');
    if (index < 0) {
      // Outside the emulated grid: an AKP05E right-column key (re-paired as a Stream
      // Deck +) runs its DeckBridge command; the 293S 6th column has no switches.
      const extraKey = deviceInputToExtraKey(e.keyIndex, model);
      if (extraKey < 0) return;
      log('info', 'key', `${model.id} wire=0x${wire} → extra key ${extraKey} ${e.state}`);
      opts.onExtraKey?.(extraKey, e.state);
      return;
    }
    log('info', 'key', `${model.id} wire=0x${wire} → mk2=${index} ${e.state}`);
    opts.onKey(index, e.state, e.keyIndex);
  });
  driver.on('dial', (e: DialEvent) => {
    opts.onAction?.(dialActionText(e));
    opts.onDial?.(e);
  });
  driver.on('touch', (e: TouchInputEvent) => {
    opts.onAction?.(touchActionText(e, model));
    opts.onTouch?.(e);
  });
  driver.on('inputAction', (message: string) => opts.onAction?.(message));
  driver.on('reinit', opts.onReinit);
  driver.on('stripWrite', (wireId: number, jpeg: Uint8Array, full: boolean) =>
    opts.onStripWrite?.(wireId, jpeg, full),
  );
}

/** The mock's events: grid keys already arrive as mk2 indices and extra keys as
 *  image wire ids, so no key map applies. */
export function wireMockDriverEvents(driver: DockDriver, opts: DriverEventSinks): void {
  driver.on('key', (e: KeyEvent) => opts.onKey(e.keyIndex, e.state));
  driver.on('extraKey', ({ wireId, state }: { wireId: number; state: KeyEvent['state'] }) => {
    opts.onAction?.(`Extra key ${wireId} ${state === 'down' ? 'pressed' : 'released'}`);
    opts.onExtraKey?.(wireId, state);
  });
  driver.on('dial', (e: DialEvent) => {
    opts.onAction?.(dialActionText(e));
    opts.onDial?.(e);
  });
  driver.on('touch', (e: TouchInputEvent) => {
    opts.onAction?.(touchActionText(e, driver.model));
    opts.onTouch?.(e);
  });
  driver.on('stripWrite', (wireId: number, jpeg: Uint8Array, full: boolean) =>
    opts.onStripWrite?.(wireId, jpeg, full),
  );
}

/** A widget display with the geometry the WebUI needs to place device strip writes. */
function widgetDisplayInfo(display: DeviceWidgetDisplay): WidgetDisplayInfo {
  const { wireId, label, image, stripX } = display;
  return {
    wireId,
    label,
    width: image.width,
    height: image.height,
    ...(stripX !== undefined ? { stripX } : {}),
    rotate: image.rotate,
    flipH: image.flipH,
    flipV: image.flipV,
  };
}

/** 0-based zone under strip x when `width` is cut into `count` equal zones. */
function zoneIndex(x: number, width: number, count: number): number {
  return Math.min(Math.max(Math.floor(x / (width / count)), 0), count - 1);
}

/** The strip's widget displays left→right — the order tap zones and knobs count in. */
function zonesLeftToRight(model: DeviceModel): number[] {
  return (model.widgetDisplays ?? [])
    .map((display, i) => ({ wireId: display.wireId, x: display.stripX ?? i }))
    .toSorted((a, b) => a.x - b.x)
    .map((zone) => zone.wireId);
}

/** The widget display (wire id) under a touch, in advertised strip coordinates. */
export function zoneForTouch(model: DeviceModel, e: TouchInputEvent): number | undefined {
  const zones = zonesLeftToRight(model);
  if (zones.length === 0) return undefined;
  // `||`: modelToChildGeometry reports 0 (not undefined) for a model with no advertised strip.
  const width = advertisedGeometry(model).touchWidth || PLUS_TOUCH_WIDTH;
  return zones[zoneIndex(e.x, width, zones.length)];
}

/** The widget display (wire id) above knob `index`. */
export function zoneForKnob(model: DeviceModel, index: number): number | undefined {
  return zonesLeftToRight(model)[index];
}

/** A strip tap on a zone DeckBridge shows a widget on refreshes it and is consumed
 *  (true); anything else — hold, swipe, an app-owned zone — goes to the app. */
export function tapRefresh(
  widgets: Pick<ExtraKeyWidgets, 'ownsZoneNow' | 'refresh'> | null,
  model: DeviceModel,
  e: TouchInputEvent,
): boolean {
  if (e.type !== 'tap' || !widgets) return false;
  const wireId = zoneForTouch(model, e);
  return wireId !== undefined && widgets.ownsZoneNow(wireId) && widgets.refresh(wireId);
}

/** Knob press refresh: the widget on the zone above knob `index`, if any. */
export function knobRefresh(
  widgets: Pick<ExtraKeyWidgets, 'refresh'> | null,
  model: DeviceModel,
  index: number,
): void {
  const wireId = zoneForKnob(model, index);
  if (wireId !== undefined) widgets?.refresh(wireId);
}

/** Child firmware reported over CORA: the physical device's own when the model
 *  forwards it, else the advertised profile's line (the desktop rejects 1.01.x for a
 *  Stream Deck +), else the shared default. */
export function childFirmwareFor(model: DeviceModel, deviceInfo: DeviceInfo | undefined): string {
  if (model.cora.usePhysicalIdentity && deviceInfo?.firmware) return deviceInfo.firmware;
  return advertisedModel(model).cora.childFirmwareVersion ?? DEFAULT_CHILD_FIRMWARE_VERSION;
}

/** Server-facing half of DriverManager.applyDeviceModel (no WebUI): advertises the
 *  model's PID/geometry/identity to the desktop over both CORA ports. Shared by the
 *  primary and every scanned dock. */
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
