// Binary image frame from the server: [type, key, format, 0] + image bytes. Mirrors
// web/server/virtual-deck/frame-codec.ts (G1 forbids importing it; a test checks both).
export interface DeckFrame {
  key: number;
  format: 'jpeg' | 'bmp';
  bytes: Uint8Array<ArrayBuffer>;
}

const HEADER_BYTES = 4;
const TYPE_KEY_IMAGE = 0x01;

export function decodeDeckFrame(buf: ArrayBuffer): DeckFrame | null {
  if (buf.byteLength < HEADER_BYTES) return null;
  const view = new Uint8Array(buf);
  if (view[0] !== TYPE_KEY_IMAGE) return null;
  const fmt = view[2];
  if (fmt !== 0 && fmt !== 1) return null;
  return { key: view[1]!, format: fmt === 0 ? 'jpeg' : 'bmp', bytes: view.subarray(HEADER_BYTES) };
}
