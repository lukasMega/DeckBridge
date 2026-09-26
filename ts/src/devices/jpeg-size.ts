type Size = { width: number; height: number };

/** Frame size from a JPEG's SOF header, or null when it can't be found.
 *  The AKP05 strip shares wire id 1 between the full strip and slot 1; only the
 *  encoded width tells the two uploads apart. */
export function jpegSize(bytes: Uint8Array): Size | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    // Fill bytes: a marker may be preceded by any number of 0xFF.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (isSofMarker(marker)) return sofSize(bytes, offset);
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

// C4 (DHT), C8 (JPG extension) and CC (DAC) share the SOF range but carry no frame size.
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function sofSize(bytes: Uint8Array, offset: number): Size | null {
  if (offset + 9 > bytes.length) return null;
  return {
    height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
    width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
  };
}
