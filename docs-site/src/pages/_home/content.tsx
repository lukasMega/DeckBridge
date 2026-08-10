import type { ReactNode } from 'react';

export const GITHUB_URL = 'https://github.com/lukasMega/DeckBridge';

export const BRANDS: ReactNode[] = [
  'Elgato',
  <span style={{ fontStretch: 'condensed' }}>Mirabox</span>,
  'Ajazz',
];

export const DEVICES: { name: string; tested: boolean }[] = [
  { name: 'Mirabox 293V3', tested: true },
  { name: 'Mirabox 293S', tested: true },
  { name: 'Mirabox K1 Pro', tested: true },
  { name: 'Ajazz AKP153E (rev. 2)', tested: false },
  { name: 'Ajazz AKP153R (rev. 2)', tested: false },
  { name: 'Ajazz AKP153', tested: false },
  { name: 'Ajazz AKP153E (rev. 1)', tested: false },
  { name: 'Ajazz AKP153R (rev. 1)', tested: false },
  { name: 'Mars Gaming MSD-ONE', tested: false },
  { name: 'Mad Dog GK150K', tested: false },
  { name: 'Risemode Vision 01', tested: false },
  { name: 'TMICE Stream Controller', tested: false },
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
