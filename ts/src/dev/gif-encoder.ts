// Minimal GIF89a encoder for the hardware probes: global palette, full-frame images,
// real LZW. Spec: https://www.w3.org/Graphics/GIF/spec-gif89a.txt

export type Rgb = readonly [number, number, number];

export interface GifFrame {
  /** One palette index per pixel, row-major, width*height long. */
  indices: Uint8Array;
  /** Frame delay in 1/100 s (the GIF unit). */
  delayCs: number;
}

export interface GifOptions {
  /** Add the NETSCAPE2.0 block: loop forever. Without it most players play once. */
  loop: boolean;
}

const MAX_CODE = 4096;

class ByteSink {
  private readonly bytes: number[] = [];
  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }
  u16(v: number): void {
    this.u8(v);
    this.u8(v >> 8);
  }
  ascii(s: string): void {
    for (const ch of s) this.u8(ch.charCodeAt(0));
  }
  all(data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) this.u8(data[i]!);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Variable-width LZW as GIF wants it: LSB-first codes, clear code first, code
 *  width bumped before the entry that needs it, table reset at 4096. */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let accBits = 0;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const table = new Map<number, number>();

  const emit = (code: number): void => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
  };

  emit(clear);
  if (indices.length === 0) {
    emit(eoi);
    if (accBits > 0) out.push(acc & 0xff);
    return Uint8Array.from(out);
  }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next === MAX_CODE) {
      emit(clear);
      table.clear();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (accBits > 0) out.push(acc & 0xff);
  return Uint8Array.from(out);
}

export function encodeGif(
  width: number,
  height: number,
  palette: readonly Rgb[],
  frames: readonly GifFrame[],
  opts: GifOptions,
): Uint8Array {
  if (palette.length < 1 || palette.length > 256) throw new Error('palette needs 1-256 colours');
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const s = new ByteSink();

  s.ascii('GIF89a');
  s.u16(width);
  s.u16(height);
  s.u8(0x80 | ((bits - 1) << 4) | (bits - 1)); // global table, colour resolution, table size
  s.u8(0); // background index
  s.u8(0); // pixel aspect
  for (let i = 0; i < 1 << bits; i++) s.all(palette[i] ?? [0, 0, 0]);

  if (opts.loop) {
    s.all([0x21, 0xff, 0x0b]);
    s.ascii('NETSCAPE2.0');
    s.all([0x03, 0x01, 0x00, 0x00, 0x00]); // loop count 0 = forever
  }

  const minCodeSize = Math.max(2, bits);
  for (const f of frames) {
    if (f.indices.length !== width * height) throw new Error('frame size mismatch');
    s.all([0x21, 0xf9, 0x04, 0x04]); // graphic control: disposal 1 (keep), no transparency
    s.u16(f.delayCs);
    s.all([0x00, 0x00]);
    s.u8(0x2c); // image descriptor, full frame, no local table
    s.u16(0);
    s.u16(0);
    s.u16(width);
    s.u16(height);
    s.u8(0);
    s.u8(minCodeSize);
    const data = lzwEncode(f.indices, minCodeSize);
    for (let off = 0; off < data.length; off += 255) {
      const block = data.subarray(off, off + 255);
      s.u8(block.length);
      s.all(block);
    }
    s.u8(0);
  }
  s.u8(0x3b);
  return s.done();
}
