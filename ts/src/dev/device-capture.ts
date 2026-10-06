import { DEVICE_MODELS, findModelById } from '../devices/registry.js';
import { captureInventory, fail, initProbeLibs, writeFixtureSkeleton } from './probe-utils.js';

// Writes a packet-fixture skeleton for a connected device: identity (model, PID, HID
// interface) from enumeration, no steps. Append the observed traffic from the
// model-specific probes (d6-capture, akp05-capture), then replay it with
// `mise run test`. Usage: mise run device-capture -- --model <id> [--out <dir>].
// This probe ENUMERATES ONLY. It never opens the device and never writes to it.

const PREFIX = '[capture]';
const DEFAULT_OUT = 'test/fixtures/packets';

function argValue(flag: string): string | undefined {
  const at = tjs.args.indexOf(flag);
  return at >= 0 ? tjs.args[at + 1] : undefined;
}

const modelId = argValue('--model');
if (!modelId) {
  fail(
    PREFIX,
    'usage: mise run device-capture -- --model <id> [--out <dir>]',
    `model ids: ${DEVICE_MODELS.map((m) => m.id).join(', ')}`,
  );
}
const model = findModelById(modelId);
if (!model) fail(PREFIX, `unknown model '${modelId}'.`, 'Pick one of the ids from the catalog.');

console.log(`${PREFIX} enumerates only: never opens or writes to the device.`);
await initProbeLibs();
const found = captureInventory([model]);
if (found.length === 0) {
  fail(
    PREFIX,
    `no ${model.name} connected (VID 0x${model.usbVendorId.toString(16)}); nothing written.`,
    'Plug the device in and run the `devices` subcommand to see what enumeration reports.',
  );
}
const first = found[0]!;
if (found.length > 1) console.log(`${PREFIX} ${found.length} interfaces match, using the first`);
const file = await writeFixtureSkeleton(first, argValue('--out') ?? DEFAULT_OUT, PREFIX);
console.log(`${PREFIX} wrote ${file} (no steps yet; append the captured traffic by hand).`);
