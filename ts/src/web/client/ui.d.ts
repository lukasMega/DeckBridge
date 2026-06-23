// Type declaration for ui.js — server.ts imports this as a string.
// At build time the uiJsAsText esbuild plugin replaces the stub ui.js with
// the IIFE bundle produced from ui-entry.ts.
declare const content: string;
export default content;
