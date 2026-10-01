/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import {
  addressSteps,
  defaultTab,
  elgatoEntry,
  isIpv4,
  isLoopbackIp,
} from '../src/web/client/simple/address-steps.js';
import { test, summary } from './helpers/harness.js';

console.log('\naddress steps');

test('macOS: ifconfig alias with its undo, and the reboot note', () => {
  const s = addressSteps('macos', '127.0.0.2');
  assert.equal(s.command, 'sudo ifconfig lo0 alias 127.0.0.2 up');
  assert.equal(s.undo, 'sudo ifconfig lo0 -alias 127.0.0.2');
  assert.ok(s.notes.join(' ').includes('reboot'));
  assert.equal(s.unverified, false);
});

test('Linux: ip addr fallback, marked unverified', () => {
  const s = addressSteps('linux', '127.0.0.3');
  assert.equal(s.command, 'sudo ip addr add 127.0.0.3/8 dev lo');
  assert.equal(s.undo, 'sudo ip addr del 127.0.0.3/8 dev lo');
  assert.equal(s.unverified, true);
});

test('Windows: no admin command, falls back to LAN/VPN advice', () => {
  const s = addressSteps('windows', '127.0.0.2');
  assert.equal(s.command, undefined);
  assert.equal(s.undo, undefined);
  assert.ok(s.notes.join(' ').includes('LAN IP or a VPN adapter'));
  assert.equal(s.unverified, true);
});

test('LAN, 127.0.0.1 and invalid addresses never get a command', () => {
  for (const os of ['macos', 'linux', 'windows'] as const) {
    assert.equal(addressSteps(os, '192.168.1.5').command, undefined);
    assert.equal(addressSteps(os, '127.0.0.1').command, undefined);
    assert.equal(addressSteps(os, '127.0.0.2; rm -rf /').command, undefined);
    assert.equal(addressSteps(os, '').command, undefined);
  }
});

test('IPv4 and loopback checks', () => {
  assert.equal(isIpv4('127.0.0.2'), true);
  assert.equal(isIpv4('256.0.0.1'), false);
  assert.equal(isIpv4('1.2.3'), false);
  assert.equal(isLoopbackIp('127.9.9.9'), true);
  assert.equal(isLoopbackIp('10.0.0.1'), false);
});

test('default tab follows the platform; other falls back to Linux', () => {
  assert.equal(defaultTab('macos'), 'macos');
  assert.equal(defaultTab('windows'), 'windows');
  assert.equal(defaultTab('linux'), 'linux');
  assert.equal(defaultTab('other'), 'linux');
});

test('elgatoEntry joins ip and port', () => {
  assert.equal(elgatoEntry('127.0.0.2', 5349), '127.0.0.2:5349');
});

summary();
