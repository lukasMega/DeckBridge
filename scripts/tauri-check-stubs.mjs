#!/usr/bin/env node
// Creates empty host-triple sidecar stubs so Tauri's externalBin validates
// on any OS (bash `sed`/`case` breaks on Windows pwsh).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).toString();
const triple = out.match(/host: (\S+)/)[1];
const suffix = process.platform === 'win32' ? '.exe' : '';

writeFileSync(`binaries/deckbridge-${triple}${suffix}`, '');
writeFileSync(`binaries/deckbridge-tray-${triple}${suffix}`, '');