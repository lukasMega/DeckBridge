import { MiraboxDriver } from './mirabox.js';
import { transformImageForDevice } from './translator.js';
import { exitOnSigint, logKeyEvents } from './probe-utils.js';
import { MIRABOX_293_MODEL } from './devices/mirabox/mirabox-293.js';

// 1×1 red pixel BMP (58 bytes). The image-proc sidecar's load_from_memory
// auto-detects BMP format and resizes to 112×112 JPEG for the device.
const RED_BMP = Buffer.from(
  '424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b000000000000000000000000ff00',
  'hex',
);

const mirabox = new MiraboxDriver(MIRABOX_293_MODEL);
await mirabox.open();
console.log('[mirabox] connected');

const jpeg = transformImageForDevice(RED_BMP, MIRABOX_293_MODEL.image);
mirabox.sendImage(11, jpeg);
console.log('[mirabox] test image sent to key imgId=11 (top-left)');
console.log('[mirabox] press keys to test... (Ctrl+C to exit)');

logKeyEvents(mirabox);

exitOnSigint(mirabox);
