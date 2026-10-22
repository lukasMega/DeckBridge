#!/usr/bin/env node
// Fail (exit 1) when a minified bundle or the shipped CSS outgrows its budget.
// Raw bytes on purpose: ci-checks must not need the native build or `compile`.
// Usage: node scripts/check-size.mjs [--verbose]
import { measure } from './size-report.mjs';

// Measured after P8d (2026-10-09) + 1 %. Ratcheted down at the end of each phase of
// .claude/plans/2026-10-08_release-size-webui-css.md. ui.js and the ui CSS are the shipped,
// class-mangled form (the size report's default).
const BUDGETS = {
  // Device verify wizard (2026-10-22): D13 optimization pass missed the +12 KB cap by
  // 839 B, plus option pictures (user request, +~1 KB); measured + 1%.
  'ui.js': 182_006,
  'deck.js': 30_106,
  // Device verify wizard (2026-10-22); measured + 1%.
  'css total': 37_394,
  // 12 AKP05-family clone models (2026-10-14); measured size + 1% headroom.
  'hid-worker': 48_306,
  // upHere 293V3 model (2026-10-22): the registry grows the scan worker; measured + 1%.
  'hid-scan-worker': 11_195,
  'plugin-worker': 2_733,
  // Extension worker: worker-side reply cap (2026-10-11); measured size + 1% headroom.
  'extension-worker': 1_206,
};

const m = await measure();
const actual = {
  'ui.js': m.bundles['ui.js'].raw,
  'deck.js': m.bundles['deck.js'].raw,
  'css total': m.css.raw,
  'hid-worker': m.bundles['hid-worker'].raw,
  'hid-scan-worker': m.bundles['hid-scan-worker'].raw,
  'plugin-worker': m.bundles['plugin-worker'].raw,
  'extension-worker': m.bundles['extension-worker'].raw,
};

const rows = Object.entries(BUDGETS).map(([name, budget]) => ({
  name,
  budget,
  size: actual[name],
  over: actual[name] - budget,
}));
const failed = rows.filter((r) => r.over > 0);

if (failed.length > 0 || process.argv.includes('--verbose')) {
  const out = failed.length > 0 ? console.error : console.log;
  out(
    failed.length > 0
      ? 'Over size budget (minified raw bytes):'
      : 'Size budgets (minified raw bytes):',
  );
  for (const r of rows) {
    const note = r.over > 0 ? `OVER by ${r.over}` : `${-r.over} spare`;
    out(
      `  ${r.name.padEnd(16)}${String(r.size).padStart(9)} / ${String(r.budget).padStart(9)}  ${note}`,
    );
  }
}
if (failed.length > 0) process.exit(1);
