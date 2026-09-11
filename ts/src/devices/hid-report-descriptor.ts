import { getReportDescriptor } from '../ffi/hidapi.js';
import type { HidapiSymbols } from '../ffi/hidapi.js';
import { debug, warn } from '../logger.js';

/** Every USB HID output report this interface can carry is described, in bytes, by the
 *  device's own report descriptor. We use that to settle ONE question the wire cannot
 *  answer for itself: how big a packet does this board actually want?
 *
 *  Why it matters: writing the wrong size is **silent**. On the Fifine D6 rev. 2 the
 *  firmware discards every short write while `hid_write` still reports success — the
 *  device enumerates, registers, and reports button presses normally, and the panel just
 *  stays black (opendeck-ampgd6 PR #7). There is no error to catch and no ACK to miss,
 *  so a per-model constant that is wrong stays wrong forever.
 *
 *  This walker is deliberately **refusal-biased**: it returns `null` for anything it
 *  cannot read with certainty, and the caller then keeps the model's own `packetSize`.
 *  A descriptor we only half-understand must never beat a hardware-verified constant. */

// Item prefixes with the two bSize bits masked off (bTag + bType).
const TAG_REPORT_SIZE = 0x74; // Global: bits per field
const TAG_REPORT_COUNT = 0x94; // Global: fields per report
const TAG_OUTPUT = 0x90; // Main: Output
/** Items whose presence means we cannot read the descriptor with certainty: a Report ID
 *  changes the write framing our drivers assume, and Push/Pop imply a global-state stack
 *  this walker deliberately does not model. */
const REFUSED_TAGS = new Set([0x84, 0xa4, 0xb4]); // Report ID, Push, Pop

interface HidItem {
  tag: number;
  value: number;
  /** Index just past this item. */
  next: number;
}

/** Decode the short item at `i`. `null` for a long item (out of scope) or a descriptor
 *  that ends mid-item. Data is little-endian and unsigned — multiplication rather than
 *  `<<` so a 4-byte value can't sign-flip into a negative report size. */
function readItem(desc: Uint8Array, i: number): HidItem | null {
  const prefix = desc[i]!;
  if (prefix === 0xfe) return null;
  // bSize 3 encodes 4 data bytes; otherwise it IS the byte count.
  const sizeCode = prefix & 0x03;
  const dataLen = sizeCode === 3 ? 4 : sizeCode;
  const start = i + 1;
  if (start + dataLen > desc.length) return null;
  let value = 0;
  for (let b = 0; b < dataLen; b++) value += desc[start + b]! * 2 ** (8 * b);
  return { tag: prefix & 0xfc, value, next: start + dataLen };
}

/** Bytes in this interface's output report, or `null` if that cannot be established
 *  beyond doubt — see REFUSED_TAGS, plus: long items, truncated data, an Output item
 *  with no preceding size/count, more than one Output item (we'd be guessing which one
 *  our writes land in), and any bit count that isn't a whole number of bytes. */
export function parseOutputReportSize(desc: Uint8Array): number | null {
  let reportSizeBits = -1;
  let reportCount = -1;
  let outputItems = 0;
  let outputBits = 0;

  for (let i = 0; i < desc.length;) {
    const item = readItem(desc, i);
    if (item === null || REFUSED_TAGS.has(item.tag)) return null;
    i = item.next;

    if (item.tag === TAG_REPORT_SIZE) {
      reportSizeBits = item.value;
    } else if (item.tag === TAG_REPORT_COUNT) {
      reportCount = item.value;
    } else if (item.tag === TAG_OUTPUT) {
      if (reportSizeBits < 0 || reportCount < 0) return null;
      outputItems += 1;
      outputBits = reportSizeBits * reportCount;
    }
  }

  if (outputItems !== 1 || outputBits <= 0 || outputBits % 8 !== 0) return null;
  return outputBits / 8;
}

/** hidapi caps report descriptors at 4096 bytes (HID_API_MAX_REPORT_DESCRIPTOR_SIZE). */
const MAX_DESCRIPTOR_BYTES = 4096;

/** The device's real output-report size, but only when it is one of `candidates` —
 *  otherwise `null` and the caller keeps its own `packetSize`.
 *
 *  The whitelist is what keeps this honest across platforms. On Linux the descriptor
 *  comes verbatim from hidraw, but on Windows hidapi *reconstructs* it from the
 *  preparsed data, so an exotic device could in principle yield a plausible-looking
 *  number we have no business acting on. Constraining the answer to the sizes the model
 *  already declared valid means the probe can only ever pick between values that are
 *  known-good for that family — it can correct a wrong guess, never invent a new one. */
export function probeOutputReportSize(
  hid: HidapiSymbols,
  device: unknown,
  candidates: readonly number[],
): number | null {
  const desc = getReportDescriptor(hid, device, MAX_DESCRIPTOR_BYTES);
  if (!desc) {
    debug('hid', 'report descriptor unavailable (old hidapi?) — keeping model packetSize');
    return null;
  }
  const size = parseOutputReportSize(desc);
  if (size === null) {
    debug('hid', `report descriptor (${desc.length} B) not unambiguous — keeping model packetSize`);
    return null;
  }
  if (!candidates.includes(size)) {
    warn(
      'hid',
      `report descriptor says output report is ${size} B, which is not in the model's ` +
        `candidate list [${candidates.join(', ')}] — ignoring it and keeping model packetSize`,
    );
    return null;
  }
  return size;
}
