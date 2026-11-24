#!/usr/bin/env node
// Fail (exit 1) when a minified bundle or the shipped CSS outgrows its budget.
// Raw bytes on purpose: ci-checks must not need the native build or `compile`.
// Usage: node scripts/check-size.mjs [--verbose]
import { measure } from './size-report.mjs';

// Measured after P8d (2026-10-09) + 1 %. Ratcheted down at the end of each phase of
// .claude/plans/2026-10-08_release-size-webui-css.md. ui.js and the ui CSS are the shipped,
// class-mangled form (the size report's default).
const BUDGETS = {
  // Device verify hardware report + Elgato identity tuning (2026-11-09),
  // WSL relay card for Stream Deck app 7.6.1 (2026-11-12); measured + 1%.
  // "Fix pairing" wizard for 7.6.1 + manual OrbStack route (2026-11-12): measured 202,410 + ~1 KB.
  // D200 info window card (2026-11-18, plan 2026-11-18_ulanzi-d200-wide-key.md Q6): measured
  // 206,749 + 1%. Info window Elgato images (2026-11-19): measured 209,280 + 1%.
  // Relay details in Settings pairing row (2026-11-20): measured 213,796 + 1%.
  // Apple container route + Logs chip (2026-11-22): measured 215,983, +17 B.
  // One-click upgrade banner + Install button (2026-11-24): measured 217,110 + 1%.
  'ui.js': 219_300,
  'deck.js': 30_106,
  // Device verify wizard (2026-10-22); D200 info window card (2026-11-18): measured 37,448 + 1%.
  'css total': 37_830,
  // 12 AKP05-family clone models (2026-10-14), K1 Pro 0x5548 clone (2026-11-06),
  // Ulanzi D200 page-protocol driver (2026-11-13), adaptive palette + ZIP digest cache
  // (2026-11-16), D200 firmware version via GET_DEVICE_INFO (2026-11-16): measured 61,793 + ~60 B.
  // D200 info window, live small-window mode + stats (2026-11-18): measured 63,995 + 1%.
  // Info window Elgato images, worker composite (2026-11-19): measured 65,284 + 1%.
  // Stale-icon badge corner + stale flag through the worker (2026-11-22): measured 68,639 + 1%.
  // Mirabox 293 gen 1 model (2026-11-23): measured 69,508 + 1%.
  'hid-worker': 70_203,
  // upHere 293V3 (2026-10-22), K1 Pro 0x5548 clone (2026-11-06), Ulanzi D200 (2026-11-13):
  // the registry grows the scan worker; measured + 1%. D200 info window model data
  // (2026-11-18): measured 12,272 + 1%.
  // Mirabox 293 gen 1 model (2026-11-23): measured 12,609 + 1%.
  'hid-scan-worker': 12_735,
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
