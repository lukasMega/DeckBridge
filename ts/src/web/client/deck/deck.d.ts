// Type declaration for deck.js — web/server/virtual-deck/deck-assets.ts imports it as a string.
// At build time the clientBundleAsText esbuild plugin replaces the stub deck.js with the
// legacy-target IIFE bundle produced from deck-entry.ts.
declare const content: string;
export default content;
