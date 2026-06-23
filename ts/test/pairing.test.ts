import assert from 'tjs:assert';
import { ElgatoServer, ElgatoChildServer } from '../src/elgato.js';
import { ELGATO_VID, ELGATO_PKT_SIZE_RX, ELGATO_CHILD_PORT } from '../src/types.js';
import { CORA_FLAG_VERBATIM, CORA_FLAG_REQACK, CORA_FLAG_ACKNAK } from '../src/cora-frame.js';
import { connect, waitForValue, closeAndWait, sendPkt, sendFrame } from './helpers/cora-framer.js';

const PRIMARY_PAIRING_PORT = 25543;
const CHILD_PAIRING_PORT = 25544;

// ── Setup / teardown ─────────────────────────────────────────────────────────

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

console.log(
  '\npairing: full pairing flow (specific to pairing as Elgato Stream Dec MK.2 to Elgato desktop app',
);

/* oxlint-disable no-console no-control-regex */
await runTest('primary double-probe + child double-probe + operational', async () => {
  const pairingServer = new ElgatoServer(PRIMARY_PAIRING_PORT, true);
  pairingServer.keepaliveIntervalMs = 100;
  await pairingServer.start();
  const pairingChildServer = new ElgatoChildServer(
    CHILD_PAIRING_PORT,
    pairingServer.deviceConfig,
    false,
  );
  pairingChildServer.keepaliveIntervalMs = 100;
  await pairingChildServer.start();

  try {
    // Phase 1 — Primary short probe
    const f1 = await connect(PRIMARY_PAIRING_PORT);

    // 1. Receive keepalive
    const k1 = await f1.recv();
    assert.equal(k1.payload[0], 0x01);
    assert.equal(k1.payload[1], 0x0a);

    // 2. Send [03 83] (dock fw)
    await sendPkt(f1, 0x03, 0x83);
    const r1 = await f1.recv();
    assert.equal(r1.payload[0], 0x03);
    assert.equal(r1.payload[1], 0x83);
    assert.equal(
      // eslint-disable-next-line sonarjs/super-linear-regex
      Buffer.from(r1.payload.subarray(8, 16)).toString('ascii').replace(/\0+$/, ''),
      '1.01.016',
    );

    // 3. Send [03 8f] (quick probe)
    await sendPkt(f1, 0x03, 0x8f);
    const r2 = await f1.recv();
    assert.equal(r2.payload[1], 0x8f);
    assert.equal(
      // eslint-disable-next-line sonarjs/super-linear-regex
      Buffer.from(r2.payload.subarray(8, 16)).toString('ascii').replace(/\0+$/, ''),
      '1.01.016',
    );

    // 4. Send [03 84] (dock serial)
    await sendPkt(f1, 0x03, 0x84);
    const r3 = await f1.recv();
    assert.equal(r3.payload[1], 0x84);
    const serialLen = r3.payload[3]!;
    assert.equal(
      Buffer.from(r3.payload.subarray(4, 4 + serialLen)).toString('ascii'),
      pairingServer.deviceConfig.serialNumber,
    );

    // 5. Destroy f1
    await closeAndWait(pairingServer, f1);

    // Phase 2 — Primary full probe
    const f2 = await connect(PRIMARY_PAIRING_PORT);

    // 6. Receive keepalive
    await f2.recv();

    // 7. Send [03 83]
    await sendPkt(f2, 0x03, 0x83);
    await f2.recv();

    // 8. Send [03 87] (child fw)
    await sendPkt(f2, 0x03, 0x87);
    const r4 = await f2.recv();
    assert.equal(r4.payload[1], 0x87);
    assert.equal(
      // eslint-disable-next-line sonarjs/super-linear-regex
      Buffer.from(r4.payload.subarray(8, 16)).toString('ascii').replace(/\0+$/, ''),
      '1.01.000',
    );

    // 9. Send [03 1c] (capabilities)
    await sendPkt(f2, 0x03, 0x1c);
    const r5 = await f2.recv();
    assert.equal(r5.payload[0], 0x01);
    assert.equal(r5.payload[1], 0x0b);
    assert.equal(r5.payload.readUInt16LE(26), ELGATO_VID);
    assert.equal(r5.payload.readUInt16LE(28), pairingServer.deviceConfig.productId);
    assert.equal(r5.payload.readUInt16LE(126), ELGATO_CHILD_PORT);
    assert.ok(
      Buffer.from(r5.payload.subarray(62, 94)).toString('ascii').includes('Stream Deck MK.2'),
    );

    // 10. Send [03 84] (dock serial)
    await sendPkt(f2, 0x03, 0x84);
    await f2.recv();

    // 11. Send keepalive ACK [03 1a ...] - verify server alive with 0x83
    await sendPkt(f2, 0x03, 0x1a);
    await sendPkt(f2, 0x03, 0x83);
    const r6 = await f2.recv();
    assert.equal(r6.payload[1], 0x83);

    // Phase 3 — Child short probe
    const cf1 = await connect(CHILD_PAIRING_PORT);

    // 12. Receive child keepalive
    await cf1.recv();

    // 13. Send child GET_REPORT 0x05 bare
    const p05 = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    p05[0] = 0x05;
    await sendFrame(cf1, p05, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0x02, 100);
    const cr1 = await cf1.recv();
    assert.equal(cr1.payload[0], 0x05);
    assert.equal(
      // eslint-disable-next-line sonarjs/super-linear-regex
      Buffer.from(cr1.payload.subarray(6, 14)).toString('ascii').replace(/\0+$/, ''),
      '1.01.000',
    );

    // 14. Send child GET_REPORT 0x06 with write-data
    const p06wd = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    p06wd[0] = 0x06;
    p06wd[1] = 12;
    p06wd.write('challenge123', 2);
    await sendFrame(cf1, p06wd, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0x02, 101);
    const cr2 = await cf1.recv();
    assert.equal(cr2.payload[0], 0x06);
    assert.equal(cr2.payload[1], 12);
    assert.equal(
      Buffer.from(cr2.payload.subarray(2, 14)).toString('ascii'),
      pairingServer.deviceConfig.childSerialNumber.substring(0, 12),
    );

    // 15. Destroy child cf1
    await closeAndWait(pairingChildServer, cf1);

    // Phase 4 — Child full probe
    const cf2 = await connect(CHILD_PAIRING_PORT);

    // 16. Receive child keepalive
    await cf2.recv();

    // 17. Send child GET_REPORT 0x05 with context
    const p05ctx = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    p05ctx[0] = 0x05;
    p05ctx.write('somecontext', 1);
    await sendFrame(cf2, p05ctx, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0x02, 200);
    const cr3 = await cf2.recv();
    assert.equal(cr3.payload[0], 0x05);

    // 18. Send child GET_REPORT 0x0b
    const p0b = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    p0b[0] = 0x0b;
    await sendFrame(cf2, p0b, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0x02, 201);
    const cr4 = await cf2.recv();
    assert.equal(cr4.payload[0], 0x0b);
    assert.equal(cr4.payload.readUInt16LE(2), ELGATO_VID);
    assert.equal(cr4.payload.readUInt16LE(4), pairingServer.deviceConfig.productId);

    // 19. Send child GET_REPORT 0x06 bare
    const p06 = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    p06[0] = 0x06;
    await sendFrame(cf2, p06, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0x02, 202);
    const cr5 = await cf2.recv();
    assert.equal(cr5.payload[0], 0x06);

    // 20. Send image chunk
    const imgMsgId = 1974;
    const fullImgPayload = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    fullImgPayload[0] = 0x02; // PAYLOAD_TYPE_OUTPUT_REPORT
    fullImgPayload[1] = 0x07; // IMG_CMD_WRITE
    fullImgPayload[2] = 0x00; // key index 0
    fullImgPayload[3] = 0x01; // isLast
    fullImgPayload.writeUInt16LE(770, 4); // bodyLen

    const imgEventPromise = waitForValue<{ keyIndex: number; data: Buffer; format: string }>(
      pairingChildServer,
      'image',
    );
    await sendFrame(cf2, fullImgPayload, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0, imgMsgId);

    const ack1 = await cf2.recv();
    assert.ok(ack1.flags & CORA_FLAG_ACKNAK);
    assert.equal(ack1.messageId, imgMsgId);

    const imgEvent = await imgEventPromise;
    assert.equal(imgEvent.keyIndex, 0);
    assert.equal(imgEvent.data.length, 770);

    // 21. Send brightness [03 05 00 ...]
    const brMsgId = 1975;
    const brPayload = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    brPayload[0] = 0x03; // PAYLOAD_TYPE_FEATURE
    brPayload[1] = 0x05; // sub-type for brightness
    brPayload[2] = 0x00; // value

    const brEventPromise = waitForValue<number>(pairingChildServer, 'brightness');
    await sendFrame(cf2, brPayload, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0, brMsgId);

    const ack2 = await cf2.recv();
    assert.ok(ack2.flags & CORA_FLAG_ACKNAK);
    assert.equal(ack2.messageId, brMsgId);
    assert.equal(await brEventPromise, 0);

    // 22. Send brightness [03 08 0a ...]
    const brMsgId2 = 1978;
    const brPayload2 = Buffer.alloc(ELGATO_PKT_SIZE_RX);
    brPayload2[0] = 0x03;
    brPayload2[1] = 0x08;
    brPayload2[2] = 0x0a;

    const brEventPromise2 = waitForValue<number>(pairingChildServer, 'brightness');
    await sendFrame(cf2, brPayload2, CORA_FLAG_VERBATIM | CORA_FLAG_REQACK, 0, brMsgId2);

    await cf2.recv();
    assert.equal(await brEventPromise2, 10);

    // 23. Call childServer.sendKeyEvent(12, 'down')
    pairingChildServer.sendKeyEvent(12, 'down');
    const bstate1 = await cf2.recv();
    assert.equal(bstate1.payload[0], 0x01);
    assert.equal(bstate1.payload[1], 0x00);
    assert.equal(bstate1.payload[2], 15);
    assert.equal(bstate1.payload[4 + 12], 1);

    // 24. Call childServer.sendKeyEvent(12, 'up')
    pairingChildServer.sendKeyEvent(12, 'up');
    const bstate2 = await cf2.recv();
    assert.equal(bstate2.payload[4 + 12], 0);

    // 25. Destroy f2
    await closeAndWait(pairingServer, f2);

    // 26. Destroy child cf2
    await closeAndWait(pairingChildServer, cf2);
  } finally {
    await pairingServer.stop();
    await pairingChildServer.stop();
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
tjs.exit(failed > 0 ? 1 : 0);
