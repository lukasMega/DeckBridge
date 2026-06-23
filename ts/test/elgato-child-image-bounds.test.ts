import assert from 'tjs:assert';
import { ElgatoChildServer } from '../src/elgato.js';
import {
  ELGATO_PKT_SIZE_RX,
  IMAGE_CHUNK_KEY_OFFSET,
  DEFAULT_DOCK_FIRMWARE_VERSION,
  DEFAULT_CHILD_FIRMWARE_VERSION,
  DEFAULT_DOCK_SERIAL_NUMBER,
  DEFAULT_CHILD_SERIAL_NUMBER,
  ELGATO_MK2_PID,
} from '../src/types.js';
import { MINI_CHILD_GEOMETRY } from '../src/capabilities.js';
import { CORA_FLAG_VERBATIM, CORA_FLAG_REQACK } from '../src/cora-frame.js';
import { connect, sendFrame } from './helpers/cora-framer.js';

const CHILD_BOUNDS_PORT = 25555;

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

/** Build a gen2 image-chunk packet (PAYLOAD_TYPE_OUTPUT_REPORT/IMG_CMD_WRITE)
 *  matching the layout in assembler.test.ts's makeChunkPkt. */
function makeImageChunkPkt(
  keyIndex: number,
  partIndex: number,
  isLast: boolean,
  data: Buffer,
): Buffer {
  const pkt = Buffer.alloc(ELGATO_PKT_SIZE_RX);
  pkt[0] = 0x02; // PAYLOAD_TYPE_OUTPUT_REPORT
  pkt[1] = 0x07; // IMG_CMD_WRITE
  pkt[IMAGE_CHUNK_KEY_OFFSET] = keyIndex;
  pkt[3] = isLast ? 1 : 0;
  pkt.writeUInt16LE(data.length, 4);
  pkt.writeUInt16LE(partIndex, 6);
  data.copy(pkt, 8);
  return pkt;
}

console.log('\nelgato-child-server: image-chunk keyIndex bounds (L4)');

await runTest(
  'OOB image-chunk key is dropped, warned once, no further warn on repeat',
  async () => {
    const deviceConfig = {
      dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
      childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
      serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
      childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
      productId: ELGATO_MK2_PID,
      macAddress: [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
    };

    const childServer = new ElgatoChildServer(CHILD_BOUNDS_PORT, deviceConfig, false);
    childServer.keepaliveIntervalMs = 100;
    // MINI_CHILD_GEOMETRY has keyCount=6, so key 200 is far out of range.
    childServer.setChildGeometry(MINI_CHILD_GEOMETRY);
    await childServer.start();

    const warnings: string[] = [];
    childServer.on('serverLog', (entry: { level: string; message: string }) => {
      if (entry.level === 'warn' && entry.message.includes('out-of-range key')) {
        warnings.push(entry.message);
      }
    });

    let imageEvents = 0;
    childServer.on('image', () => {
      imageEvents++;
    });

    try {
      const f = await connect(CHILD_BOUNDS_PORT);
      // drain the initial keepalive
      await f.recv();

      const OOB_KEY = 200;
      const data = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

      // First OOB chunk for key 200.
      await sendFrame(
        f,
        makeImageChunkPkt(OOB_KEY, 0, true, data),
        CORA_FLAG_VERBATIM | CORA_FLAG_REQACK,
        0,
        9001,
      );
      // ACK/NAK is still sent even for a dropped chunk.
      const ack1 = await f.recv();
      assert.equal(ack1.messageId, 9001);

      // Second OOB chunk for the same key — should not emit another warn.
      await sendFrame(
        f,
        makeImageChunkPkt(OOB_KEY, 0, true, data),
        CORA_FLAG_VERBATIM | CORA_FLAG_REQACK,
        0,
        9002,
      );
      const ack2 = await f.recv();
      assert.equal(ack2.messageId, 9002);

      // Give any (incorrectly) emitted 'image' event a chance to fire.
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(imageEvents, 0, 'no image event should be emitted for an out-of-range key');
      assert.equal(warnings.length, 1, 'exactly one warn for the repeated OOB key');
      assert.ok(warnings[0]!.includes('200'));
      assert.ok(warnings[0]!.includes('keyCount=6'));

      f.close();
    } finally {
      await childServer.stop();
    }
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
