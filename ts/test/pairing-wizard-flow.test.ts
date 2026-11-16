/* eslint-disable sonarjs/no-hardcoded-ip -- fixture addresses, nothing is contacted */
import assert from 'tjs:assert';
import type { PairingProbe, PairingRoute, PairingRouteStatus } from '../src/web/client/ui-types.js';
import {
  isAffected,
  parseVersion,
  screens,
  shouldAutoOpen,
  versionDefault,
  type Answers,
} from '../src/web/client/simple/pairing-wizard/flow.js';
import {
  ENABLED_ROUTES,
  ROUTE_COSTS,
  isRelayRoute,
  routeOptions,
} from '../src/web/client/simple/pairing-wizard/routes.js';
import { test, summary } from './helpers/harness.js';

console.log('\npairing wizard flow');

const ids = (a: Answers): string => screens(a).join(',');

test('screens: version first, old ends at done-old', () => {
  assert.equal(ids({}), 'version');
  assert.equal(ids({ version: 'old' }), 'version,done-old');
});

test('screens: new and unsure both go to where', () => {
  assert.equal(ids({ version: 'new' }), 'version,where');
  assert.equal(ids({ version: 'unsure' }), 'version,where');
});

test('screens: elsewhere ends at done-elsewhere', () => {
  assert.equal(ids({ version: 'new', where: 'elsewhere' }), 'version,where,done-elsewhere');
});

test('screens: here goes why, device, then choose once answered', () => {
  const base: Answers = { version: 'new', where: 'here' };
  assert.equal(ids(base), 'version,where,why,device');
  assert.equal(ids({ ...base, otherDevice: false }), 'version,where,why,device,choose');
  assert.equal(
    ids({ ...base, otherDevice: true, route: 'none' }),
    'version,where,why,device,choose',
  );
});

test('screens: wsl and downgrade end at setup, relay routes get add', () => {
  const base: Answers = { version: 'new', where: 'here', otherDevice: false };
  const head = 'version,where,why,device,choose,setup';
  assert.equal(ids({ ...base, route: 'downgrade' }), head);
  assert.equal(ids({ ...base, route: 'wsl' }), head);
  for (const route of ['device', 'container', 'orbstack'] as const) {
    assert.equal(ids({ ...base, route }), `${head},add`);
  }
});

