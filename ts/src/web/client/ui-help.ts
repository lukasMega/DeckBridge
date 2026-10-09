import type { DocsTopic } from '../contract.js';

export interface HelpStep {
  you: boolean;
  html: string;
}

export type HelpDocsLink = { label: string; topic: DocsTopic } | { label: string; href: string };

export interface HelpTopic {
  title: string;
  lead: string;
  svg: () => string;
  steps: HelpStep[];
  docs?: HelpDocsLink[];
}

export const CORA_PORT = '5343';
export const CORA_ADDR = `127.0.0.1:${CORA_PORT}`;

// Help illustrations go through innerHTML, so no xmlns; children inherit the root fill="none".
function svgPlugIn(): string {
  let keys = '';
  const cols = [168, 192, 216, 240, 264];
  const rows = [34, 62, 90];
  rows.forEach((y) =>
    cols.forEach((x, ci) => {
      keys += `<rect class="litkey" x="${x}" y="${y}" width="18" height="18" rx="4" style="animation-delay:${ci * 80}ms"/>`;
    }),
  );
  return (
    '<svg class="hsvg" viewBox="0 0 320 130" fill="none">' +
    '<rect x="150" y="18" width="150" height="96" rx="14" fill="var(--surface-2)" stroke="var(--border-strong)" stroke-width="2"/>' +
    `<g fill="var(--inset)">${keys}</g>` +
    '<rect x="142" y="56" width="10" height="20" rx="3" fill="var(--inset)" stroke="var(--border-strong)" stroke-width="1.5"/>' +
    '<g class="plug">' +
    '<path d="M8 66H132" stroke="var(--fg-dim)" stroke-width="5" stroke-linecap="round"/>' +
    '<rect x="118" y="58" width="26" height="16" rx="3" fill="var(--fg-muted)"/>' +
    '<rect x="138" y="61" width="8" height="10" rx="2" fill="var(--border-strong)"/>' +
    '</g>' +
    '</svg>'
  );
}

function svgOpenApp(): string {
  return (
    '<svg class="hsvg" viewBox="0 0 320 150" fill="none">' +
    '<g class="windowin">' +
    '<rect x="66" y="12" width="188" height="92" rx="11" fill="var(--surface)" stroke="var(--border-strong)" stroke-width="2"/>' +
    '<path d="M66 30H254" stroke="var(--border)" stroke-width="1.5"/>' +
    '<circle cx="80" cy="21" r="3" fill="var(--warn)"/><circle cx="92" cy="21" r="3" fill="var(--wait)"/><circle cx="104" cy="21" r="3" fill="var(--ok)"/>' +
    '<rect x="80" y="40" width="70" height="7" rx="3.5" fill="var(--inset)"/>' +
    '<g class="rowin">' +
    '<rect x="80" y="58" width="160" height="34" rx="8" fill="var(--accent-soft)" stroke="var(--accent)" stroke-width="1.5"/>' +
    '<rect x="90" y="66" width="18" height="18" rx="4" fill="var(--accent)"/>' +
    '<rect x="118" y="69" width="74" height="6" rx="3" fill="var(--fg-muted)"/>' +
    '<rect x="118" y="80" width="46" height="5" rx="2.5" fill="var(--fg-dim)"/>' +
    '<path d="M214 75l4 4 7-8" stroke="var(--ok)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</g>' +
    '</g>' +
    '<rect x="104" y="126" width="112" height="20" rx="10" fill="var(--inset)" stroke="var(--border)" stroke-width="1.5"/>' +
    '<rect class="bounce" x="150" y="114" width="22" height="22" rx="6" fill="var(--accent)"/>' +
    '</svg>'
  );
}

