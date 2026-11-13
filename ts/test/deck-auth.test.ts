import assert from 'tjs:assert';
import { WebUIServer } from '../src/web/server/web-ui-server.js';
import { PersistedSettings } from '../src/infra/settings.js';
import { loadSettings } from '../src/infra/settings-store.js';
import { isPushTokenRecord, hashPushToken } from '../src/infra/push-tokens.js';
import { buildDiagnostics } from '../src/web/server/diagnostics.js';
import {
  DECK_DEVICES_MAX,
  PAIRING_MAX_FAILS,
} from '../src/web/server/virtual-deck/deck-constants.js';
import { cleanDeviceName } from '../src/web/server/virtual-deck/deck-auth.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const ROOT = `${tjs.tmpDir}/deck-auth-test-${tjs.pid}`;
const settings = new PersistedSettings(ROOT);
await settings.load();
const ui = new WebUIServer(13081, [], 'real', settings);
const { virtualDeck: admin, push } = ui;

/** Pair one device through the real exchange: offer → shortCode → token. */
async function pair(
  name = 'iPad',
  remote = 'remote-10-0-0-7',
): Promise<{ token: string; deviceId: string }> {
  // A listener-less controller still mints offers once a runtime exists; fake the bit it checks.
  admin.runtime ??= {
    server: { listening: true } as never,
    hub: { clients: () => [], latency: () => ({ count: 0 }) } as never,
  };
  const offer = admin.createPairing();
  assert.ok(!('error' in offer));
  const r = await admin.auth.pair(
    { shortCode: (offer as { shortCode: string }).shortCode, name },
    remote,
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { token: string; deviceId: string };
}

try {
  console.log('\ndeck auth');

  await test('pair mints a deck-only token, stored hashed, plaintext never persisted', async () => {
    const { token, deviceId } = await pair('My iPad');
    assert.ok(token.startsWith('dbp_'));
    const rec = settings.accessTokenRecords().find((r) => r.id === deviceId)!;
    assert.deepEqual(rec.scopes, ['deck']);
    assert.equal(rec.name, 'My iPad');
    assert.equal(rec.hash, await hashPushToken(token));
    await settings.flush();
    const onDisk = JSON.stringify(await loadSettings(ROOT));
    assert.ok(!onDisk.includes(token), 'plaintext on disk');
    assert.ok(isPushTokenRecord(rec));
  });

  await test('verify accepts a deck token and rejects a push-only token', async () => {
    const { token } = await pair('Phone');
    assert.ok(await admin.auth.verify(token));
    const created = (await push.createToken('curl')) as { token: string };
    assert.equal(await admin.auth.verify(created.token), null);
    assert.equal(await admin.auth.verify('dbp_nope'), null);
  });

  await test('the push panel lists only push tokens; the deck panel only deck tokens', () => {
    assert.ok(push.tokens().every((t) => t.scopes.includes('push')));
    const devices = admin.state().devices;
    assert.ok(devices.length >= 2);
    const pushIds = new Set(push.tokens().map((t) => t.id));
    assert.ok(devices.every((d) => !pushIds.has(d.id)));
  });

  await test('settings.json export and diagnostics carry neither plaintext nor hash of a deck token', async () => {
    const { token } = await pair('Leak check');
    const hash = await hashPushToken(token);
    assert.ok(!settings.json().includes(hash));
    assert.ok(!settings.json().includes(token));
    await settings.flush();
    const raw = JSON.stringify(await loadSettings(ROOT));
    const report = buildDiagnostics(
      { header: { version: 'x' } as never, settingsJson: raw },
      { redactCommands: false },
    );
    assert.ok(!report.includes(hash), 'hash in diagnostics');
    assert.ok(!report.includes(token), 'plaintext in diagnostics');
    assert.ok(report.includes('virtualDeck') || !raw.includes('virtualDeck'));
  });

  await test('wrong codes: 403 each, the pending pairing dies at the limit', async () => {
    admin.runtime ??= undefined as never;
    const offer = admin.createPairing() as { shortCode: string };
    const wrong = offer.shortCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < PAIRING_MAX_FAILS; i++) {
      assert.equal((await admin.auth.pair({ shortCode: wrong }, `remote-9-${i}`)).status, 403);
    }
    assert.equal(
      (await admin.auth.pair({ shortCode: offer.shortCode }, 'remote-10-9-9-99')).status,
      410,
    );
  });

  await test('the failed-auth bucket answers 429 with Retry-After after 10 misses from one address', async () => {
    admin.createPairing();
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await admin.auth.pair({ shortCode: 'nope' }, 'remote-10-8-8-8')).status;
    assert.equal(last, 429);
    const r = await admin.auth.pair({ shortCode: 'nope' }, 'remote-10-8-8-8');
    assert.ok((r.retryAfter ?? 0) >= 1);
  });

  await test('revoke removes a deck token (and refuses push tokens); revoke-all clears devices', async () => {
    const { deviceId } = await pair('Gone');
    const created = (await push.createToken('keep')) as { id: string };
    assert.equal(admin.revoke(deviceId), null);
    assert.equal(admin.revoke(deviceId)?.status, 404);
    assert.equal(admin.revoke(created.id)?.status, 404, 'a push token is not a device');
    assert.ok(admin.revokeAll() >= 1);
    assert.equal(admin.state().devices.length, 0);
    assert.ok(
      settings.accessTokenRecords().some((r) => r.id === created.id),
      'push token survives',
    );
  });

  await test('revoking emits tokenRevoked for the wiring', async () => {
    const { deviceId } = await pair('Emit');
    const seen: string[] = [];
    ui.on('tokenRevoked', (id: string) => seen.push(id));
    admin.revoke(deviceId);
    assert.deepEqual(seen, [deviceId]);
  });

  await test(`at most ${DECK_DEVICES_MAX} paired devices → 409, no code consumed`, async () => {
    admin.revokeAll();
    for (let i = 0; i < DECK_DEVICES_MAX; i++) await pair(`d${i}`, `remote-1-${i}`);
    const offer = admin.createPairing() as { shortCode: string };
    const r = await admin.auth.pair({ shortCode: offer.shortCode }, 'remote-10-1-1-200');
    assert.equal(r.status, 409);
    assert.ok(admin.state().pending, 'the pending pairing is still there');
    admin.revokeAll();
  });

  await test('device names: control chars out, 40 chars max, generic fallback', () => {
    assert.equal(cleanDeviceName('  iPad\u0000\n mini  '), 'iPad mini');
    assert.equal(cleanDeviceName('x'.repeat(100)).length, 40);
    assert.equal(cleanDeviceName(''), 'Browser');
    assert.equal(cleanDeviceName(42), 'Browser');
  });

  console.log('\nvirtual deck config');

  await test('setConfig validates, persists, and signals; an unknown profile falls back on load', async () => {
    const seen: string[] = [];
    ui.on('virtualDeckChanged', () => seen.push('x'));
    assert.equal((admin.setConfig({ enabled: 'yes' }) as { status: number }).status, 400);
    assert.equal((admin.setConfig({ profile: 'xl' }) as { status: number }).status, 400);
    const state = admin.setConfig({ enabled: true }) as { enabled: boolean };
    assert.equal(state.enabled, true);
    assert.equal(seen.length, 1);
    await settings.flush();
    assert.deepEqual((await loadSettings(ROOT)).virtualDeck, { enabled: true, profile: 'mk2' });
    const bad = new PersistedSettings(`${ROOT}/bad`);
    bad.virtualDeck = { enabled: true, profile: 'bogus' };
    bad.setVirtualDeck({ enabled: true, profile: 'bogus' });
    await bad.flush();
    const again = new PersistedSettings(`${ROOT}/bad`);
    await again.load();
    assert.deepEqual(again.virtualDeck, { enabled: true, profile: 'mk2' });
  });

  await test('createPairing needs a running listener', () => {
    admin.runtime = null;
    assert.equal((admin.createPairing() as { status: number }).status, 409);
  });
} finally {
  await settings.close();
}

summaryExit();