test('parseVersion', () => {
  assert.deepEqual(parseVersion('7.6.1'), [7, 6, 1]);
  assert.deepEqual(parseVersion('7.6.1.23015'), [7, 6, 1]);
  assert.deepEqual(parseVersion('7.10.0'), [7, 10, 0]);
  assert.deepEqual(parseVersion('8.0'), [8, 0, 0]);
  assert.equal(parseVersion('junk'), null);
  assert.equal(parseVersion('7'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
});

test('isAffected boundary', () => {
  assert.equal(isAffected('7.6.0'), false);
  assert.equal(isAffected('7.6.0.23012'), false);
  assert.equal(isAffected('7.5.9'), false);
  assert.equal(isAffected('6.9.9'), false);
  assert.equal(isAffected('7.6.1'), true);
  assert.equal(isAffected('7.6.1.23015'), true);
  assert.equal(isAffected('7.10.0'), true);
  assert.equal(isAffected('8.0'), true);
  assert.equal(isAffected('junk'), null);
  assert.equal(isAffected(null), null);
});

test('versionDefault', () => {
  assert.equal(versionDefault('7.6.1'), 'new');
  assert.equal(versionDefault('7.6.0'), 'old');
  assert.equal(versionDefault(null), undefined);
});

function status(over: Partial<PairingRouteStatus> = {}): PairingRouteStatus {
  return {
    supported: true,
    route: 'none',
    elgatoVersion: '7.6.1',
    relayIp: null,
    relayVersion: null,
    versionMismatch: false,
    announcedAt: null,
    relay: null,
    paired: false,
    wizardDismissed: false,
    ...over,
  };
}

test('shouldAutoOpen', () => {
  assert.equal(shouldAutoOpen(status(), true), true);
  assert.equal(shouldAutoOpen(status(), false), false);
  assert.equal(shouldAutoOpen(null, true), false);
  assert.equal(shouldAutoOpen(status({ supported: false }), true), false);
  assert.equal(shouldAutoOpen(status({ route: 'wsl' }), true), false);
  assert.equal(shouldAutoOpen(status({ wizardDismissed: true }), true), false);
  assert.equal(shouldAutoOpen(status({ elgatoVersion: '7.6.0' }), true), false);
  assert.equal(shouldAutoOpen(status({ elgatoVersion: null }), true), false);
});

// Shapes mirror T1's mockProbe scenarios.
const base = {
  lanIp: '192.168.1.5',
  coraPort: 5343,
  webuiPort: 3000,
  relayScriptPort: 44661,
  lanReachable: true,
};
const PROBES: Record<string, PairingProbe> = {
  'windows-wsl': {
    ...base,
    platform: 'Windows',
    mac: null,
    wsl: { installed: true, distros: [{ name: 'Ubuntu-24.04', version: 2, isDefault: true }] },
  },
  'windows-none': {
    ...base,
    platform: 'Windows',
    mac: null,
    wsl: { installed: false, distros: [] },
  },
  'windows-wsl1': {
    ...base,
    platform: 'Windows',
    mac: null,
    wsl: { installed: true, distros: [{ name: 'Debian', version: 1, isDefault: true }] },
  },
  'mac-26': {
    ...base,
    platform: 'macOS',
    wsl: null,
    mac: { version: '26.1', arch: 'arm64', orbstack: false, container: true },
  },
  'mac-15': {
    ...base,
    platform: 'macOS',
    wsl: null,
    mac: { version: '15.6', arch: 'arm64', orbstack: true, container: false },
  },
  'mac-intel': {
    ...base,
    platform: 'macOS',
    wsl: null,
    mac: { version: '15.6', arch: 'x86_64', orbstack: false, container: false },
  },
  other: { ...base, platform: 'other', wsl: null, mac: null },
};

const ALL: ReadonlySet<PairingRoute> = new Set([
  'downgrade',
  'device',
  'wsl',
  'container',
  'orbstack',
]);
const order = (p: PairingProbe, other: boolean, en?: ReadonlySet<PairingRoute>): string =>
  routeOptions(p, other, en)
    .map((o) => o.route)
    .join(',');
const rec = (p: PairingProbe, other: boolean, en?: ReadonlySet<PairingRoute>): string =>
  routeOptions(p, other, en)
    .filter((o) => o.recommended)
    .map((o) => o.route)
    .join(',');

test('phase gate: P1 offers downgrade, device, wsl, orbstack', () => {
  assert.deepEqual(
    [...ENABLED_ROUTES].toSorted((a, b) => a.localeCompare(b)),
    ['device', 'downgrade', 'orbstack', 'wsl'],
  );
});

test('routeOptions: downgrade first, device only with otherDevice', () => {
  assert.equal(order(PROBES['windows-wsl']!, false), 'downgrade,wsl');
  assert.equal(order(PROBES['windows-wsl']!, true), 'downgrade,device,wsl');
  assert.equal(order(PROBES['mac-26']!, false, ALL), 'downgrade,container,orbstack');
  assert.equal(order(PROBES['mac-26']!, true, ALL), 'downgrade,device,container,orbstack');
  assert.equal(order(PROBES['other']!, false, ALL), 'downgrade');
  assert.equal(order(PROBES['other']!, true, ALL), 'downgrade,device');
});

test('routeOptions: otherDevice recommends device only', () => {
  for (const [name, p] of Object.entries(PROBES)) {
    assert.equal(rec(p, true, ALL), 'device', name);
  }
});

test('routeOptions: windows recommendation and badges', () => {
  const wsl = (k: string) => routeOptions(PROBES[k]!, false).find((o) => o.route === 'wsl')!;
  assert.equal(rec(PROBES['windows-wsl']!, false), 'wsl');
  assert.equal(wsl('windows-wsl').badge, 'Ready: Ubuntu-24.04 (WSL 2)');
  assert.equal(rec(PROBES['windows-wsl1']!, false), 'wsl');
  assert.equal(wsl('windows-wsl1').badge, 'WSL 1 found: needs WSL 2');
  assert.equal(rec(PROBES['windows-none']!, false), 'wsl');
  assert.equal(wsl('windows-none').badge, 'Not installed: about 15 min + restart');
  assert.equal(wsl('windows-none').disabled, false);
});

test('routeOptions: mac-26 recommends the installed container', () => {
  const opts = routeOptions(PROBES['mac-26']!, false, ALL);
  assert.equal(rec(PROBES['mac-26']!, false, ALL), 'container');
  const c = opts.find((o) => o.route === 'container')!;
  const o = opts.find((x) => x.route === 'orbstack')!;
  assert.equal(c.badge, 'Installed');
  assert.equal(c.disabled, false);
  assert.equal(o.badge, 'Not installed: about 5 min');
});

test('routeOptions: mac-15 disables container, recommends installed orbstack', () => {
  const opts = routeOptions(PROBES['mac-15']!, false, ALL);
  const c = opts.find((o) => o.route === 'container')!;
  assert.equal(c.disabled, true);
  assert.equal(c.badge, 'Needs macOS 26 on Apple silicon');
  assert.equal(rec(PROBES['mac-15']!, false, ALL), 'orbstack');
  assert.equal(opts.find((o) => o.route === 'orbstack')!.badge, 'Installed');
});

test('routeOptions: mac-intel falls back to orbstack, container disabled', () => {
  assert.equal(rec(PROBES['mac-intel']!, false, ALL), 'orbstack');
  const c = routeOptions(PROBES['mac-intel']!, false, ALL).find((o) => o.route === 'container')!;
  assert.equal(c.disabled, true);
});

test('routeOptions: a macOS 26 arm64 Mac with nothing installed recommends container', () => {
  const p: PairingProbe = {
    ...PROBES['mac-26']!,
    mac: { version: '26.0', arch: 'arm64', orbstack: false, container: false },
  };
  assert.equal(rec(p, false, ALL), 'container');
  assert.equal(
    routeOptions(p, false, ALL).find((o) => o.route === 'container')!.badge,
    'Not installed: about 5 min',
  );
});

test('routeOptions: P1 gate on macOS offers a same-Mac relay (OrbStack), recommended', () => {
  // Regression: P1 once left a Mac with no other device at downgrade only.
  assert.equal(order(PROBES['mac-26']!, false), 'downgrade,orbstack');
  assert.equal(rec(PROBES['mac-26']!, false), 'orbstack');
  assert.equal(rec(PROBES['mac-intel']!, false), 'orbstack');
});

test('routeOptions: downgrade is never recommended, costs and text are wired', () => {
  for (const p of Object.values(PROBES)) {
    for (const other of [false, true]) {
      const d = routeOptions(p, other, ALL)[0]!;
      assert.equal(d.route, 'downgrade');
      assert.equal(d.recommended, false);
      assert.equal(d.badge, null);
      assert.equal(d.title, 'Use Stream Deck app 7.6.0');
      assert.equal(d.cost, ROUTE_COSTS.downgrade);
    }
  }
  assert.equal(ROUTE_COSTS.wsl.ram, '~300–600 MB while on');
  assert.equal(ROUTE_COSTS.device.money, 'free if you own one (Raspberry Pi Zero 2 W ~$15)');
});

test('isRelayRoute', () => {
  for (const r of ['wsl', 'device', 'container', 'orbstack'] as const)
    assert.equal(isRelayRoute(r), true);
  assert.equal(isRelayRoute('none'), false);
  assert.equal(isRelayRoute('downgrade'), false);
});

summary();
