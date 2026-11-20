/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import type {
  PairingRoute,
  PairingRouteStatus,
  RelayProgress,
  WslRelayStatus,
} from '../src/web/client/ui-types.js';
import {
  appLine,
  buildLine,
  detailsTopic,
  relayAddress,
  relayHealth,
  relayProblem,
  seenAgo,
  uninstallCommand,
} from '../src/web/client/simple/pairing-wizard/route-details-model.js';
import { test, summary } from './helpers/harness.js';

console.log('\npairing route details model');

const relay = (over: Partial<RelayProgress> = {}): RelayProgress => ({
  stage: 'running',
  ip: '192.168.88.10',
  platform: 'linux-arm64',
  version: '0.22.0',
  at: 1000,
  ...over,
});

const status = (over: Partial<PairingRouteStatus> = {}): PairingRouteStatus => ({
  supported: true,
  route: 'device',
  elgatoVersion: '7.6.1',
  relayIp: null,
  relayVersion: null,
  versionMismatch: false,
  announcedAt: null,
  relay: null,
  paired: false,
  wizardDismissed: false,
  ...over,
});

const wslStatus = (over: Partial<WslRelayStatus> = {}): WslRelayStatus => ({
  supported: true,
  enabled: true,
  state: 'ready',
  wslIp: '172.20.0.2',
  ipChanged: false,
  distro: 'Ubuntu',
  detail: null,
  fixCommand: null,
  ...over,
});

test('relayHealth: script route without relay', () => {
  assert.deepEqual(relayHealth(status(), null), {
    label: 'Not reported yet',
    variant: 'dim',
    spin: false,
  });
});

const stageHealth = (stage: RelayProgress['stage']) =>
  relayHealth(status({ relay: relay({ stage }) }), null);

test('relayHealth: script stages', () => {
  for (const stage of ['downloading', 'installing', 'starting'] as const) {
    assert.deepEqual(stageHealth(stage), { label: 'Installing', variant: 'wait', spin: true });
  }
  assert.deepEqual(stageHealth('running'), { label: 'Running', variant: 'ok', spin: false });
  assert.deepEqual(stageHealth('offline'), { label: 'Offline', variant: 'accent', spin: false });
  assert.deepEqual(stageHealth('failed'), { label: 'Failed', variant: 'accent', spin: false });
});

test('relayHealth: script routes ignore wsl', () => {
  for (const route of ['orbstack', 'container'] as const) {
    const h = relayHealth(status({ route, relay: relay() }), wslStatus({ state: 'blocked' }));
    assert.equal(h.label, 'Running');
  }
});

const wslStateHealth = (state: WslRelayStatus['state']) =>
  relayHealth(status({ route: 'wsl' }), wslStatus({ state }));

test('relayHealth: wsl states', () => {
  assert.deepEqual(relayHealth(status({ route: 'wsl' }), null), {
    label: 'Checking',
    variant: 'wait',
    spin: true,
  });
  assert.deepEqual(wslStateHealth('checking'), { label: 'Checking', variant: 'wait', spin: true });
  assert.deepEqual(wslStateHealth('downloading'), {
    label: 'Downloading',
    variant: 'wait',
    spin: true,
  });
  assert.deepEqual(wslStateHealth('starting'), { label: 'Starting', variant: 'wait', spin: true });
  assert.deepEqual(wslStateHealth('ready'), { label: 'Running', variant: 'ok', spin: false });
  assert.deepEqual(wslStateHealth('paired'), { label: 'Running', variant: 'ok', spin: false });
  assert.deepEqual(wslStateHealth('off'), { label: 'Off', variant: 'dim', spin: false });
  for (const state of [
    'no-wsl',
    'wsl1',
    'mirrored',
    'old-glibc',
    'download-failed',
    'blocked',
    'error',
  ] as const) {
    assert.deepEqual(wslStateHealth(state), {
      label: 'Needs attention',
      variant: 'accent',
      spin: false,
    });
  }
});

