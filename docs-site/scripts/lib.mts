// Shared helpers for the docs-site test scripts.
//
// TypeScript, run directly by `node --test` via native type stripping (Node 22.18+
// / 24). Erasable syntax only — no enums, no namespaces, no parameter properties.
// Node built-ins only: no test framework, no HTML parser, no new deps.
//
// Two facts about the build output drive almost everything here:
//   G1  the HTML is minified and attribute values are usually UNQUOTED
//       (href=/DeckBridge/features), so a `href="..."` regex matches nothing.
//   G2  internal links carry the baseUrl prefix and are extensionless
//       (/DeckBridge/features -> build/features/index.html).
// See .claude/plans/docs-site-test-plan.md for the full write-up.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

export const SITE_DIR = resolve(SCRIPTS_DIR, '..');
export const BUILD_DIR = join(SITE_DIR, 'build');

/** baseUrl as configured in docusaurus.config.ts. Verified against the sitemap. */
export const EXPECTED_BASE_URL = '/DeckBridge/';

/** Doc routes, in sidebars.ts order (tutorialSidebar then technicalSidebar). */
export const DOC_ROUTES: readonly string[] = [
  // Standalone page (docs/ARCHITECTURE.md), not in either sidebar.
  'ARCHITECTURE',
  'introduction',
  'getting-started',
  'features',
  'headless-linux',
  'privacy',
  'adding-a-device',
  'side-keys',
  'plugin-widgets',
  'hidapi-ffi',
  'image-flow',
  'references',
];

/** Every route the sitemap should contain: the docs, the landing page, search. */
export const EXPECTED_ROUTES: readonly string[] = ['', 'search', ...DOC_ROUTES];

/** Where an in-site link points, once the baseUrl and route shape are resolved. */
export interface ResolvedHref {
  /** The link is internal but missing the baseUrl prefix — it 404s once deployed. */
  bad: boolean;
  href: string;
  /** Absolute path to the file that must exist, or null when `bad`. */
  file: string | null;
}

/**
 * Fail early and actionably when the build output is missing, rather than
 * letting every assertion blow up with a bare ENOENT.
 */
export function requireBuild(): void {
  if (!existsSync(join(BUILD_DIR, 'index.html'))) {
    throw new Error(
      `build output missing at ${BUILD_DIR} — run 'npm run test:build' (or 'npm run build') first`,
    );
  }
}

/**
 * All values of an attribute in an HTML string, tolerating unquoted values (G1).
 * The lookbehind stops `href` matching inside e.g. `data-href`.
 */
export function extractAttrs(html: string, attr = 'href'): string[] {
  const re = new RegExp(`(?<![\\w-])${attr}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'g');
  return [...html.matchAll(re)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

/** True for links that point off-site and are therefore not our problem. */
export function isExternal(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);
}

/**
 * Map an in-site href to the file on disk that must exist (G2).
 *
 * Returns null for links we do not resolve (external, anchor-only, empty).
 */
export function resolveHref(
  href: string,
  buildDir: string = BUILD_DIR,
  baseUrl: string = EXPECTED_BASE_URL,
): ResolvedHref | null {
  if (!href || isExternal(href) || href.startsWith('#')) return null;

  const [pathPart] = href.split('#');
  if (!pathPart) return null;

  if (!pathPart.startsWith(baseUrl)) return { bad: true, href, file: null };

  const rel = pathPart.slice(baseUrl.length).replace(/\/$/, '');
  if (rel === '') return { bad: false, href, file: join(buildDir, 'index.html') };

  return {
    bad: false,
    href,
    file: extname(rel) ? join(buildDir, rel) : join(buildDir, rel, 'index.html'),
  };
}

/** Raw sitemap.xml text. */
export function readSitemap(): string {
  return readFileSync(join(BUILD_DIR, 'sitemap.xml'), 'utf8');
}

/** Absolute URLs listed in sitemap.xml. */
export function sitemapUrls(): string[] {
  return [...readSitemap().matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1] as string);
}

/**
 * baseUrl as it actually appears in the built sitemap. Compared against
 * EXPECTED_BASE_URL so a config change fails loudly instead of silently
 * making every link check a no-op.
 */
export function baseUrlFromSitemap(): string {
  const [first] = sitemapUrls();
  if (!first) throw new Error('sitemap.xml has no <loc> entries');
  const { pathname } = new URL(first);
  const seg = pathname.split('/').filter(Boolean)[0];
  return seg ? `/${seg}/` : '/';
}

/** Route names ('' for the landing page) derived from the sitemap. */
export function allRoutes(baseUrl: string = EXPECTED_BASE_URL): string[] {
  return sitemapUrls().map((u) => new URL(u).pathname.slice(baseUrl.length).replace(/\/$/, ''));
}

/** The built HTML file for a route ('' = landing page). */
export function pageFile(route: string): string {
  return route === '' ? join(BUILD_DIR, 'index.html') : join(BUILD_DIR, route, 'index.html');
}

/** Read a route's built HTML. */
export function readPage(route: string): string {
  return readFileSync(pageFile(route), 'utf8');
}

/** An inline <script> block: its attribute text and its body. */
interface ScriptBlock {
  attrs: string;
  body: string;
}

/** Every inline <script> block (those without a src attribute). */
function scriptBlocks(html: string): ScriptBlock[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .map((m) => ({ attrs: m[1] as string, body: m[2] as string }))
    .filter(({ body }) => body.trim() !== '');
}

/**
 * Bodies of inline <script> blocks that actually contain JavaScript.
 * Excludes data blocks such as application/ld+json, which are not JS and must
 * not be fed to a JS parser.
 */
export function inlineScripts(html: string): string[] {
  return scriptBlocks(html)
    .filter(
      ({ attrs }) =>
        !/\btype=/.test(attrs) ||
        /\btype="?(?:text\/javascript|module|application\/javascript)/.test(attrs),
    )
    .map(({ body }) => body);
}

/** Bodies of inline JSON-LD (structured data) blocks. */
export function jsonLdBlocks(html: string): string[] {
  return scriptBlocks(html)
    .filter(({ attrs }) => /\btype="?application\/ld\+json/.test(attrs))
    .map(({ body }) => body);
}
