// Not a real test — reproduces the k1pro-probe JPEG variants byte-for-byte
// and writes them to /tmp/k1pro-probe for offline boundary analysis.
import { transformImageForDevice, closeSidecar } from '../src/translator.js';
import { MIRABOX_K1PRO_MODEL } from '../src/devices/mirabox/mirabox-k1pro.js';

function stripesBmp(): Buffer {
  const w = 64;
  const h = 64;
  const rowBytes = w * 3;
  const buf = Buffer.alloc(54 + rowBytes * h, 0);
  buf[0] = 0x42;
  buf[1] = 0x4d;
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  const colors: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [255, 0, 255],
    [0, 255, 255],
    [255, 255, 255],
    [40, 40, 40],
  ];
  for (let row = 0; row < h; row++) {
    const [r, g, b] = colors[Math.floor(row / 8)]!;
    const off = 54 + row * rowBytes;
    for (let col = 0; col < w; col++) {
      buf[off + col * 3] = b;
      buf[off + col * 3 + 1] = g;
      buf[off + col * 3 + 2] = r;
    }
  }
  return buf;
}

function padJpegTo(jpeg: Uint8Array, target: number): Uint8Array {
  const extra = target - jpeg.length;
  if (extra === 0) return jpeg;
  if (extra < 4 || extra - 2 > 0xffff) throw new Error(`cannot pad to ${target}`);
  const payload = extra - 4;
  const out = new Uint8Array(target);
  out.set(jpeg.subarray(0, 2), 0);
  out[2] = 0xff;
  out[3] = 0xfe;
  out[4] = ((payload + 2) >> 8) & 0xff;
  out[5] = (payload + 2) & 0xff;
  out.fill(0x41, 6, 6 + payload);
  out.set(jpeg.subarray(2), 6 + payload);
  return out;
}

const base = transformImageForDevice(stripesBmp(), MIRABOX_K1PRO_MODEL.image);
console.log(`base=${base.length}`);
// eslint-disable-next-line sonarjs/publicly-writable-directories
await tjs.makeDir('/tmp/k1pro-probe', { recursive: true });
const targets = [base.length, base.length + 16, 1700, 1800, 2200, 2900];
for (const t of targets) {
  const padded = padJpegTo(base, Math.max(t, base.length));
  await tjs.writeFile(`/tmp/k1pro-probe/v${t}.jpg`, padded);
}
console.log('wrote /tmp/k1pro-probe');
closeSidecar();
