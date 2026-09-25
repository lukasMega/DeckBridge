// Regression coverage for the ACK-path trace gating in cora-server-base.ts /
// elgato-child-server.ts: description/log work must be skipped when nothing
// would consume it, and restored once a listener/level does.
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
import { modelToChildGeometry } from '../src/capabilities.js';
import { MINI_MODEL } from '../src/devices/elgato/mini.js';
import { CORA_FLAG_VERBATIM, CORA_FLAG_REQACK } from '../src/cora-frame.js';
import { setLogLevel } from '../src/logger.js';
import { connect, sendFrame } from './helpers/cora-framer.js';
import { testAsync as runTest, summaryExit } from './helpers/harness.js';

const PORT = 25566;
const CHILD_GEOMETRY = modelToChildGeometry(MINI_MODEL);
const DEVICE_CONFIG = {
  dockFirmwareVersion: DEFAULT_DOCK_FIRMWARE_VERSION,
  childFirmwareVersion: DEFAULT_CHILD_FIRMWARE_VERSION,
  serialNumber: DEFAULT_DOCK_SERIAL_NUMBER,
  childSerialNumber: DEFAULT_CHILD_SERIAL_NUMBER,
  productId: ELGATO_MK2_PID,
  macAddress: [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
};

/** A valid gen2 image chunk (single, isLast) for keyIndex 0 — small enough that
 *  routing produces just an ACK, matching makeChunkPkt in elgato-child-image-bounds.test.ts. */
function makeImageChunkPkt(): Buffer {
  const pkt = Buffer.alloc(ELGATO_PKT_SIZE_RX);
  pkt[0] = 0x02; // PAYLOAD_TYPE_OUTPUT_REPORT
  pkt[1] = 0x07; // IMG_CMD_WRITE
  pkt[IMAGE_CHUNK_KEY_OFFSET] = 0;
  pkt[3] = 1; // isLast
  pkt.writeUInt16LE(4, 4);
  pkt.writeUInt16LE(0, 6);
  Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]).copy(pkt, 8);
  return pkt;
}

console.log('\ncora comm/trace gating (Hot-path quick wins)');

await runTest('no comm listener: AckNak still round-trips with no crash', async () => {
  const server = new ElgatoChildServer(CHILD_GEOMETRY, PORT, DEVICE_CONFIG, false);
  server.keepaliveIntervalMs = 100;
  await server.start();
  setLogLevel('info');

  try {
    const f = await connect(PORT);
    await f.recv(); // initial keepalive

    // No 'comm' listener attached — describeChildPayload/emitComm must be skipped
    // without breaking the ACK reply itself.
    await sendFrame(f, makeImageChunkPkt(), CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0, 4242);
    const ack = await f.recv();
    assert.equal(ack.messageId, 4242);

    f.close();
  } finally {
    await server.stop();
  }
});

await runTest('noisy sends (keepalive) log at debug only when debug is enabled', async () => {
  const server = new ElgatoChildServer(CHILD_GEOMETRY, PORT, DEVICE_CONFIG, false);
  server.keepaliveIntervalMs = 100;
  await server.start();

  const logs: { level: string; message: string }[] = [];
  server.on('serverLog', (entry: { level: string; message: string }) => logs.push(entry));

  try {
    setLogLevel('info');
    const f1 = await connect(PORT);
    await f1.recv(); // initial keepalive send triggers sendFrame(..., noisy=true)
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      logs.some((l) => l.message.includes('keepalive')),
      false,
      'keepalive must not emit a serverLog entry at info level',
    );
    f1.close();
    await new Promise((r) => setTimeout(r, 20));

    logs.length = 0;
    setLogLevel('debug');
    const f2 = await connect(PORT);
    await f2.recv();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      logs.some((l) => l.level === 'debug' && l.message.includes('keepalive')),
      true,
      'keepalive must emit a debug serverLog entry once debug is enabled',
    );
    f2.close();
  } finally {
    setLogLevel('info');
    await server.stop();
  }
});

summaryExit();
