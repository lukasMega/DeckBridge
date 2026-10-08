#!/usr/bin/env node
// Fail (exit 1) when a minified bundle or the shipped CSS outgrows its budget.
// Raw bytes on purpose: ci-checks must not need the native build or `compile`.
// Usage: node scripts/check-size.mjs [--verbose]
import { measure } from './size-report.mjs';

// Measured after P4 (2026-10-08) + 1 %. Ratcheted down at the end of each phase of
// .claude/plans/2026-10-08_release-size-webui-css.md. ui.js and the ui CSS are the shipped,
// class-mangled form (the size report's default).
const BUDGETS = {
  'ui.js': 145_116,
  'deck.js': 30_106,
  'css total': 30_921,
  'hid-worker': 50_581,
  'hid-scan-worker': 10_002,
  'plugin-worker': 2_733,
};

const m = await measure();
const actual = {
  'ui.js': m.bundles['ui.js'].raw,
  'deck.js': m.bundles['deck.js'].raw,
  'css total': m.css.raw,
  'hid-worker': m.bundles['hid-worker'].raw,
  'hid-scan-worker': m.bundles['hid-scan-worker'].raw,
  'plugin-worker': m.bundles['plugin-worker'].raw,
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
