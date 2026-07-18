#!/usr/bin/env node
// Portable replacement for `if [ "${TJS_FROM_SOURCE:-0}" = "1" ]; then ...; fi`
// (mise.toml [tasks.tjs-setup]) — cmd /c (the default Windows task shell) has no
// POSIX conditional syntax, and this task is on the Windows compile chain
// (compile -> build -> tjs-setup).
import { execFileSync } from 'node:child_process';

const script = process.env.TJS_FROM_SOURCE === '1' ? 'tjs-build.mjs' : 'tjs-download.mjs';
execFileSync('node', [`scripts/${script}`], { stdio: 'inherit' });
