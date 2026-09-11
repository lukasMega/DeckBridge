import type { ReactNode } from 'react';

import deviceData from '@site/src/data/devices.generated.json';

export const GITHUB_URL = 'https://github.com/lukasMega/DeckBridge';

export const BRANDS: ReactNode[] = [
  'Elgato',
  <span style={{ fontStretch: 'condensed' }}>Mirabox</span>,
  'Ajazz',
  'Fifine',
];

/** Tested decks first, then untested — generated from DEVICE_MODELS by
 *  ts/scripts/gen-device-docs.mjs. Run `mise run docs-devices` after adding a device. */
export const DEVICES: { name: string; tested: boolean }[] = deviceData.homepageOrder;

export const HIGHLIGHTS = [
  'TypeScript + Rust',
  'txiki.js runtime — no Node.js',
  'Dedicated USB worker thread',
  'JPEG resize + rotate per model',
  'mDNS auto-discovery',
  'Emulates an Elgato Network Dock',
];
