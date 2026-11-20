/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import { orbstackCommands } from '../src/web/client/simple/pairing-wizard/vm-commands.js';
import type { PairingProbe } from '../src/web/contract-pairing-route.js';
import { test, summary } from './helpers/harness.js';

console.log('\npairing-wizard OrbStack commands');

const MAC: PairingProbe = {
  platform: 'macOS',
  lanIp: '192.168.2.212',
  coraPort: 5343,
  webuiPort: 3000,
  relayScriptPort: 44661,
  lanReachable: false,
  wsl: null,
  mac: {
    version: '15.6',
    arch: 'arm64',
    orbstack: true,
    container: false,
    localNetworkBlocked: false,
  },
};

const INSTALL = 'curl -fsSL "http://192.168.2.212:44661/relay.sh?t=abc" | sh';

test('run nests the served install command in the machine', () => {
  const c = orbstackCommands(MAC, INSTALL);
  if (c === null) throw new Error('expected commands');
  assert.equal(c.create, 'orb create ubuntu:noble deckbridge-relay');
  assert.equal(c.ip, 'orb -m deckbridge-relay hostname -I');
  assert.equal(c.run, `orb -m deckbridge-relay sh -c '${INSTALL}'`);
});

test('no probe, no Mac info, no LAN IP or no install command gives null', () => {
  assert.equal(orbstackCommands(null, INSTALL), null);
  assert.equal(orbstackCommands({ ...MAC, mac: null }, INSTALL), null);
  assert.equal(orbstackCommands({ ...MAC, lanIp: '' }, INSTALL), null);
  assert.equal(orbstackCommands(MAC, null), null);
});

summary();
