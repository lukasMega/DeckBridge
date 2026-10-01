import assert from 'tjs:assert';
import { fetchTextBounded } from '../src/main/bounded-http.js';
import { commandOutputFor, fetchWeatherTemp } from '../src/main/widget-refresh.js';
import type { SourceSeams } from '../src/main/widget-refresh.js';
import { renderWidgetLines } from '../src/main/widget-lines.js';
import { testAsync as test, summaryExit } from './helpers/harness.js';

const noop = (): void => {};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const macrotask = (): Promise<void> => sleep(0);
const NOW = new Date(2026, 6, 15, 9, 5);

async function withFetch(
  impl: (signal: AbortSignal) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (_u: string, init: RequestInit) => impl(init.signal!);
  try {
    await fn();
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
}

async function rejects(p: Promise<unknown>): Promise<void> {
  try {
    await p;
  } catch {
    return;
  }
  throw new Error('expected rejection');
}

const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('AbortError')), { once: true }),
  );

const stream = (chunks: string[], onCancel: () => void, hang = false): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        if (!hang) c.close();
      },
      cancel: onCancel,
    }),
  );

console.log('\nweather HTTP lifecycle');

await test('hanging endpoint: deadline rejects, signal aborted', async () => {
  let signal: AbortSignal | undefined;
  await withFetch(
    (s) => {
      signal = s;
      return untilAborted(s);
    },
    async () => {
      await rejects(fetchWeatherTemp(1, 2, 40));
      assert.ok(signal!.aborted);
    },
  );
});

await test('stalled body after headers: deadline covers the body, stream cancelled', async () => {
  let cancelled = false;
  await withFetch(
    () => Promise.resolve(stream(['{"cur'], () => (cancelled = true), true)),
    async () => {
      await rejects(fetchWeatherTemp(1, 2, 60));
      assert.ok(cancelled);
    },
  );
});

await test('partial/invalid body rejects instead of yielding a value', async () => {
  let cancelled = false;
  await withFetch(
    () => Promise.resolve(stream(['{"current_weather":{"temp'], () => (cancelled = true))),
    async () => {
      await rejects(fetchWeatherTemp(1, 2, 1000));
    },
  );
  assert.equal(cancelled, false, 'a fully read body is not cancelled by the stream owner');
});

await test('oversized body is cut off at the cap and cancelled', async () => {
  let cancelled = false;
  await withFetch(
    () =>
      Promise.resolve(
        stream(['x'.repeat(40 * 1024), 'x'.repeat(40 * 1024)], () => (cancelled = true), true),
      ),
    async () => {
      await rejects(fetchWeatherTemp(1, 2, 1000));
      assert.ok(cancelled);
    },
  );
});

await test('HTTP error cancels the body', async () => {
  let cancelled = false;
  await withFetch(
    () => {
      const r = stream(['err'], () => (cancelled = true), true);
      return Promise.resolve(new Response(r.body, { status: 503 }));
    },
    async () => {
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- weather is http-only (no TLS in the slim build)
      await rejects(fetchTextBounded('http://x/', 1000, 1024));
      assert.ok(cancelled);
    },
  );
});

await test('valid response parses the temperature', async () => {
  await withFetch(
    () => Promise.resolve(new Response('{"current_weather":{"temperature":21.5}}')),
    async () => assert.equal(await fetchWeatherTemp(1, 2, 1000), 21.5),
  );
});

console.log('\nwidget caches');

function seams(clock: { t: number }, run: SourceSeams['run']): SourceSeams {
  return { now: () => clock.t, run };
}

await test('idle command entry is evicted after its TTL, on the next insert', async () => {
  const clock = { t: 10_000_000 };
  const s = seams(clock, (cmd) => Promise.resolve(`out:${cmd}`));
  commandOutputFor('evict-a', 1000, 1000, () => {}, s);
  await macrotask();
  assert.equal(
    commandOutputFor('evict-a', 1000, 1000, () => {}, s),
    'out:evict-a',
  );
  clock.t += 10 * 60_000; // config edited away: nobody asks for evict-a again
  commandOutputFor('evict-b', 1000, 1000, () => {}, s); // insert sweeps
  await macrotask();
  clock.t += 1; // evict-a reappears as a brand new entry
  assert.equal(
    commandOutputFor('evict-a', 1000, 1000, () => {}, s),
    undefined,
  );
});

await test('an in-flight entry is never evicted: its callback still fires', async () => {
  const clock = { t: 20_000_000 };
  let finish: (v: string) => void = noop;
  const s = seams(clock, (cmd) =>
    cmd === 'slow' ? new Promise<string>((r) => (finish = r)) : Promise.resolve('x'),
  );
  let updates = 0;
  commandOutputFor('slow', 1000, 1000, () => updates++, s);
  clock.t += 60 * 60_000;
  commandOutputFor('other', 1000, 1000, () => {}, s); // sweep runs, slow is in flight
  finish('done');
  await macrotask();
  assert.equal(updates, 1);
  assert.equal(
    commandOutputFor('slow', 1000, 1000, () => {}, s),
    'done',
  );
});

await test('a later caller replaces the repaint closure of a shared entry', async () => {
  const clock = { t: 30_000_000 };
  let finish: (v: string) => void = noop;
  const s = seams(clock, () => new Promise<string>((r) => (finish = r)));
  let oldCalls = 0;
  let newCalls = 0;
  commandOutputFor('shared', 1000, 1000, () => oldCalls++, s);
  commandOutputFor('shared', 1000, 1000, () => newCalls++, s);
  finish('v');
  await macrotask();
  assert.equal(oldCalls, 0, 'stopped widget no longer retained/notified');
  assert.equal(newCalls, 1);
});

console.log('\ntextLines');

await test('large blob: only the first 4 non-empty lines, same output', () => {
  const blob = Array.from({ length: 50_000 }, (_, i) => ` l${i} `).join('\n\n');
  assert.deepEqual(
    renderWidgetLines({ widget: 'text', param: blob }, { now: NOW }),
    ['l0', 'l1', 'l2', 'l3'].map((text) => ({ text, big: false })),
  );
});

await test('blank-padded single short line stays big; CRLF and trailing newline trimmed', () => {
  assert.deepEqual(renderWidgetLines({ widget: 'text', param: '\n\n  ok \r\n\n' }, { now: NOW }), [
    { text: 'ok', big: true },
  ]);
  assert.equal(renderWidgetLines({ widget: 'text', param: ' \n\t\n' }, { now: NOW }), null);
});

summaryExit();
