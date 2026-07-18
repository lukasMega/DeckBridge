// Global type declarations for the txiki.js bundle environment.

declare global {
  // Buffer: hand-rolled Uint8Array-subclass shim (src/platform/buffer-shim.ts), provided at
  // runtime as a global via esbuild `inject` (ts/build.mjs `shared.inject`).
  let Buffer: typeof import('./platform/buffer-shim.js').Buffer;
  type Buffer = import('./platform/buffer-shim.js').Buffer;

  type BufferEncoding =
    | 'ascii'
    | 'utf8'
    | 'utf-8'
    | 'utf16le'
    | 'ucs2'
    | 'ucs-2'
    | 'base64'
    | 'base64url'
    | 'latin1'
    | 'binary'
    | 'hex';

  // Build timestamp injected by esbuild define.
  const __BUILD_TIME__: string;

  // Version string injected by esbuild define (ts/build.mjs, VERSION env var; default 'dev').
  const __VERSION__: string;

  // Simple-only build flag injected by esbuild define (ts/build.mjs --simple-only).
  // When true, the advanced (debug) view + its CSS are tree-shaken out of the embedded UI.
  const __SIMPLE_ONLY__: boolean;
}

export {};
