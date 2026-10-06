// Shared by the device generators. Lives in ts/scripts/, not repo-root scripts/: ESM resolves
// bare specifiers from the importing file's path, and repo-root scripts/ has no node_modules.
// Registry is bundled to ESM and imported (pure data); an import throwing on `tjs:ffi`
// under node would mean non-native data snuck in.

import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import * as esbuild from 'esbuild';

const DEVICES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'devices');

// imageBatchingEnabled rides along so generators report the effective value, not a copy of its rule;
// PROTOCOLS is the single protocol table (family for docs).
const ENTRY = `
export { DEVICE_MODELS, CORA_PROFILES } from './registry.ts';
export { imageBatchingEnabled } from './driver.ts';
export { validateCatalog } from './validate-model.ts';
export { PROTOCOLS } from './protocol-metadata.ts';
`;

/** @returns {Promise<{DEVICE_MODELS: any[], CORA_PROFILES: any[], imageBatchingEnabled: (m: any) => boolean, PROTOCOLS: Record<string, {family: string}>, validateCatalog: (models: any[], profiles: any[]) => string[]}>} */
export async function loadRegistry() {
  const tmp = join(tmpdir(), `deckbridge-registry-${process.pid}.mjs`);
  try {
    await esbuild.build({
      stdin: { contents: ENTRY, resolveDir: DEVICES_DIR, loader: 'ts' },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      outfile: tmp,
      logLevel: 'silent',
    });
    // .mjs matters: `await import()` of a .js outside a type:module package parses as CJS.
    const registry = await import(`file://${tmp}`);
    // Here, not at module import: every generator then fails on a broken catalog before writing.
    const errors = registry.validateCatalog(registry.DEVICE_MODELS, registry.CORA_PROFILES);
    if (errors.length > 0) {
      throw new Error('device catalog is invalid:\n' + errors.map((e) => '  - ' + e).join('\n'));
    }
    return registry;
  } finally {
    rmSync(tmp, { force: true });
  }
}
