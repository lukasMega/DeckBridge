import assert from 'tjs:assert';
import {
  featureRequest,
  parseCapsReply,
  parseSerialReply,
  probeIdentity,
} from '../src/main/relay/identity.js';
import { createServer } from '../src/platform/tcp.js';
import type { NodeLikeServer, NodeLikeSocket } from '../src/platform/tcp.js';
import { CoraFrameReader, encodeCoraFrame } from '../src/cora/frame.js';
import { buildCapabilitiesPacket, buildFeatureResponse } from '../src/cora/responses.js';
import {
  ELGATO_PKT_SIZE_RX,
  EVENT_SUBTYPE_KEEPALIVE,
  FEATURE_GET_CAPABILITIES,
  FEATURE_GET_DOCK_SERIAL,
  PAYLOAD_TYPE_FEATURE,
  PKT_EVENT,
} from '../src/cora/protocol.js';
import type { ChildGeometry } from '../src/devices/driver.js';
import type { DeviceConfig } from '../src/cora/types.js';
import { testAsync, summaryExit } from './helpers/harness.js';

// Values from network-dock-investigation/log_02_deckbridge-with-proxy.txt.
const CONFIG: DeviceConfig = {
  dockFirmwareVersion: '1.0.0',
  childFirmwareVersion: '1.0.0',
  serialNumber: 'A7FZA5190Iq5AA',
  childSerialNumber: 'CHILD123456789',
  productId: 0x00a5,
  macAddress: [1, 2, 3, 4, 5, 6],
};
const CHILD_PORT = 5344;
const GEOMETRY: ChildGeometry = {
  rows: 2,
  columns: 4,
  keyCount: 8,
  keyWidth: 120,
  keyHeight: 120,
  productName: 'Stream Deck +',
};

const HOST = '127.0.0.1';
let nextPort = 48410 + (tjs.pid % 100);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const serialPayload = (): Buffer =>
  buildFeatureResponse(FEATURE_GET_DOCK_SERIAL, CONFIG, ELGATO_PKT_SIZE_RX);
const capsPayload = (): Buffer => buildCapabilitiesPacket(CONFIG, CHILD_PORT, GEOMETRY);

function listen(srv: NodeLikeServer, p: number): Promise<void> {
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(p, HOST, resolve);
  });
}

/** Fake primary: `onConnect` runs per accepted client. */
async function fakePrimary(
  onConnect: (s: NodeLikeSocket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  for (let attempt = 0; ; attempt++) {
    const port = nextPort++;
    const srv = createServer(onConnect);
    try {
      await listen(srv, port);
      return { port, close: () => new Promise<void>((r) => srv.close(r)) };
    } catch (e) {
      if (attempt >= 20 || !String(e).includes('EADDRINUSE')) throw e;
    }
  }
}

function answeringServer(s: NodeLikeSocket): void {
  const keepalive = Buffer.alloc(ELGATO_PKT_SIZE_RX);
  keepalive[0] = PKT_EVENT;
  keepalive[1] = EVENT_SUBTYPE_KEEPALIVE;
  s.write(encodeCoraFrame(keepalive, 0, 0, 0));
  const reader = new CoraFrameReader();
  s.on('data', (chunk) => {
    reader.append(chunk);
    for (const f of reader.drainFrames()) {
      if (f.payload[0] !== PAYLOAD_TYPE_FEATURE) continue;
      if (f.payload[1] === FEATURE_GET_DOCK_SERIAL)
        s.write(encodeCoraFrame(serialPayload(), 0, 0, 0));
      if (f.payload[1] === FEATURE_GET_CAPABILITIES)
        s.write(encodeCoraFrame(capsPayload(), 0, 0, 0));
    }
  });
  s.on('error', () => {});
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected rejection');
}

await testAsync('featureRequest is [0x03, reportId, 0...] of 1024 bytes', () => {
  const r = featureRequest(0x84);
  assert.equal(r.length, 1024);
  assert.equal(r[0], 0x03);
  assert.equal(r[1], 0x84);
  assert.equal(r[2], 0);
});

await testAsync('parseSerialReply and parseCapsReply decode the builder payloads', () => {
  assert.equal(parseSerialReply(serialPayload()), 'A7FZA5190Iq5AA');
  assert.deepEqual(parseCapsReply(capsPayload()), { productId: 0x00a5, childPort: 5344 });
});

await testAsync('parsers return null for the wrong type or VID', () => {
  const serial = serialPayload();
  serial[0] = 0x01;
  assert.equal(parseSerialReply(serial), null);
  const other = serialPayload();
  other[1] = 0x83;
  assert.equal(parseSerialReply(other), null);
  assert.equal(parseSerialReply(capsPayload()), null);

  const caps = capsPayload();
  caps[0] = 0x03;
  assert.equal(parseCapsReply(caps), null);
  const badVid = capsPayload();
  badVid.writeUInt16LE(0x1234, 26);
  assert.equal(parseCapsReply(badVid), null);
  assert.equal(parseCapsReply(serialPayload()), null);
  assert.equal(parseCapsReply(Buffer.alloc(8)), null);
});

await testAsync('probeIdentity reads serial, pid and child port past a keepalive', async () => {
  const fake = await fakePrimary(answeringServer);
  try {
    const id = await probeIdentity(HOST, fake.port, 2000);
    assert.deepEqual(id, { serial: 'A7FZA5190Iq5AA', productId: 0x00a5, childPort: 5344 });
  } finally {
    await fake.close();
  }
});

await testAsync('probeIdentity: close right after accept gives "closed before reply"', async () => {
  const fake = await fakePrimary((s) => {
    s.on('error', () => {});
    s.destroy();
  });
  try {
    assert.equal(await rejection(probeIdentity(HOST, fake.port, 2000)), 'closed before reply');
  } finally {
    await fake.close();
  }
});

await testAsync('probeIdentity: silent target gives "timeout"', async () => {
  const held: NodeLikeSocket[] = [];
  const fake = await fakePrimary((s) => {
    s.on('error', () => {});
    held.push(s);
  });
  try {
    assert.equal(await rejection(probeIdentity(HOST, fake.port, 300)), 'timeout');
  } finally {
    for (const s of held) s.destroy();
    await fake.close();
  }
});

await testAsync('probeIdentity: nothing listening gives "connect failed: ..."', async () => {
  const msg = await rejection(probeIdentity(HOST, nextPort++, 2000));
  assert.ok(msg.startsWith('connect failed: '), msg);
});

await sleep(0);
summaryExit();
