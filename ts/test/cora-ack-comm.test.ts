// ACK frame bytes + comm accounting of the image path in cora/child-server.ts. No sockets:
// the server gets a fake client, so this binds no port.
import assert from 'tjs:assert';
import { ElgatoChildServer } from '../src/cora/child-server.js';
import type * as net from '../src/platform/tcp.js';
import {
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  ELGATO_MK2_PID,
  type CommEntry,
} from '../src/shared/types.js';
import type { CommCountKind } from '../src/shared/comm-format.js';
import {
  ELGATO_PKT_SIZE_RX,
  FEATURE_GET_CAPABILITIES,
  IMAGE_CHUNK_KEY_OFFSET,
  PAYLOAD_TYPE_FEATURE,
} from '../src/cora/protocol.js';
import { modelToChildGeometry } from '../src/devices/registry.js';
import { MINI_MODEL } from '../src/devices/elgato/mini.js';
import {
  CORA_FLAG_ACKNAK,
  CORA_FLAG_VERBATIM,
  CORA_FLAG_REQACK,
  encodeCoraFrame,
} from '../src/cora/frame.js';
import { setLogLevel } from '../src/shared/logger.js';
import { test, summary } from './helpers/harness.js';

const DEVICE_CONFIG = {
  dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
  childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
  serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
  childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
  productId: ELGATO_MK2_PID,
  macAddress: [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
};

class Probe extends ElgatoChildServer {
  readonly written: Buffer[] = [];
  readonly comms: Pick<CommEntry, 'direction' | 'human'>[] = [];
  readonly counts: CommCountKind[] = [];
  /** Frames already on the wire when each comm entry was recorded. */
  readonly writtenAtComm: number[] = [];

  constructor() {
    super(modelToChildGeometry(MINI_MODEL), 0, DEVICE_CONFIG, false);
    this.client = {
      write: (b: Buffer): boolean => {
        this.written.push(b);
        return true;
      },
    } as unknown as net.Socket;
    this.on('comm', (e: CommEntry) => {
      this.comms.push(e);
      this.writtenAtComm.push(this.written.length);
    });
    this.on('commCount', (k: CommCountKind) => this.counts.push(k));
  }

  feed(flags: number, hidOp: number, messageId: number, payload: Buffer): void {
    this.handleCoraPacket(flags, hidOp, messageId, payload);
  }

  ack(messageId: number, hidOp: number): Buffer {
    return this.writeAckNak(messageId, hidOp);
  }
}

function imageChunk(isLast: boolean): Buffer {
  const pkt = Buffer.alloc(ELGATO_PKT_SIZE_RX);
  pkt[0] = 0x02; // PAYLOAD_TYPE_OUTPUT_REPORT
  pkt[1] = 0x07; // IMG_CMD_WRITE
  pkt[IMAGE_CHUNK_KEY_OFFSET] = 0;
  pkt[3] = isLast ? 1 : 0;
  pkt.writeUInt16LE(4, 4);
  Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]).copy(pkt, 8);
  return pkt;
}

const LAST = CORA_FLAG_VERBATIM | CORA_FLAG_REQACK;
const MID = CORA_FLAG_VERBATIM;

setLogLevel('info');
console.log('\nchild-server ACK bytes and comm accounting');

test('prebuilt ACK is byte-identical to a freshly encoded frame', () => {
  const s = new Probe();
  const seen: Buffer[] = [];
  for (const [id, hidOp] of [
    [1, 0],
    [4242, 0],
    [0xdeadbeef, 3],
    [7, 0xff],
  ] as const) {
    const frame = s.ack(id, hidOp);
    const expected = encodeCoraFrame(
      Buffer.alloc(4),
      CORA_FLAG_VERBATIM | CORA_FLAG_ACKNAK,
      hidOp,
      id,
    );
    assert.equal(frame.toString('hex'), expected.toString('hex'));
    seen.push(frame);
  }
  // Each ACK is its own buffer: the socket may still hold an earlier one.
  assert.equal(seen[0]!.readUInt32LE(8), 1);
  assert.equal(seen[1]!.readUInt32LE(8), 4242);
  assert.equal(s.written.length, 4);
});

test('image ACK goes out before the rx comm entry; only the last chunk is ACKed', () => {
  const s = new Probe();
  s.countBulkComm = false;
  s.feed(MID, 0, 10, imageChunk(false));
  assert.equal(s.written.length, 0, 'non-last chunk has no REQACK, so no ACK');
  s.feed(LAST, 0, 11, imageChunk(true));
  assert.equal(s.written.length, 1);
  assert.equal(
    s.written[0]!.toString('hex'),
    encodeCoraFrame(Buffer.alloc(4), CORA_FLAG_VERBATIM | CORA_FLAG_ACKNAK, 0, 11).toString('hex'),
  );
  assert.equal(s.comms.length, 3, 'rx, rx, tx');
  assert.equal(s.comms[1]!.direction, 'rx');
  assert.equal(s.comms[2]!.direction, 'tx');
  assert.equal(s.comms[2]!.human, 'CORA AckNak for msgId=11 hidOp=0');
  assert.equal(s.writtenAtComm[1], 1, 'rx entry of the ACKed chunk is recorded after the ACK');
  assert.equal(s.counts.length, 0);
});

test('counting mode: image rx and ACK tx are counted, not stored', () => {
  const s = new Probe();
  s.countBulkComm = true;
  s.feed(MID, 0, 10, imageChunk(false));
  s.feed(LAST, 0, 11, imageChunk(true));
  assert.equal(s.written.length, 1, 'ACK bytes unchanged');
  assert.equal(s.comms.length, 0);
  assert.deepEqual(s.counts, ['image-chunk-rx', 'image-chunk-rx', 'ack-tx']);
});

test('counting mode keeps handshake traffic as stored entries', () => {
  const s = new Probe();
  s.countBulkComm = true;
  // Feature "get capabilities" request: the reply is a stored tx entry.
  const req = Buffer.alloc(8);
  req[0] = PAYLOAD_TYPE_FEATURE;
  req[1] = FEATURE_GET_CAPABILITIES;
  s.feed(LAST, 0, 5, req);
  assert.ok(
    s.comms.some((c) => c.direction === 'rx'),
    'rx handshake entry stored',
  );
  assert.equal(s.counts.length, 0);
});

test('simple-only builds default to counting, advanced builds to full entries', () => {
  assert.equal(new Probe().countBulkComm, __SIMPLE_ONLY__);
});

summary();
