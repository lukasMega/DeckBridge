import type { DeviceModel } from './devices/driver.js';

// Pure model.keyMap lookups, split out of translator.ts so main-thread code
// (splash-sender.ts, device-session.ts) and worker code (image-render.ts) can use
// them without pulling in translator.ts's ffi/image-proc.js dependency.

/** mk2 key index → device wire image id, driven by model.keyMap.
 *  Precedence: explicit array > offset > identity. */
export function mk2IndexToDeviceImgId(mk2Index: number, model: DeviceModel): number {
  const { coraToWireImage, imageOffset } = model.keyMap;
  if (coraToWireImage) return coraToWireImage[mk2Index] ?? -1; // OOB / unused → -1
  if (imageOffset != null) return mk2Index + imageOffset;
  return mk2Index;
}

/** Device input wire code → mk2 index, driven by model.keyMap.
 *  Precedence: explicit array > offset > identity. Returns -1 for entries the
 *  array marks as unused (e.g. 293S 6th-column keys). */
export function deviceInputToMk2Index(code: number, model: DeviceModel): number {
  const { wireInputToCora, inputOffset } = model.keyMap;
  if (wireInputToCora) return wireInputToCora[code] ?? -1;
  if (inputOffset != null) return code - inputOffset;
  return code;
}

/** Device input code → wire id of the extra key it belongs to (keyMap.extraKeyInputs),
 *  or -1 when the code is no pressable extra key. */
export function deviceInputToExtraKey(code: number, model: DeviceModel): number {
  const { extraKeys, extraKeyInputs } = model.keyMap;
  const i = extraKeyInputs?.indexOf(code) ?? -1;
  return i < 0 ? -1 : (extraKeys?.[i] ?? -1);
}
