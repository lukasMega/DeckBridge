import type { DocsTopic } from '../contract.js';
import { suppressReason } from '../../infra/daily-ping-env.js';
import type { EnvSnapshot } from '../../infra/daily-ping-env.js';

// Single owner of the docs host: an org transfer changes this line only.
export const DOCS_BASE = 'https://lukasmega.github.io/DeckBridge';

// Trailing slash skips GitHub Pages' 301 hop. Anchors are github-slugger ids of real headings.
export const DOCS_TOPICS = {
  home: '/',
  devices: '/devices/',
  'getting-started': '/getting-started/',
  pairing: '/getting-started/#4-pair-with-the-elgato-app',
  'browser-deck': '/browser-deck/',
  'qr-code': '/browser-deck/#qr-code',
  'multi-deck': '/features/#multiple-decks',
  'click-to-press': '/features/#click-to-press',
  'push-api': '/push-api/',
  'side-keys': '/side-keys/',
  'device-tuning': '/troubleshooting/#device-tuning',
  'image-fit': '/troubleshooting/#image-fit',
  troubleshooting: '/troubleshooting/#diagnostics-report',
} as const satisfies Record<DocsTopic, string>;

export function isDocsTopic(s: string): s is DocsTopic {
  return Object.hasOwn(DOCS_TOPICS, s);
}

/** Docs URL with utm_* inserted before the #anchor. */
export function docsUrl(topic: DocsTopic): string {
  const [path, anchor] = DOCS_TOPICS[topic].split('#') as [string, string?];
  const utm = `utm_source=deckbridge-app&utm_medium=webui&utm_campaign=${topic}`;
  const hash = anchor ? '#' + anchor : '';
  return `${DOCS_BASE}${path}?${utm}${hash}`;
}

/** Only document/iframe navigation from our own page counts; an <img>/prefetch from a LAN page must not. */
export function isOwnNavigation(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site');
  if (site !== null) {
    if (site !== 'same-origin' && site !== 'none') return false;
    const dest = headers.get('sec-fetch-dest');
    return dest === null || dest === 'document' || dest === 'iframe';
  }
  const referer = headers.get('referer');
  const host = headers.get('host');
  if (!referer || !host) return false;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

/** Same opt-outs as the daily ping, minus the dwell gate (irrelevant to a click). */
export function docsTrackingAllowed(a7s: boolean | undefined, env: EnvSnapshot): boolean {
  return a7s !== false && suppressReason({ env, uptimeMs: Number.MAX_SAFE_INTEGER }) === null;
}
