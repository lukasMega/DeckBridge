#!/usr/bin/env node
// ts/scripts/loc.mjs — top 10 largest .ts/.tsx files (under ts/) by line count.
// Skips node_modules/dist/coverage and .d.ts.

import { lineCounts } from './loc-lib.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const counts = await lineCounts(ROOT);

counts
  .toSorted((a, b) => b.lines - a.lines)
  .slice(0, 10)
  .forEach(({ lines, file }) => console.log(`${String(lines).padStart(6)} ${file}`));
