/** Generic USB HID worker message protocol. */
import type { KeyState, CommEntry, ImageModeOverride } from './types.js';
import type { DeviceModelId, DeviceImageSpec } from './devices/driver.js';
import type { LogLevel } from './logger.js';

export type WorkerComm = Omit<CommEntry, 'ts'>;

export type MainToWorker =
  | { type: 'open'; modelId: DeviceModelId }
  // Raw CORA image: the worker transforms (resize/rotate/encode) + caches it,
  // then writes it to the device. Off the main thread so the 50–200 ms FFI
  // transform never stalls the CORA ACK loop (see P1).
  | { type: 'image'; keyIndex: number; bytes: Uint8Array; format: 'jpeg' | 'bmp' }
  // Already-native bytes (pre-encoded) — written verbatim, no transform.
  | { type: 'sendImage'; keyIndex: number; bytes: Uint8Array }
  // Splash source image: the worker transforms with the provided spec (which
  // may differ from model.image) and then writes it. Offloads the 50–200 ms
  // synchronous FFI call that would otherwise stall the main thread on every
  // device connect (see P1 / Finding 1).
  | { type: 'splashImage'; keyIndex: number; bytes: Uint8Array; spec: DeviceImageSpec }
  | { type: 'setBrightness'; level: number }
  | { type: 'clearKey'; keyIndex: number }
  | { type: 'setImageOverride'; mode: ImageModeOverride }
  | { type: 'close' };

export type WorkerToMain =
  | { type: 'opened'; ok: true; deviceSerial?: string; deviceFirmware?: string }
  | { type: 'opened'; ok: false; error: string }
  | { type: 'key'; keyIndex: number; state: KeyState }
  | { type: 'comm'; entry: WorkerComm }
  | { type: 'log'; level: LogLevel; component: string; message: string }
  | { type: 'error'; message: string }
  // One image finished writing to the device — drives the WebUI imagesSent stat.
  | { type: 'imageSent'; keyIndex: number }
  | { type: 'disconnect' }
  | { type: 'closed' };
