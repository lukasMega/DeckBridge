// Binary image frame: [type, key, format, 0] + image bytes. The page decodes it in
// web/client/deck/frame-decode.ts (G1: no shared runtime code, a test checks both).

export const DECK_FRAME_KEY_IMAGE = 0x01;
export const DECK_FRAME_HEADER_BYTES = 4;
export const DECK_FORMAT_JPEG = 0;
export const DECK_FORMAT_BMP = 1;

export function encodeDeckFrame(
  key: number,
  data: Uint8Array,
  format: 'jpeg' | 'bmp',
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(DECK_FRAME_HEADER_BYTES + data.length);
  out[0] = DECK_FRAME_KEY_IMAGE;
  out[1] = key;
  out[2] = format === 'jpeg' ? DECK_FORMAT_JPEG : DECK_FORMAT_BMP;
  out.set(data, DECK_FRAME_HEADER_BYTES);
  return out;
}
