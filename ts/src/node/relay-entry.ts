// `node deckbridge-relay.mjs [relay] --target …`: the relay for Macs that block the unsigned
// relay binary's network access. Same flags as `deckbridge relay`.
import process from 'node:process';
import { installTjsShim } from './tjs-shim.js';

const MIN_NODE_MAJOR = 20;

const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE_MAJOR) {
  console.error(
    `deckbridge relay: needs Node.js ${MIN_NODE_MAJOR} or newer, this is ${process.versions.node}. ` +
      'Get it from https://nodejs.org',
  );
  process.exit(1);
}
installTjsShim();
const args = process.argv.slice(2);
if (args[0] === 'relay') args.shift();
// The mDNS advertiser is native tjs code (build.mjs stubs it), so it is always off here.
// First, so a trailing value flag still reports its missing value.
if (!args.includes('--no-advertise')) args.unshift('--no-advertise');
// Dynamic: the logger reads tjs.env at module load, so the shim must exist first.
const { runRelayCommand } = await import('../main/relay/run.js');
const code = await runRelayCommand(args);
// Not process.exit() now: macOS writes pipes asynchronously, so the last lines could be lost.
process.exitCode = code;
(setTimeout(() => process.exit(code), 2000) as unknown as { unref(): void }).unref();
