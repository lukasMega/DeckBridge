/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import type { WslRelayState, WslRelayStatus } from '../src/web/contract-wsl-relay.js';
import {
  STUCK_HINT,
  wslRelayFailed,
  wslRelayStatusLine,
  wslRelaySteps,
} from '../src/web/client/simple/wsl-relay-steps.js';
import { test, summary } from './helpers/harness.js';

console.log('\nwsl relay steps');

function status(state: WslRelayState, over: Partial<WslRelayStatus> = {}): WslRelayStatus {
  return {
    supported: true,
    enabled: state !== 'off',
    state,
    wslIp: null,
    ipChanged: false,
    distro: null,
    detail: null,
    fixCommand: null,
    ...over,
  };
}

const states = (s: WslRelayStatus): string =>
  wslRelaySteps(s)
    .map((x) => x.state[0])
    .join('');

test('five steps, always in the same order', () => {
  const steps = wslRelaySteps(status('off'));
  assert.equal(steps.length, 5);
  assert.equal(steps[0]!.title, 'WSL is ready');
  assert.equal(steps[3]!.title, 'Add this IP in the Stream Deck app');
  assert.equal(states(status('off', { enabled: false })), 'ttttt');
});

test('progress marks earlier steps done and later ones todo', () => {
  assert.equal(states(status('checking')), 'atttt');
  assert.equal(states(status('downloading')), 'dattt');
  assert.equal(states(status('starting')), 'ddatt');
  assert.equal(states(status('ready', { wslIp: '172.20.1.2' })), 'dddat');
  assert.equal(states(status('paired', { wslIp: '172.20.1.2' })), 'ddddd');
});

test('prerequisite failures stop on step 1 with the fix command', () => {
  for (const state of ['no-wsl', 'wsl1', 'mirrored', 'old-glibc'] as const) {
    const steps = wslRelaySteps(status(state, { fixCommand: 'wsl --install' }));
    assert.equal(states(status(state)), 'etttt', state);
    assert.equal(steps[0]!.command, 'wsl --install', state);
    assert.ok(steps[0]!.sub, state);
    assert.equal(steps[1]!.command, undefined, state);
  }
});

test('a failed download is an error on step 2 and shows the server text', () => {
  const steps = wslRelaySteps(status('download-failed', { detail: 'Checksum mismatch.' }));
  assert.equal(states(status('download-failed')), 'dettt');
  assert.equal(steps[1]!.sub, 'Checksum mismatch.');
  assert.ok(wslRelaySteps(status('download-failed'))[1]!.sub!.includes('Check again'));
});

test('blocked is an error on step 3 with the firewall command', () => {
  const fw = 'New-NetFirewallRule -DisplayName "DeckBridge WSL relay"';
  const steps = wslRelaySteps(status('blocked', { fixCommand: fw }));
  assert.equal(states(status('blocked')), 'ddett');
  assert.equal(steps[2]!.command, fw);
  assert.ok(steps[2]!.sub!.includes('Firewall'));
});

test('an unexpected exit shows the relay text on step 3', () => {
  const steps = wslRelaySteps(status('error', { detail: "can't listen on 5343" }));
  assert.equal(steps[2]!.state, 'error');
  assert.equal(steps[2]!.sub, "can't listen on 5343");
});

test('ready: step 4 carries the IP and the add-dock sentence', () => {
  const steps = wslRelaySteps(status('ready', { wslIp: '172.20.1.2' }));
  assert.equal(steps[3]!.ip, '172.20.1.2');
  assert.ok(steps[3]!.sub!.includes('Network Dock by IP address'));
});

test('stuck adds the hint to step 4 only while ready', () => {
  const ready = status('ready', { wslIp: '172.20.1.2' });
  assert.equal(wslRelaySteps(ready)[3]!.hint, undefined);
  assert.equal(wslRelaySteps(ready, false)[3]!.hint, undefined);
  const steps = wslRelaySteps(ready, true);
  assert.equal(steps[3]!.hint, STUCK_HINT);
  assert.ok(STUCK_HINT.startsWith('Still not paired? Check that you added this exact IP.'));
  assert.equal(steps[3]!.sub, wslRelaySteps(ready)[3]!.sub);
  assert.equal(steps.filter((x) => x.hint !== undefined).length, 1);
  for (const state of ['starting', 'paired', 'blocked'] as const)
    assert.ok(
      wslRelaySteps(status(state), true).every((x) => x.hint === undefined),
      state,
    );
});

test('ready with a changed IP asks to replace the old dock', () => {
  const steps = wslRelaySteps(status('ready', { wslIp: '172.20.9.9', ipChanged: true }));
  assert.ok(steps[3]!.sub!.startsWith('The IP changed after a restart.'));
  assert.equal(steps[3]!.ip, '172.20.9.9');
});

test('paired keeps the IP on the done step', () => {
  const steps = wslRelaySteps(status('paired', { wslIp: '172.20.1.2' }));
  assert.equal(steps[3]!.state, 'done');
  assert.equal(steps[3]!.ip, '172.20.1.2');
  assert.equal(steps[4]!.state, 'done');
});

test('wslRelayFailed is true only for the failure states', () => {
  const failed = ['no-wsl', 'wsl1', 'mirrored', 'old-glibc', 'download-failed', 'blocked', 'error'];
  const all: WslRelayState[] = [
    'off',
    'checking',
    'no-wsl',
    'wsl1',
    'mirrored',
    'old-glibc',
    'downloading',
    'download-failed',
    'starting',
    'blocked',
    'ready',
    'paired',
    'error',
  ];
  for (const state of all) assert.equal(wslRelayFailed(status(state)), failed.includes(state));
});

test('status line for the Settings switch', () => {
  assert.equal(wslRelayStatusLine(status('off', { enabled: false })), 'Off');
  assert.equal(
    wslRelayStatusLine(status('downloading')),
    'Downloading the relay (first time only)…',
  );
  assert.equal(wslRelayStatusLine(status('blocked')), 'Needs attention');
  assert.equal(
    wslRelayStatusLine(status('ready', { wslIp: '172.20.1.2' })),
    'Ready · add 172.20.1.2 in the Stream Deck app',
  );
  assert.equal(
    wslRelayStatusLine(status('paired', { wslIp: '172.20.1.2' })),
    'Paired · 172.20.1.2',
  );
});

summary();