test('seenAgo: buckets', () => {
  const now = 10_000_000;
  const ago = (ms: number) => seenAgo(now - ms, now);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(9900), 'just now');
  assert.equal(ago(10_000), '10 s ago');
  assert.equal(ago(59_000), '59 s ago');
  assert.equal(ago(60_000), '1 min ago');
  assert.equal(ago(59 * 60_000), '59 min ago');
  assert.equal(ago(60 * 60_000), '1 h ago');
  assert.equal(ago(3 * 3_600_000), '3 h ago');
});

test('seenAgo: null and future', () => {
  const now = 10_000_000;
  assert.equal(seenAgo(null, now), null);
  assert.equal(seenAgo(now + 6000, now), null);
  assert.equal(seenAgo(now + 4000, now), 'just now');
});

test('buildLine', () => {
  assert.equal(buildLine(relay()), 'linux-arm64 · v0.22.0');
  assert.equal(buildLine(null), null);
});

test('relayAddress', () => {
  const w = status({ route: 'wsl', relayIp: '1.1.1.1' });
  assert.equal(relayAddress(w, wslStatus()), '172.20.0.2');
  assert.equal(relayAddress(w, null), null);
  assert.equal(relayAddress(status({ relayIp: '10.0.0.5', relay: relay() }), null), '10.0.0.5');
  assert.equal(relayAddress(status({ relay: relay() }), null), '192.168.88.10');
  assert.equal(relayAddress(status(), null), null);
});

test('appLine', () => {
  const paired = status({ paired: true, relay: relay() });
  assert.equal(appLine(paired, '10.0.0.5', '10.0.0.5'), 'Paired via relay');
  assert.equal(appLine(paired, null, '192.168.88.10'), 'Paired via relay');
  assert.equal(appLine(paired, '10.0.0.5', '10.0.0.9'), 'Paired from 10.0.0.9');
  assert.equal(appLine(paired, '10.0.0.5', null), 'Paired');
  assert.equal(appLine(status(), '10.0.0.5', '10.0.0.5'), 'Waiting for the Stream Deck app');
});

test('uninstallCommand', () => {
  assert.equal(
    uninstallCommand('curl -fsSL "http://x/relay.sh?t=T" | sh'),
    'curl -fsSL "http://x/relay.sh?t=T" | sh -s -- --uninstall',
  );
  assert.equal(
    uninstallCommand('wget -qO- "http://x/relay.sh?t=T" | sh'),
    'wget -qO- "http://x/relay.sh?t=T" | sh -s -- --uninstall',
  );
  assert.equal(uninstallCommand(null), null);
  assert.equal(uninstallCommand('echo hi'), null);
});

const p = (over: Partial<PairingRouteStatus>) => relayProblem(status(over), '0.24.1');

test('relayProblem', () => {
  assert.equal(
    p({ relay: relay({ stage: 'failed', message: 'No space left.' }) }),
    'No space left. Run the command again on the device.',
  );
  assert.equal(
    p({ relay: relay({ stage: 'failed' }) }),
    'Install failed. Run the command again on the device.',
  );
  assert.equal(
    p({ relay: relay({ stage: 'offline' }) }),
    'Relay offline. Check the device, or run the command again.',
  );
  assert.equal(
    p({ relay: relay(), versionMismatch: true }),
    'The relay runs version 0.22.0, DeckBridge runs 0.24.1. Run the command again on the device.',
  );
  assert.equal(p({ relay: null, versionMismatch: true }), null);
  assert.equal(p({ relay: relay() }), null);
  assert.equal(p({}), null);
  assert.equal(p({ route: 'wsl', relay: relay({ stage: 'failed' }), versionMismatch: true }), null);
});

const t = (r: PairingRoute) => detailsTopic(r);

test('detailsTopic', () => {
  assert.equal(t('wsl'), 'wsl-relay');
  assert.equal(t('orbstack'), 'relay-orbstack');
  assert.equal(t('device'), 'relay-device');
  assert.equal(t('container'), 'relay-device');
  assert.equal(t('none'), 'relay-device');
  assert.equal(t('downgrade'), 'relay-device');
});

summary();
