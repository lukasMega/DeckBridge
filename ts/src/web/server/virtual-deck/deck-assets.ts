// Static files of the browser deck page, embedded at build time (see assets.ts for the
// pattern). deck.js is the stub the clientBundleAsText plugin replaces with the bundle.
import deckHtml from '../../client/deck/deck.html';
import deckCss from '../../client/deck/deck.css';
import deckJs from '../../client/deck/deck.js';
import { DECK_ICON_180_PNG_BASE64, DECK_ICON_512_PNG_BASE64 } from '../../../assets/deck-icons.js';

const toBytes = (base64: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(base64, 'base64'));

let icons: { 180: Uint8Array<ArrayBuffer>; 512: Uint8Array<ArrayBuffer> } | undefined;

export const deckAssets = {
  html: deckHtml,
  css: deckCss,
  js: deckJs,
  /** Decoded on first use: most processes never serve the deck. */
  icon(size: 180 | 512): Uint8Array<ArrayBuffer> {
    icons ??= { 180: toBytes(DECK_ICON_180_PNG_BASE64), 512: toBytes(DECK_ICON_512_PNG_BASE64) };
    return icons[size];
  },
};

/** Standalone display needs a secure context to install on Android, so over plain HTTP this
 *  mostly serves iOS-style "Add to Home Screen"; it is still correct for when it applies. */
export function deckManifest(): string {
  return JSON.stringify({
    name: 'DeckBridge deck',
    short_name: 'Deck',
    start_url: '/deck/',
    scope: '/deck/',
    display: 'standalone',
    orientation: 'landscape',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      { src: '/deck/icon-180.png', sizes: '180x180', type: 'image/png' },
      { src: '/deck/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
}
