import { AJAZZ_AKP05E_MODEL } from './akp05e.js';
import type { DeviceModel } from '../driver.js';

/** Retail AJAZZ AKP05. VID/PID and protocol-3 image format come from opendeck-akp05. */
export const AJAZZ_AKP05_MODEL: DeviceModel = {
  ...AJAZZ_AKP05E_MODEL,
  id: 'ajazz-akp05',
  name: 'AJAZZ AKP05',
  usbProductIds: [0x3006],
};
