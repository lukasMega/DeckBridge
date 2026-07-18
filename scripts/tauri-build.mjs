#!/usr/bin/env node
// Portable replacement for the old multi-line sh task body (mise.toml
// [tasks.tauri-build]: `mkdir -p`, `cp` are not cmd.exe builtins, and this
// task's whole purpose is the Windows NSIS build, so cmd /c is exactly the
// shell it needs to work under). Stages the relay + tray sidecars under the
// MSVC target-triple names Tauri's bundler expects (G2 in CLAUDE.md), then
// runs `cargo tauri build`.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

mkdirSync('src-tauri/binaries', { recursive: true });

// `tjs compile` writes `deckbridge.exe` on Windows, `deckbridge` elsewhere.
const relay = existsSync('deckbridge.exe') ? 'deckbridge.exe' : 'deckbridge';
copyFileSync(relay, 'src-tauri/binaries/deckbridge-x86_64-pc-windows-msvc.exe');
copyFileSync(
  'rust/target/release/deckbridge-tray.exe',
  'src-tauri/binaries/deckbridge-tray-x86_64-pc-windows-msvc.exe',
);

execFileSync('cargo', ['tauri', 'build', '--manifest-path', 'src-tauri/Cargo.toml'], {
  stdio: 'inherit',
});
