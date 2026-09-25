import { connectWS } from './ui-ws.js';
import { mountSimple } from './simple-mount.js';
import { mountAdvanced } from './advanced-mount.js';
import { hydrate, type InitialState } from './hydrate.js';

// Simple-only build: never reach the advanced view. Clear any persisted 'advanced'
// mode BEFORE the state fetch — ui.html's pre-paint script re-applies
// data-mode="advanced" from localStorage, and ui-base.css hides #simple-view while
// that attribute is set, so an upgrading user would stare at a blank page for the
// whole round-trip (forever, if /api/state never resolves).
if (__SIMPLE_ONLY__) {
  document.documentElement.removeAttribute('data-mode');
  localStorage.removeItem('deckbridge.mode');
}

void fetch('/api/state')
  .then((r) => r.json() as Promise<InitialState>)
  .then((st) => {
    hydrate(st);

    mountSimple();
    // __SIMPLE_ONLY__ folds to a constant; esbuild DCEs this branch and tree-shakes
    // mountAdvanced → AdvancedApp out of the bundle — which is the default build
    // (only `node build.mjs --advanced` keeps the advanced view).
    if (!__SIMPLE_ONLY__) mountAdvanced();
    connectWS();
    return undefined;
  });
