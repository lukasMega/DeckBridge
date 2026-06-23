import type { ReactNode } from 'react';

export const GITHUB_URL = 'https://github.com/lukasMega/deckbridge';

export const BRANDS: ReactNode[] = [
  'Elgato',
  <span style={{ fontStretch: 'condensed' }}>Mirabox</span>,
  'Ajazz',
];

export const NETWORKS: ReactNode[] = [
  <span style={{ fontStretch: 'expanded' }}>Wi-Fi</span>,
  <span style={{ fontStretch: 'condensed' }}>network</span>,
  <span style={{ fontWeight: 'lighter', fontStretch: 'extra-condensed' }}>localhost</span>,
];

export const DEVICES = [
  'Mirabox 293V3 / Ajazz',
  'Mirabox 293S',
  'Mirabox K1 Pro',
  'Stream Deck MK.2',
  'Stream Deck Mini',
];

export const STACK: { name: string; role: ReactNode; href?: string }[] = [
  {
    name: 'TypeScript',
    role: 'All the relay logic — the CORA/Elgato TCP servers, device drivers, and local web UI.',
  },
  {
    name: 'Rust',
    role: (
      <>
        A small <code>cdylib</code>, loaded over FFI, for JPEG resize/rotate and HID enumeration.
      </>
    ),
  },
  {
    name: 'txiki.js',
    role: 'The runtime it compiles to — QuickJS-ng + libuv + libffi. No Node.js, no Bun.',
    href: 'https://github.com/saghul/txiki.js',
  },
];

export const HIGHLIGHTS = [
  'Single < 5 MB binary',
  'Dedicated USB worker thread',
  'JPEG resize + rotate per model',
  'mDNS auto-discovery',
  'Emulates an Elgato Network Dock',
];
