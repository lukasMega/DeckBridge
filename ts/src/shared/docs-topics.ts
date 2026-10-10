import type { DocsTopic } from '../web/contract.js';

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