function svgNetwork(): string {
  // The three lit tiles run along the diagonal.
  let grid = '';
  for (let i = 0; i < 12; i++) {
    const fill = [1, 6, 11].includes(i) ? 'accent-soft' : 'inset';
    grid += `<rect x="${64 + (i % 4) * 32}" y="${60 + Math.floor(i / 4) * 32}" width="24" height="24" rx="5" fill="var(--${fill})"/>`;
  }
  return (
    '<svg class="hsvg" viewBox="0 0 320 162" fill="none">' +
    '<rect x="8" y="8" width="304" height="146" rx="12" fill="var(--surface)" stroke="var(--border-strong)" stroke-width="2"/>' +
    '<circle cx="20" cy="21" r="3" fill="var(--warn)"/><circle cx="32" cy="21" r="3" fill="var(--wait)"/><circle cx="44" cy="21" r="3" fill="var(--ok)"/>' +
    '<path d="M8 34H312" stroke="var(--border)" stroke-width="1.5"/>' +
    '<rect x="22" y="42" width="68" height="9" rx="4" fill="var(--fg-muted)"/>' +
    '<path d="M97 45l4 4 4-4" stroke="var(--fg-dim)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<rect x="118" y="39" width="46" height="15" rx="7.5" stroke="var(--border-strong)" stroke-width="1.4"/>' +
    '<rect x="126" y="45" width="22" height="4" rx="2" fill="var(--fg-dim)"/>' +
    grid +
    '<g class="menuin">' +
    '<rect x="20" y="58" width="148" height="92" rx="9" fill="var(--surface-2)" stroke="var(--border-strong)" stroke-width="1.5"/>' +
    '<rect x="32" y="70" width="42" height="8" rx="3" fill="var(--fg-dim)"/>' +
    '<rect x="32" y="85" width="74" height="8" rx="3" fill="var(--fg)"/>' +
    '<rect x="32" y="100" width="80" height="8" rx="3" fill="var(--fg-muted)"/>' +
    '<path d="M24 115H164" stroke="var(--border)" stroke-width="1.2"/>' +
    '<rect class="hilite" x="22" y="124" width="144" height="14" rx="4" fill="var(--accent)"/>' +
    '<text x="94" y="135" text-anchor="middle" font-size="12" fill="#fff" font-family="system-ui,sans-serif" font-weight="500">Add Network Device…</text>' +
    '</g>' +
    '<circle class="clickring" cx="46" cy="131" r="10" stroke="var(--accent)" stroke-width="2"/>' +
    '<g class="cursor">' +
    '<path d="M0 0l14 5.4-5.6 1.7L7.9 13z" fill="var(--fg)" stroke="var(--surface)" stroke-width="1.3" stroke-linejoin="round"/>' +
    '</g>' +
    '</svg>'
  );
}

export const HELP: Record<string, HelpTopic> = {
  'plug-in': {
    title: 'Plug in your Stream Deck',
    lead: 'DeckBridge first needs to see your deck over USB.',
    svg: svgPlugIn,
    steps: [
      { you: true, html: 'Connect the Stream Deck to your computer with its <b>USB cable</b>.' },
      {
        you: true,
        html: 'Use a <b>data USB port</b> directly on the computer — avoid unpowered hubs.',
      },
      {
        you: false,
        html: 'DeckBridge detects the device and lights up its keys. This step turns green automatically.',
      },
    ],
    docs: [{ topic: 'devices', label: 'Supported devices' }],
  },
  'open-app': {
    title: 'Open the Elgato Stream Deck app',
    lead: 'The Elgato app connects to your deck through DeckBridge.',
    svg: svgOpenApp,
    steps: [
      { you: true, html: 'Launch the <b>Elgato Stream Deck</b> app on this computer.' },
      {
        you: false,
        html: "Your deck shows up in the app's device list within a few seconds and is marked connected.",
      },
    ],
    docs: [{ topic: 'getting-started', label: 'Getting started guide' }],
  },
  'network-device': {
    title: 'Add it as a network device',
    lead: 'Deck not listed? Add it by address.',
    svg: svgNetwork,
    steps: [
      {
        you: true,
        html: 'In the Stream Deck app, open the <b>device dropdown</b> in the top-left corner and choose <b>Add Network Device…</b>',
      },
      {
        you: true,
        html: `Enter the address <b>${CORA_ADDR}</b> (copy it from the card on the previous screen).`,
      },
      { you: false, html: 'The app connects over the network and your keys come to life.' },
      {
        you: true,
        html: 'More decks? Add each one with the port from its card. The Elgato app remembers them.',
      },
    ],
    docs: [
      { topic: 'pairing', label: 'DeckBridge pairing guide' },
      {
        href: 'https://www.elgato.com/us/en/explorer/products/stream-deck/how-to-set-up-stream-deck-network-dock#p-data-block-keysud1bbstream-deck-software-setupbp',
        label: "Elgato's setup guide",
      },
    ],
  },
};
