#!/usr/bin/env node
// Portable replacement for the old `if [ ... ]; then ...; fi` sh task body
// (mise.toml [tasks.deckbridge-native]) — the default Windows task shell is
// cmd /c, which has no POSIX conditional syntax. Run with cwd already set to
// rust/deckbridge-native (mise task `dir`).
import { execFileSync } from 'node:child_process';

const args = ['build', '--release'];
if (process.env.JPEG_FORK === '1') {
  args.push('--no-default-features', '--features', 'jpeg-fork,usb');
}
execFileSync('cargo', args, { stdio: 'inherit' });
