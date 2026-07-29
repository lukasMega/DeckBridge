// Layer 1 — build smoke.
//
// Runs the real production build, then asserts the shape of build/. Deliberately
// does NOT run `docusaurus clear`: clear wipes node_modules/.cache, which is where
// remark-mermaid-prerender keeps its content-hashed SVGs, forcing a full headless
// Chrome re-render of every diagram. `npm run test:cold` is the opt-in cold path.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BUILD_DIR,
  DOC_ROUTES,
  EXPECTED_BASE_URL,
  EXPECTED_ROUTES,
  SITE_DIR,
  baseUrlFromSitemap,
  sitemapUrls,
} from './lib.mts';

test('docusaurus build succeeds', () => {
  execFileSync('npm', ['run', 'build'], {
    cwd: SITE_DIR,
    stdio: 'inherit',
    env: process.env,
  });
});

test('landing page and 404 are emitted', () => {
  const index = join(BUILD_DIR, 'index.html');
  assert.ok(existsSync(index), 'build/index.html missing');
  assert.ok(statSync(index).size > 0, 'build/index.html is empty');
  assert.ok(existsSync(join(BUILD_DIR, '404.html')), 'build/404.html missing');
});

test('sitemap lists exactly the expected routes', () => {
  const routes = sitemapUrls()
    .map((u) => new URL(u).pathname.slice(EXPECTED_BASE_URL.length).replace(/\/$/, ''))
    .sort();

  assert.deepEqual(
    routes,
    [...EXPECTED_ROUTES].sort(),
    'sitemap routes drifted — update EXPECTED_ROUTES in lib.ts if this was intentional',
  );
});

test('baseUrl in the sitemap matches the configured baseUrl', () => {
  // Guards every other link assertion: if baseUrl changes and this is not
  // updated, resolveHref would reject all links instead of silently passing.
  assert.equal(baseUrlFromSitemap(), EXPECTED_BASE_URL);
});

test('every doc route emitted an index.html', () => {
  for (const route of DOC_ROUTES) {
    const file = join(BUILD_DIR, route, 'index.html');
    assert.ok(existsSync(file), `missing built page for doc route '${route}'`);
    assert.ok(statSync(file).size > 0, `built page for '${route}' is empty`);
  }
});

test('search index is emitted and is valid JSON', () => {
  // Note: not content-hashed despite `hashed: true` in the theme options.
  const file = join(BUILD_DIR, 'search-index.json');
  assert.ok(existsSync(file), 'build/search-index.json missing');
  assert.doesNotThrow(
    () => JSON.parse(readFileSync(file, 'utf8')),
    'search-index.json is not valid JSON',
  );
});

test('static asset directories are emitted', () => {
  for (const dir of ['assets', 'img']) {
    assert.ok(existsSync(join(BUILD_DIR, dir)), `build/${dir}/ missing`);
  }
});
