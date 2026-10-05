import assert from 'tjs:assert';
import {
  DOCS_TOPICS,
  docsTrackingAllowed,
  docsUrl,
  isDocsTopic,
  isOwnNavigation,
} from '../src/web/server/docs-links.js';
import type { DocsTopic } from '../src/web/contract.js';
import { test, testAsync, summary } from './helpers/harness.js';

test('isDocsTopic accepts every topic and nothing inherited', () => {
  for (const t of Object.keys(DOCS_TOPICS)) assert.equal(isDocsTopic(t), true, t);
  for (const t of ['nope', '__proto__', 'toString', 'constructor', '']) {
    assert.equal(isDocsTopic(t), false, t);
  }
});

test('docsUrl puts utm_* before the anchor', () => {
  assert.equal(
    docsUrl('image-fit'),
    'https://lukasmega.github.io/DeckBridge/troubleshooting/?utm_source=deckbridge-app&utm_medium=webui&utm_campaign=image-fit#image-fit',
  );
  assert.equal(
    docsUrl('push-api'),
    'https://lukasmega.github.io/DeckBridge/push-api/?utm_source=deckbridge-app&utm_medium=webui&utm_campaign=push-api',
  );
  assert.equal(
    docsUrl('home'),
    'https://lukasmega.github.io/DeckBridge/?utm_source=deckbridge-app&utm_medium=webui&utm_campaign=home',
  );
});

const h = (init: Record<string, string>): Headers => new Headers(init);

test('isOwnNavigation uses Sec-Fetch-* when present', () => {
  assert.equal(isOwnNavigation(h({ 'sec-fetch-site': 'same-origin' })), true);
  assert.equal(
    isOwnNavigation(h({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' })),
    true,
  );
  assert.equal(
    isOwnNavigation(h({ 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' })),
    true,
  );
  assert.equal(
    isOwnNavigation(h({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' })),
    true,
  );
  assert.equal(
    isOwnNavigation(h({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' })),
    false,
  );
  assert.equal(isOwnNavigation(h({ 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(
    isOwnNavigation(h({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image' })),
    false,
  );
});

test('isOwnNavigation falls back to Referer host', () => {
  const host = '127.0.0.1:3000';
  assert.equal(isOwnNavigation(h({ host, referer: 'http://127.0.0.1:3000/' })), true);
  assert.equal(isOwnNavigation(h({ host, referer: 'http://evil.example/x' })), false);
  assert.equal(isOwnNavigation(h({ host })), false);
  assert.equal(isOwnNavigation(h({ host, referer: 'not a url' })), false);
  assert.equal(isOwnNavigation(h({})), false);
});

test('docsTrackingAllowed honours the daily-ping opt-outs', () => {
  assert.equal(docsTrackingAllowed(false, {}), false);
  assert.equal(docsTrackingAllowed(undefined, { DO_NOT_TRACK: '1' }), false);
  assert.equal(docsTrackingAllowed(undefined, { DECKBRIDGE_NO_DAILY_PING: '1' }), false);
  assert.equal(docsTrackingAllowed(undefined, { CI: '1' }), false);
  assert.equal(docsTrackingAllowed(undefined, {}), true);
  assert.equal(docsTrackingAllowed(true, {}), true);
});

// github-slugger, as Docusaurus uses for heading ids.
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_ -]/g, '')
    .replace(/ /g, '-');
}

async function readDoc(id: string): Promise<string> {
  for (const ext of ['md', 'mdx']) {
    try {
      return new TextDecoder().decode(await tjs.readFile(`../docs/${id}.${ext}`));
    } catch {
      // try the next extension
    }
  }
  throw new Error(`no docs page for ${id}`);
}

// Docusaurus onBrokenLinks cannot see links in app code; this is the guard.
for (const [topic, target] of Object.entries(DOCS_TOPICS) as [DocsTopic, string][]) {
  // `/` is the React landing page, not a doc.
  if (target === '/') continue;
  await testAsync(`docs target for ${topic} exists`, async () => {
    const [path, anchor] = target.split('#') as [string, string?];
    const body = await readDoc(path.replaceAll('/', ''));
    if (!anchor) return;
    const ids = body
      .split('\n')
      .filter((l) => l.startsWith('#'))
      .map((l) => slug(l.replace(/^#+/, '').trim()));
    assert.ok(ids.includes(anchor), `no heading with id "${anchor}" in ${path}`);
  });
}

summary();
