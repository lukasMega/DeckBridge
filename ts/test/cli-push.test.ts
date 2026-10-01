import assert from 'tjs:assert';
import { parsePushArgs, runPushCommand } from '../src/cli/push.js';
import { parseCliArgs } from '../src/shared/cli.js';
import { testAsync as test, summary } from './helpers/harness.js';

console.log('\nparsePushArgs');

await test('token from env vs --token; missing token errors', () => {
  const a = parsePushArgs(['obs', 'hi'], { DECKBRIDGE_PUSH_TOKEN: 'dbp_e' });
  assert.ok(!('error' in a) && a.token === 'dbp_e');
  const b = parsePushArgs(['obs', 'hi', '--token', 'dbp_f'], { DECKBRIDGE_PUSH_TOKEN: 'dbp_e' });
  assert.ok(!('error' in b) && b.token === 'dbp_f');
  assert.ok('error' in parsePushArgs(['obs', 'hi'], {}));
});

await test('--clear vs text, bad channel, bad ttl', () => {
  const env = { DECKBRIDGE_PUSH_TOKEN: 't' };
  const c = parsePushArgs(['obs', '--clear'], env);
  assert.ok(!('error' in c) && c.clear && c.text === undefined);
  assert.ok('error' in parsePushArgs(['obs', 'hi', '--clear'], env));
  assert.ok('error' in parsePushArgs(['obs'], env));
  assert.ok('error' in parsePushArgs(['Bad Name', 'hi'], env));
  assert.ok('error' in parsePushArgs(['obs', 'hi', '--ttl', 'x'], env));
  assert.ok('error' in parsePushArgs(['obs', 'hi', '--nope'], env));
});

await test('default url honours DECKBRIDGE_WEBUI_PORT; --url trims slashes', () => {
  const a = parsePushArgs(['obs', 'hi'], {
    DECKBRIDGE_PUSH_TOKEN: 't',
    DECKBRIDGE_WEBUI_PORT: '4000',
  });
  assert.ok(!('error' in a) && a.url === 'http://127.0.0.1:4000');
  const b = parsePushArgs(['obs', 'hi', '--url', 'https://h:1//'], { DECKBRIDGE_PUSH_TOKEN: 't' });
  assert.ok(!('error' in b) && b.url === 'https://h:1');
});

console.log('\nrunPushCommand');

const env = { DECKBRIDGE_PUSH_TOKEN: 'dbp_t' };

await test('200 → 0, sends bearer + JSON body', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const f = ((url: string, init: RequestInit) => {
    seen = { url, init };
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }) as unknown as typeof fetch;
  assert.equal(await runPushCommand(['obs', 'hi', '--ttl', '5'], f, env), 0);
  assert.equal(seen!.url, 'http://127.0.0.1:3000/api/push/obs');
  assert.equal(seen!.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen!.init.body as string), { text: 'hi', ttl: 5 });
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer dbp_t');
});

await test('401 → 1; usage error → 2; --clear sends DELETE', async () => {
  const f401 = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
    )) as unknown as typeof fetch;
  assert.equal(await runPushCommand(['obs', 'hi'], f401, env), 1);
  assert.equal(await runPushCommand(['obs'], f401, env), 2);
  let method = '';
  const f = ((_u: string, init: RequestInit) => {
    method = init.method!;
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;
  assert.equal(await runPushCommand(['obs', '--clear'], f, env), 0);
  assert.equal(method, 'DELETE');
});

console.log('\nparseCliArgs push');

await test('push keeps its rest args and skips flag parsing', () => {
  const r = parseCliArgs(['push', 'obs', 'hi', '--ttl', '5']);
  assert.ok(r.ok && r.cli.command === 'push');
  assert.deepEqual(r.ok && r.cli.rest, ['obs', 'hi', '--ttl', '5']);
});

summary();
