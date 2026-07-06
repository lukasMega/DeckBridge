import type { ReactNode } from 'react';

export const GITHUB_URL = 'https://github.com/lukasMega/DeckBridge';

export const BRANDS: ReactNode[] = [
  'Elgato',
  <span style={{ fontStretch: 'condensed' }}>Mirabox</span>,
  'Ajazz',
];

export const DEVICES: { name: string; tested: boolean }[] = [
  { name: 'Mirabox 293V3 / Ajazz', tested: true },
  { name: 'Mirabox 293S', tested: true },
  { name: 'Mirabox K1 Pro', tested: true },
  { name: 'Stream Deck MK.2', tested: false },
  { name: 'Stream Deck Mini', tested: true },
];

export const HIGHLIGHTS = [
  'TypeScript + Rust',
  'txiki.js runtime — no Node.js',
  'Dedicated USB worker thread',
  'JPEG resize + rotate per model',
  'mDNS auto-discovery',
  'Emulates an Elgato Network Dock',
];
