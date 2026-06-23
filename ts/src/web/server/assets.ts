// Static browser assets embedded at build time by esbuild (text loader).
// ui.js is the stub intercepted by the uiJsAsText plugin (builds ../client/ui-entry.ts).
import uiHtml from '../client/ui.html';
import uiBaseCSS from '../client/ui-base.css';
import uiAdvancedCSS from '../client/ui-advanced.css';
import uiSimpleCSS from '../client/ui-simple.css';
import uiJs from '../client/ui.js';
import requirementsHtml from '../client/requirements.html';

export const assets = {
  html: uiHtml,
  // Simple-only build tree-shakes the advanced view's CSS out (uiAdvancedCSS import
  // becomes unused when __SIMPLE_ONLY__ folds the ternary to '').
  css: uiBaseCSS + (__SIMPLE_ONLY__ ? '' : uiAdvancedCSS) + uiSimpleCSS,
  js: uiJs,
  requirementsHtml,
};
