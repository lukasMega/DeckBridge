#!/usr/bin/env node
// Portable replacement for `run = "$TJS compile ts/dist/bundle.js deckbridge"`
// (mise.toml [tasks.compile]) — cmd /c (the default Windows task shell) does
// not expand $VAR syntax, so the bare $TJS reference fails there.
import { execFileSync } from 'node:child_process';

const { TJS } = process.env;
if (!TJS) {
  console.error('TJS env var must be set');
  process.exit(1);
}
execFileSync(TJS, ['compile', 'ts/dist/bundle.js', 'deckbridge'], { stdio: 'inherit' });
