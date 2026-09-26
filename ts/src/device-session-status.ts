// Status/identity/event-wiring helpers shared by DeviceSession and the primary
// dock (driver-manager-primary) — split out of device-session.ts to keep that
// file under the line-count cap.
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
  MDNS_SERVICE_NAME,
} from './types.js';
import type { KeyEvent, DockStatus, DialEvent, TouchInputEvent } from './types.js';
import type { DeviceIdentitySettings } from './settings-store.js';
import { advertisedGeometry, advertisedModel, advertisedTouchStrip } from './devices/registry.js';
import { deviceInputToExtraKey, deviceInputToMk2Index } from './key-map.js';
import { emulationProfiles } from './devices/model-overrides.js';
import type { DeviceDriver, DeviceModel } from './devices/driver.js';
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
  const pressable = pressableExtraKeys(model);
  return {
    index: s.index,
    ...(model.keyMap.extraKeys ? { extraKeys: model.keyMap.extraKeys } : {}),
    ...(pressable.length > 0 ? { pressableExtraKeys: pressable } : {}),
    ...(model.widgetDisplays
      ? { widgetDisplays: model.widgetDisplays.map(({ wireId, label }) => ({ wireId, label })) }
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
    onAction?: (message: string) => void;
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
  },
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
    let action: string;
    if (e.kind === 'press') action = e.state === 'down' ? 'pressed' : 'released';
    else action = `turned ${e.delta > 0 ? 'right' : 'left'} (${Math.abs(e.delta)})`;
    opts.onAction?.(`Knob ${e.index + 1} ${action}`);
    opts.onDial?.(e);
  });
  driver.on('touch', (e: TouchInputEvent) => {
    const { touchWidth, encoderCount } = advertisedGeometry(model);
    const zone =
      touchWidth && encoderCount && e.type !== 'swipe'
        ? Math.floor(e.x / (touchWidth / encoderCount)) + 1
        : undefined;
    const control = zone !== undefined ? `Knob ${zone} touch` : 'Touch strip';
    const end = e.endX !== undefined ? ` → (${e.endX}, ${e.endY})` : '';
    opts.onAction?.(`${control} ${e.type} (${e.x}, ${e.y})${end}`);
    opts.onTouch?.(e);
  });
  driver.on('inputAction', (message: string) => opts.onAction?.(message));
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
export function childFirmwareFor(model: DeviceModel, deviceInfo: DeviceInfo | undefined): string {
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
