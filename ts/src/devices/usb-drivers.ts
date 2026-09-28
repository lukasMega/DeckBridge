/** USB-worker driver table: one factory per wire protocol. Worker side only — it
 *  imports the FFI drivers; the matching tunable wire keys live in driver.ts
 *  (TUNABLE_WIRE_KEYS) because the main thread validates overrides too. */
import type { DeviceDriver, DeviceModel, DeviceProtocol } from './driver.js';
import { ElgatoHidDriver } from './elgato/driver.js';
import { MiraboxDriver } from './mirabox/driver.js';
import { Akp05Driver } from './ajazz/akp05-driver.js';

/** What the USB worker drives: the DeviceDriver contract plus native writes and
 *  the facts it reports back in 'opened'. */
export interface UsbDriver extends DeviceDriver {
  sendImage(keyIndex: number, bytes: Uint8Array): void;
  readonly hidPath: string | undefined;
  readonly serial?: string;
  readonly firmware?: string;
  /** Uploads inside `run` share one commit. Only on drivers that can batch; the
   *  worker calls it only when imageBatchingEnabled(model). */
  batch?(run: () => Promise<void>): Promise<void>;
}

export const USB_DRIVERS: Record<DeviceProtocol, (model: DeviceModel) => UsbDriver> = {
  'elgato-gen1': (model) => new ElgatoHidDriver(model),
  'elgato-gen2': (model) => new ElgatoHidDriver(model),
  'mirabox-cora': (model) => new MiraboxDriver(model),
  'mirabox-cora-v1': (model) => new MiraboxDriver(model),
  'ajazz-akp05': (model) => new Akp05Driver(model),
};
