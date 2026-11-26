#!/usr/bin/env node
// Public VirusTotal uploads. Requires VT_API_KEY; never stores its value.
// Usage: node scan.mjs [platform=dir ...]; no args scans ./artifacts/ for this host.
import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED = {
  'windows-x64': ['hello-c.exe', 'hello-native.dll', 'hello-tauri-setup.exe', 'hello-tauri.exe', 'hello-tray.exe', 'hello-txiki-library.exe', 'hello-txiki.exe', 'tjs.exe'],
  'macos-arm64': ['hello-c', 'hello-tauri', 'hello-tauri.dmg', 'hello-txiki', 'hello-txiki-library', 'libhello-native.dylib', 'tjs'],
};
// Counted from each file's submission. 15 files share one 16 s limiter, so each is polled
// only every few minutes; 8 min timed out on a slow VirusTotal queue (v0.26.4 release).
const SCAN_DEADLINE_MS = 20 * 60_000;

const apiKey = process.env.VT_API_KEY;
if (!apiKey) throw new Error('Set VT_API_KEY before scanning');

const args = process.argv.slice(2);
const targets = args.length
  ? args.map((arg) => {
    const [platform, dir] = arg.split('=');
    if (!EXPECTED[platform] || !dir) throw new Error(`Expected platform=dir, got ${arg}`);
    return { platform, dir: resolve(dir) };
  })
  : [{
    platform: process.platform === 'win32' ? 'windows-x64' : 'macos-arm64',
    dir: fileURLToPath(new URL('./artifacts/', import.meta.url)),
  }];
if (new Set(targets.map((target) => target.platform)).size !== targets.length) {
  throw new Error('Each platform may appear once');
}

const jobs = [];
for (const { platform, dir } of targets) {
  const names = (await readdir(dir)).filter((name) =>
    /^(hello-|libhello-|tjs(?:\.exe)?$)/.test(name) && !/\.(obj|lib|exp|js)$/.test(name)).sort();
  const expected = [...EXPECTED[platform]].sort();
  if (names.join(',') !== expected.join(',')) {
    throw new Error(`${platform}: expected ${expected.join(', ')}; found ${names.join(', ')}`);
  }
  for (const name of names) jobs.push({ platform, name, path: join(dir, name) });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastRequest = 0;

// Single limiter for every request: one API key covers both platforms.
async function request(url, options = {}) {
  const gap = 16_000 - (Date.now() - lastRequest);
  if (gap > 0) await pause(gap);
  lastRequest = Date.now();
  const response = await fetch(url, {
    ...options,
    headers: { 'x-apikey': apiKey, ...options.headers },
  });
  if (!response.ok) {
    throw Object.assign(new Error(`${response.status} ${url}: ${await response.text()}`), {
      status: response.status,
    });
  }
  return response.json();
}

// A re-run job re-uploads the same bytes; VirusTotal answers 409 while the first upload is
// still being analysed, so read the file report by hash instead.
async function fileReport(sha) {
  try {
    const attrs = (await request(`https://www.virustotal.com/api/v3/files/${sha}`)).data.attributes;
    return attrs.last_analysis_date
      ? { stats: attrs.last_analysis_stats, results: attrs.last_analysis_results }
      : undefined;
  } catch (error) {
    if (error.status === 404) return undefined;
    throw error;
  }
}

// Submit everything first so VirusTotal analyses run while we wait on the limiter.
for (const job of jobs) {
  const bytes = await readFile(job.path);
  job.sha256 = createHash('sha256').update(bytes).digest('hex');
  const form = new FormData();
  form.set('file', new Blob([bytes]), basename(job.name));
  job.submittedAt = Date.now();
  try {
    const upload = await request('https://www.virustotal.com/api/v3/files', {
      method: 'POST', body: form,
    });
    job.analysisId = upload.data.id;
    console.log(`submitted ${job.platform}/${job.name} ${job.sha256}`);
  } catch (error) {
    if (error.status !== 409) throw error;
    console.log(`already submitted ${job.platform}/${job.name} ${job.sha256}`);
  }
}

const pending = [...jobs];
while (pending.length) {
  const job = pending.shift();
  if (job.analysisId) {
    const analysis = await request(`https://www.virustotal.com/api/v3/analyses/${job.analysisId}`);
    if (analysis.data.attributes.status === 'completed') job.attrs = analysis.data.attributes;
  } else {
    job.attrs = await fileReport(job.sha256);
  }
  if (job.attrs) continue;
  if (Date.now() - job.submittedAt > SCAN_DEADLINE_MS) {
    // Same bytes as an earlier release (tjs, unchanged samples): its last report is still valid.
    job.attrs = await fileReport(job.sha256);
    if (job.attrs) continue;
    throw new Error(`Scan timeout: ${job.platform}/${job.name}`);
  }
  pending.push(job);
}

for (const { platform } of targets) {
  const rows = [];
  const results = [];
  for (const { name, sha256: sha, attrs } of jobs.filter((job) => job.platform === platform)) {
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
    console.log(`${platform}/${name}: ${positive}/${scanned} ${sha}`);
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
  await writeFile(new URL(`./results-${platform}.md`, import.meta.url), output);
  await writeFile(new URL(`./results-${platform}.json`, import.meta.url), JSON.stringify({
    platform,
    scannedAt: new Date().toISOString(),
    results,
  }, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, output);
}
