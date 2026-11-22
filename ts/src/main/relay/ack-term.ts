// Experimental relay ACK termination (DECKBRIDGE_RELAY_ACK_TERM=1; plan: relay-remaining §C).
// Elgato sends the next key image only after the ACK of the previous one, so the relay
// answers that ACK itself instead of waiting a relay<->DeckBridge round trip. The frame it
// forwards has REQACK cleared, so DeckBridge sends no ACK for it and none has to be swallowed.
// Both directions go out as whole frames: an injected ACK must never land inside one.
import {
  CORA_FLAG_ACKNAK,
  CORA_FLAG_REQACK,
  CORA_FLAG_VERBATIM,
  encodeCoraFrame,
} from '../../cora/frame.js';
import type { CoraFrameReader } from '../../cora/frame.js';
import {
  GEN1_IMG_CMD,
  IMG_CMD_LCD,
  IMG_CMD_WINDOW,
  IMG_CMD_WINDOW_PARTIAL,
  IMG_CMD_WRITE,
  PAYLOAD_TYPE_OUTPUT_REPORT,
} from '../../cora/protocol.js';

// The commands DeckBridge's child server ACKs (child-server.ts handleOutputReport).
const IMAGE_CMDS = new Set([
  IMG_CMD_WRITE,
  GEN1_IMG_CMD,
  IMG_CMD_LCD,
  IMG_CMD_WINDOW,
  IMG_CMD_WINDOW_PARTIAL,
]);

const EMPTY = Buffer.alloc(0);

/**
 * Client bytes in; whole frames for DeckBridge out, plus the ACK frames to answer locally.
 * `ack` false (upstream away or not caught up) keeps REQACK so DeckBridge ACKs after replay.
 */
export function splitClientFrames(
  reader: CoraFrameReader,
  chunk: Uint8Array,
  ack: boolean,
): { up: Buffer; acks: Buffer } {
  reader.append(Buffer.wrap(chunk));
  const up: Buffer[] = [];
  const acks: Buffer[] = [];
  for (const f of reader.drainFrames()) {
    let flags = f.flags;
    const isImage =
      (flags & CORA_FLAG_REQACK) !== 0 &&
      f.payload[0] === PAYLOAD_TYPE_OUTPUT_REPORT &&
      IMAGE_CMDS.has(f.payload[1]!);
    if (ack && isImage) {
      acks.push(
        encodeCoraFrame(
          Buffer.alloc(4),
          CORA_FLAG_VERBATIM | CORA_FLAG_ACKNAK,
          f.hidOp,
          f.messageId,
        ),
      );
      flags &= ~CORA_FLAG_REQACK;
    }
    up.push(encodeCoraFrame(f.payload, flags, f.hidOp, f.messageId));
  }
  return {
    up: up.length ? Buffer.concat(up) : EMPTY,
    acks: acks.length ? Buffer.concat(acks) : EMPTY,
  };
}

/** DeckBridge bytes in; the complete frames among them out (a partial one waits). */
export function wholeFrames(reader: CoraFrameReader, chunk: Uint8Array): Buffer {
  reader.append(Buffer.wrap(chunk));
  const out = reader
    .drainFrames()
    .map((f) => encodeCoraFrame(f.payload, f.flags, f.hidOp, f.messageId));
  return out.length ? Buffer.concat(out) : EMPTY;
}
