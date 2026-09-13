import { getReportDescriptor } from '../ffi/hidapi.js';
import type { HidapiSymbols } from '../ffi/hidapi.js';
import { debug, warn } from '../logger.js';

/** Reads the device's own report descriptor to settle one question the wire cannot
 *  answer: how big a packet does this board want? Writing the wrong size is **silent** —
 *  the Fifine D6 rev. 2 firmware discards short writes while `hid_write` still reports
 *  success, so the panel just stays black (opendeck-ampgd6 PR #7). This walker is
 *  therefore refusal-biased: `null` for anything it cannot read with certainty, and the
 *  caller keeps the model's own `packetSize`. */

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
 *  otherwise `null` and the caller keeps its own `packetSize`. The whitelist is what
 *  keeps this honest: Windows hidapi *reconstructs* the descriptor from preparsed data
 *  rather than reading it verbatim as Linux hidraw does, so the probe is confined to
 *  sizes the model already declared valid — it can correct a guess, never invent one. */
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
