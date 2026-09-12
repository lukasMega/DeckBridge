// Layer 5 — blog feed integrity.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BUILD_DIR,
  FEED_FILES,
  blogPostSlugs,
  expectedBlogRoutes,
  readPage,
  readSitemap,
  requireBuild,
} from './lib.mts';

requireBuild();

const expectedCount = Math.min(blogPostSlugs().length, 20);
const expectedPrefix = 'https://lukasmega.github.io/DeckBridge/blog/';

function readFeed(file: string): string {
  return readFileSync(join(BUILD_DIR, file), 'utf8');
}

function tagValues(xml: string, tag: string): string[] {
  return [
    ...xml.matchAll(
      new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'g'),
    ),
  ].map((match) => (match[1] as string).trim());
}

test('all feed files exist and are non-empty', () => {
  for (const file of FEED_FILES) {
    const path = join(BUILD_DIR, file);
    assert.ok(existsSync(path), `build/${file} missing`);
    assert.ok(statSync(path).size > 0, `build/${file} is empty`);
  }
});

test('RSS contains one channel and every post', () => {
  const xml = readFeed('blog/rss.xml');
  assert.equal((xml.match(/<channel>/g) ?? []).length, 1, 'RSS channel count');
  assert.equal((xml.match(/<item>/g) ?? []).length, expectedCount, 'RSS item count');
  assert.equal(tagValues(xml, 'title').slice(1).length, expectedCount, 'RSS item titles');
  assert.equal(tagValues(xml, 'pubDate').length, expectedCount, 'RSS item dates');

  for (const link of tagValues(xml, 'link').slice(1)) {
    assert.ok(new URL(link).href.startsWith(expectedPrefix), `bad RSS item link: ${link}`);
  }
  for (const date of tagValues(xml, 'pubDate')) {
    assert.ok(!Number.isNaN(new Date(date).valueOf()), `bad RSS date: ${date}`);
  }
});

test('Atom contains one feed and every post', () => {
  const xml = readFeed('blog/atom.xml');
  assert.equal((xml.match(/<feed(?:\s|>)/g) ?? []).length, 1, 'Atom feed count');
  assert.equal((xml.match(/<entry>/g) ?? []).length, expectedCount, 'Atom entry count');
  assert.equal(
    tagValues(xml, 'entry').filter((entry) => /<title(?:\s|>)/.test(entry)).length,
    expectedCount,
    'Atom entry titles',
  );

  const entries = tagValues(xml, 'entry');
  for (const entry of entries) {
    const href = entry.match(/<link\s[^>]*href=["']([^"']+)["']/)?.[1];
    assert.ok(href, 'Atom entry link missing');
    assert.ok(new URL(href).href.startsWith(expectedPrefix), `bad Atom entry link: ${href}`);
    const date = tagValues(entry, 'updated')[0] ?? tagValues(entry, 'published')[0];
    assert.ok(date && !Number.isNaN(new Date(date).valueOf()), `bad Atom date: ${date}`);
  }
});

test('JSON feed is valid and complete', () => {
  const feed = JSON.parse(readFeed('blog/feed.json')) as {
    version?: string;
    items?: Array<{ url?: string; title?: string; date_modified?: string }>;
  };
  assert.match(feed.version ?? '', /^https:\/\/jsonfeed\.org\/version\//);
  assert.equal(feed.items?.length, expectedCount, 'JSON feed item count');

  for (const item of feed.items ?? []) {
    assert.ok(item.title, 'JSON feed item title missing');
    assert.ok(
      item.url && new URL(item.url).href.startsWith(expectedPrefix),
      `bad JSON feed URL: ${item.url}`,
    );
    assert.ok(
      item.date_modified && !Number.isNaN(new Date(item.date_modified).valueOf()),
      `bad JSON feed date: ${item.date_modified}`,
    );
  }
});

test('feeds stay outside sitemap', () => {
  const sitemap = readSitemap();
  for (const file of FEED_FILES) assert.doesNotMatch(sitemap, new RegExp(file.replace('.', '\\.')));
});

test('every blog page advertises RSS feed', () => {
  for (const route of expectedBlogRoutes()) {
    const html = readPage(route);
    assert.match(
      html,
      /<link\s[^>]*rel=["']?alternate["']?[^>]*type=["']?application\/rss\+xml["']?[^>]*href=["']?\/DeckBridge\/blog\/rss\.xml/,
      `${route} has no RSS alternate link`,
    );
  }
});
