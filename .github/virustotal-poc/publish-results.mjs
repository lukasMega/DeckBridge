#!/usr/bin/env node
// Merge both release-gate scans into the public docs page.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [windowsPath, macPath] = process.argv.slice(2);
if (!windowsPath || !macPath) throw new Error('Pass Windows and macOS results.json paths');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const [windows, mac, pkg] = await Promise.all([
  readJson(windowsPath),
  readJson(macPath),
  readJson(`${root}/ts/package.json`),
]);
if (windows.platform !== 'windows-x64' || windows.results.length !== 8 ||
    mac.platform !== 'macos-arm64' || mac.results.length !== 7) {
  throw new Error('Incomplete or mismatched PoC scan results');
}

const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('`', '\\`')
  .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\r\n]+/g, ' ');
const table = (data) => data.results.map((item) => {
  if (!/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isInteger(item.positive) ||
      !Number.isInteger(item.scanned) || item.scanned < 1 || item.positive < 0 ||
      item.positive > item.scanned) {
    throw new Error(`Invalid scan result: ${item.name}`);
  }
  return `| ${cell(item.name)} | \`${item.sha256}\` | ${item.positive}/${item.scanned} | ${cell(item.vendors)} | [report](https://www.virustotal.com/gui/file/${item.sha256}) |`;
}).join('\n');

const content = `---
sidebar_label: VirusTotal comparison
title: VirusTotal PoC comparison
slug: /virustotal
description: Isolated scanner results before DeckBridge release ${pkg.version}.
---

# VirusTotal PoC comparison

Release candidate: \`deckbridge-v${pkg.version}\`.
These isolated samples were scanned before release.
They are not DeckBridge release downloads.
Detection scores can change over time.
Samples uploaded to VirusTotal are public.

## Windows x64

Scanned: ${cell(windows.scannedAt)}.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
${table(windows)}

## macOS arm64

Scanned: ${cell(mac.scannedAt)}.

| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |
| --- | --- | --- | --- | --- |
${table(mac)}

See [PoC source](https://github.com/lukasMega/DeckBridge/tree/main/.github/virustotal-poc).
See [0.17.0 release investigation](./virustotal-v0.17.0.md).
Few detections alone cannot establish safety or malware.
`;
await writeFile(`${root}/docs/virustotal.md`, content);
