#!/usr/bin/env node
// ts/scripts/check-loc.mjs — fail (exit 1) if any .ts/.tsx file (under ts/) exceeds the line limit.
// Guards against files creeping past a size where they should be split.

import { lineCounts } from './loc-lib.mjs';

const LIMIT = 500;
const ROOT = new URL('..', import.meta.url).pathname;
const counts = await lineCounts(ROOT);
const offenders = counts.filter(({ lines }) => lines > LIMIT).toSorted((a, b) => b.lines - a.lines);

if (offenders.length > 0) {
  console.error(`Files over ${LIMIT} lines:`);
  offenders.forEach(({ lines, file }) => console.error(`${String(lines).padStart(6)} ${file}`));
  process.exit(1);
}
