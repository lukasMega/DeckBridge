#!/usr/bin/env node
// Public VirusTotal uploads. Requires VT_API_KEY; never stores its value.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiKey = process.env.VT_API_KEY;
if (!apiKey) throw new Error('Set VT_API_KEY before scanning');
const dir = new URL('./artifacts/', import.meta.url);
const names = (await readdir(dir)).filter((name) =>
  /^(hello-|libhello-|tjs(?:\.exe)?$)/.test(name) && !/\.(obj|lib|exp|js)$/.test(name));
const expected = process.platform === 'win32'
  ? ['hello-c.exe', 'hello-native.dll', 'hello-tauri-setup.exe', 'hello-tauri.exe', 'hello-tray.exe', 'hello-txiki-library.exe', 'hello-txiki.exe', 'tjs.exe']
  : ['hello-c', 'hello-tauri', 'hello-tauri.dmg', 'hello-txiki', 'hello-txiki-library', 'libhello-native.dylib', 'tjs'];
if (names.sort().join(',') !== expected.sort().join(',')) {
  throw new Error(`Expected ${expected.join(', ')}; found ${names.join(', ')}`);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequest = 0;

async function request(url, options = {}) {
  const gap = 16_000 - (Date.now() - lastRequest);
  if (gap > 0) await pause(gap);
  lastRequest = Date.now();
  const response = await fetch(url, {
    ...options,
    headers: { 'x-apikey': apiKey, ...options.headers },
  });
  if (!response.ok) throw new Error(`${response.status} ${url}: ${await response.text()}`);
  return response.json();
}

const rows = [];
const results = [];
for (const name of names.sort()) {
  const path = join(fileURLToPath(dir), name);
  const bytes = await readFile(path);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const form = new FormData();
  form.set('file', new Blob([bytes]), basename(name));
  const upload = await request('https://www.virustotal.com/api/v3/files', {
    method: 'POST', body: form,
  });
  const analysisId = upload.data.id;
  let analysis;
  for (let attempt = 0; attempt < 30; attempt++) {
    analysis = await request(`https://www.virustotal.com/api/v3/analyses/${analysisId}`);
    if (analysis.data.attributes.status === 'completed') break;
  }
  if (analysis.data.attributes.status !== 'completed') throw new Error(`Scan timeout: ${name}`);
  const attrs = analysis.data.attributes;
  const stats = attrs.stats;
  const positive = (stats.malicious ?? 0) + (stats.suspicious ?? 0);
  const scanned = positive + (stats.harmless ?? 0) + (stats.undetected ?? 0);
  const vendors = Object.entries(attrs.results ?? {})
    .filter(([, result]) => ['malicious', 'suspicious'].includes(result.category))
    .map(([vendor, result]) => `${vendor}: ${result.result}`)
    .join('; ') || 'None';
  const url = `https://www.virustotal.com/gui/file/${sha}`;
  results.push({ name, sha256: sha, positive, scanned, vendors, url });
  rows.push(`| ${name} | \`${sha}\` | ${positive}/${scanned} | ${vendors.replaceAll('|', '\\|')} | [report](${url}) |`);
  console.log(`${name}: ${positive}/${scanned} ${sha}`);
}

const output = [
  '# VirusTotal comparison',
  '',
  `Scanned: ${new Date().toISOString()}`,
  '',
  '| Sample | SHA-256 | Detections | Vendor labels | VirusTotal |',
  '| --- | --- | --- | --- | --- |',
  ...rows,
  '',
  'Scores can change. Samples are public VirusTotal submissions.',
  '',
].join('\n');
const platform = process.platform === 'win32' ? 'windows-x64' : 'macos-arm64';
await writeFile(new URL(`./results-${platform}.md`, import.meta.url), output);
await writeFile(new URL(`./results-${platform}.json`, import.meta.url), JSON.stringify({
  platform,
  scannedAt: new Date().toISOString(),
  results,
}, null, 2) + '\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(process.env.GITHUB_STEP_SUMMARY, output);
}
