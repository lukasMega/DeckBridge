// Injected first into Node test bundles (build.mjs --node): tests read tjs at module load.
import { installTjsShim } from './tjs-shim.js';

installTjsShim();
