import assert from 'tjs:assert';
import { relayScript } from '../src/web/server/relay-script.js';
import { test, summary } from './helpers/harness.js';

/* eslint-disable sonarjs/no-hardcoded-ip -- fixture address, nothing is contacted */
console.log('\nrelay install script');

const P = { version: 'v0.23.0', target: '192.168.2.212', targetPort: 5343 };

test('script bakes version, target and port; runs everything from main()', () => {
  const s = relayScript(P);
  assert.ok(s.startsWith('#!/bin/sh\n'));
  assert.ok(s.includes("VERSION='0.23.0'"));
  assert.ok(s.includes("TARGET='192.168.2.212'"));
  assert.ok(s.includes("TARGET_PORT='5343'"));
  assert.ok(s.includes('/deckbridge-v0.23.0'));
  assert.ok(s.includes('sha256sum -c'));
  assert.ok(s.trimEnd().endsWith('main "$@"'));
});

test('arch is detected in the VM, not baked in', () => {
  const s = relayScript(P);
  assert.ok(s.includes('x86_64 | amd64) arch=x86_64'));
  assert.ok(s.includes('aarch64 | arm64) arch=arm64'));
  assert.ok(s.includes('linux-${arch}.zip'));
});

test('a value that could inject shell is refused', () => {
  assert.throws(() => relayScript({ ...P, version: "1.0.0'; rm -rf ~; '" }));
  assert.throws(() => relayScript({ ...P, target: '1.2.3.4; id' }));
  assert.throws(() => relayScript({ ...P, targetPort: 0 }));
});

summary();
