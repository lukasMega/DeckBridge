// Layouts the browser deck can advertise. Plain data like the registry: no FFI, no I/O.
import type { DeviceModel } from '../driver.js';
import { MK2_MODEL } from '../elgato/mk2.js';

export type BrowserDeckProfile = 'mk2';

/** A separate object from MK2_MODEL so device tuning for a real MK.2 never applies here
 *  (`findModelById` returns null for this id) and the WebUI card says what it is. */
export const BROWSER_DECK_MK2_MODEL: DeviceModel = {
  ...MK2_MODEL,
  id: 'browser-deck-mk2',
  name: 'Browser deck (MK.2 layout)',
  usbVendorId: 0,
  usbProductIds: [],
  splash: undefined,
  cora: { productId: 0x0080, advertiseAs: 'mk2', usePhysicalIdentity: false },
};

export const BROWSER_DECK_PROFILES: Readonly<
  Record<BrowserDeckProfile, { model: DeviceModel; rotate: 0 | 180 }>
> = {
  // CORA MK.2 images arrive 180°-rotated by the desktop app; the page undoes it in CSS.
  mk2: { model: BROWSER_DECK_MK2_MODEL, rotate: 180 },
};

export const DEFAULT_BROWSER_DECK_PROFILE: BrowserDeckProfile = 'mk2';

export function isBrowserDeckProfile(v: unknown): v is BrowserDeckProfile {
  return typeof v === 'string' && Object.hasOwn(BROWSER_DECK_PROFILES, v);
}
