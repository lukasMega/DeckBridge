#!/usr/bin/env node
// Scaffolds a known-family device: a model file plus a device-notes.json stub. It never
// edits registry.ts (order is a design decision) and never invents a VID/PID: it prints the
// registry lines instead and refuses ids or VID/PID pairs the registry already owns.
//
//   mise run device-new -- --from <template> --id <id> --name "<Name>" --vendor <slug> \
//     --vid 0x.... --pid 0x.... [--dry-run]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadRegistry } from './registry-loader.mjs';

const TS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEVICES = join(TS_DIR, 'src/devices');
const NOTES = join(DEVICES, 'device-notes.json');
const ELGATO_MK2_PID = 0x00a5; // shared/types.ts; a literal here keeps the script registry-only

// Explicit, never inferred from a brand. `pins` are wire flags written into the generated
// file so a later edit of the template cannot change an unverified model silently; a pinned
// value is the template's current one, except batching, which stays off until measured.
// heartbeatMs is never dropped: MiraboxDriver reads it with a non-null assertion.
const TEMPLATES = {
  'mirabox-293': {
    source: 'mirabox-293',
    importName: 'MIRABOX_293_MODEL',
    file: 'mirabox/mirabox-293',
    pins: [],
    blurb: 'Mirabox v3 board, 1024-byte packets, press and release',
  },
  'mirabox-293s': {
    source: 'mirabox-293s',
    importName: 'MIRABOX_293S_MODEL',
    file: 'mirabox/mirabox-293s',
    pins: ['batchImageTransfers'],
    blurb: 'Mirabox v1 board, 512-byte packets, keydown only',
  },
  'akp153-v1-clone': {
    source: 'mirabox-293s',
    importName: 'MIRABOX_293S_MODEL',
    file: 'mirabox/mirabox-293s',
    pins: ['heartbeatMs', 'synthesizeKeyUp', 'batchImageTransfers'],
    blurb: 'the v1 rebadge recipe of rebadge/akp153-v1-clones.ts',
  },
  'fifine-d6': {
    source: 'fifine-d6',
    importName: 'FIFINE_D6_MODEL',
    file: 'fifine/fifine-d6',
    pins: [],
    blurb: 'Fifine D6, a v3 board whose packet size the HID report descriptor arbitrates',
  },
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX16 = /^0x[0-9a-fA-F]{1,4}$/;
/** Single-quoted TS string literal. */
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const hex = (n, pad = 4) => `0x${n.toString(16).padStart(pad, '0')}`;

function fail(msg) {
  console.error(`device-new: ${msg}`);
  process.exit(1);
}

const USAGE = `usage: mise run device-new -- --from <${Object.keys(TEMPLATES).join('|')}> --id <id> --name "<Name>" --vendor <slug> --vid 0x.... --pid 0x.... [--dry-run]`;

function parseOptions() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        from: { type: 'string' },
        id: { type: 'string' },
        name: { type: 'string' },
        vendor: { type: 'string' },
        vid: { type: 'string' },
        pid: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
      },
    }));
  } catch (e) {
    fail(`${e.message}\n${USAGE}`);
  }
  const missing = ['from', 'id', 'name', 'vendor', 'vid', 'pid'].filter((k) => !values[k]);
  if (missing.length) fail(`missing --${missing.join(', --')} (VID/PID are never guessed)\n${USAGE}`);
  const template = TEMPLATES[values.from];
  if (!template) fail(`unknown template '${values.from}'; choose one of ${Object.keys(TEMPLATES).join(', ')}`);
  if (!SLUG.test(values.id)) fail(`--id '${values.id}' must be a kebab-case slug`);
  if (!SLUG.test(values.vendor)) fail(`--vendor '${values.vendor}' must be a kebab-case slug`);
  const pidTokens = values.pid.split(',');
  for (const t of [values.vid, ...pidTokens]) {
    if (!HEX16.test(t)) fail(`'${t}' is not a 16-bit hex value like 0x1234`);
  }
  const vid = Number.parseInt(values.vid, 16);
  const pids = pidTokens.map((t) => Number.parseInt(t, 16));
  if (vid === 0 || pids.includes(0)) fail('VID/PID 0x0000 is not a real device');
  if (new Set(pids).size !== pids.length) fail('--pid lists the same product id twice');
  return { ...values, template, vid, pids, dryRun: values['dry-run'] };
}

/** `{ a: 1, b: { c: 2 } }` as TS source, for the small splash objects. */
function lit(v) {
  if (v !== null && typeof v === 'object') {
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${k}: ${lit(x)}`)
      .join(', ')} }`;
  }
  return JSON.stringify(v).replace(/"/g, "'");
}

const constName = (id) => `${id.toUpperCase().replace(/-/g, '_')}_MODEL`;

function pinValues(opts, base) {
  return Object.fromEntries(
    opts.template.pins.map((key) => [key, key === 'batchImageTransfers' ? false : base.wire[key]]),
  );
}

function modelSource(opts, base) {
  const t = opts.template;
  const T = t.importName;
  const productId = base.cora.productId === ELGATO_MK2_PID ? 'ELGATO_MK2_PID' : hex(base.cora.productId);
  const pidList = opts.pids.map((p) => hex(p)).join(', ');
  const pins = Object.entries(pinValues(opts, base)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const wire = [`...${T}.wire`, ...pins].join(', ');
  const lines = [
    `import type { DeviceModel } from '../driver.js';`,
    `import { ${T} } from '../${t.file}.js';`,
  ];
  if (productId === 'ELGATO_MK2_PID') {
    lines.push(`import { ELGATO_MK2_PID } from '../../shared/types.js';`);
  }
  lines.push(
    '',
    `/** ${opts.name}: scaffolded from \`${opts.from}\` by \`mise run device-new\` — ${t.blurb}.`,
    ` *  NOT HARDWARE-TESTED: image, wire and keyMap are inherited from ${T} until measured. */`,
    `export const ${constName(opts.id)}: DeviceModel = {`,
    `  id: ${q(opts.id)},`,
    `  vendor: ${q(opts.vendor)},`,
    `  protocol: ${q(base.protocol)},`,
    `  name: ${q(opts.name)},`,
    `  usbVendorId: ${hex(opts.vid)},`,
    `  usbProductIds: [${pidList}],`,
  );
  if (base.usagePage !== undefined) lines.push(`  usagePage: ${hex(base.usagePage)},`);
  if (base.usage !== undefined) lines.push(`  usage: ${base.usage},`);
  lines.push(
    `  keyCount: ${base.keyCount},`,
    `  columns: ${base.columns},`,
    `  rows: ${base.rows},`,
    `  keyWidth: ${base.keyWidth},`,
    `  keyHeight: ${base.keyHeight},`,
    `  image: { ...${T}.image },`,
    `  wire: { ${wire} },`,
    `  keyMap: { ...${T}.keyMap },`,
    `  cora: {`,
    `    productId: ${productId},`,
  );
  if (base.cora.advertiseAs) lines.push(`    advertiseAs: ${q(base.cora.advertiseAs)},`);
  lines.push(`    usePhysicalIdentity: ${base.cora.usePhysicalIdentity},`, `  },`);
  if (base.splash) lines.push(`  splash: ${lit(base.splash)},`);
  lines.push(`};`, '');
  return lines.join('\n');
}

/** Same layout as the file's hand-formatted entries, so the diff is one block. */
function notesEntry(opts) {
  return [
    `    ${JSON.stringify(opts.id)}: {`,
    `      "tested": { "status": false },`,
    `      "summary": "TODO: one sentence on what this deck is and how it relates to ${opts.from}.",`,
    `      "alsoSoldAs": [],`,
    `      "quirks": [],`,
    `      "sources": []`,
    `    }`,
  ].join('\n');
}

function addNotesEntry(text, opts) {
  const tail = '    }\n  }\n}\n';
  if (!text.endsWith(tail)) fail('device-notes.json does not end the way the scaffold expects');
  return `${text.slice(0, -tail.length)}    },\n${notesEntry(opts)}\n  }\n}\n`;
}

async function main() {
  const opts = parseOptions();
  const registry = await loadRegistry();
  const known = new Set([...registry.DEVICE_MODELS, ...registry.CORA_PROFILES].map((m) => m.id));
  if (known.has(opts.id)) fail(`id '${opts.id}' already exists in the registry`);
  for (const m of registry.DEVICE_MODELS) {
    const clash = opts.pids.find((p) => m.usbVendorId === opts.vid && m.usbProductIds.includes(p));
    if (clash !== undefined) {
      fail(`${hex(opts.vid)}:${hex(clash)} already belongs to '${m.id}' (findModel ignores usage pages)`);
    }
  }
  const base = registry.DEVICE_MODELS.find((m) => m.id === opts.template.source);
  if (!base) fail(`template source '${opts.template.source}' is not in the registry`);

  const modelPath = join(DEVICES, opts.vendor, `${opts.id}.ts`);
  if (existsSync(modelPath)) fail(`${relative(TS_DIR, modelPath)} already exists`);
  const notesText = readFileSync(NOTES, 'utf8');
  if (Object.hasOwn(JSON.parse(notesText).notes, opts.id)) {
    fail(`device-notes.json already has an entry for '${opts.id}'`);
  }

  // Validate the candidate before writing, so a bad combination leaves no files behind.
  const candidate = {
    ...base,
    id: opts.id,
    vendor: opts.vendor,
    name: opts.name,
    usbVendorId: opts.vid,
    usbProductIds: opts.pids,
    wire: { ...base.wire, ...pinValues(opts, base) },
  };
  const errors = registry.validateCatalog([...registry.DEVICE_MODELS, candidate], registry.CORA_PROFILES);
  if (errors.length) fail(`candidate model is invalid:\n  - ${errors.join('\n  - ')}`);

  const source = modelSource(opts, base);
  const nextNotes = addNotesEntry(notesText, opts);
  const modelRel = relative(resolve(TS_DIR, '..'), modelPath);
  const name = constName(opts.id);
  const registryLines = [
    `  ts/src/devices/registry.ts`,
    `    import { ${name} } from './${opts.vendor}/${opts.id}.js';`,
    `    ...and inside DEVICE_MODELS:   ${name},`,
  ].join('\n');

  if (opts.dryRun) {
    console.log(`[dry-run] would create ${modelRel}:\n\n${source}`);
    console.log(`[dry-run] would add to ts/src/devices/device-notes.json:\n\n${notesEntry(opts)}\n`);
  } else {
    mkdirSync(dirname(modelPath), { recursive: true });
    writeFileSync(modelPath, source);
    writeFileSync(NOTES, nextNotes);
    console.log(`wrote ${modelRel}\nadded a device-notes.json stub for '${opts.id}'\n`);
  }
  console.log(`${opts.dryRun ? '[dry-run] ' : ''}Add to the registry (never edited by this script):\n${registryLines}\n`);
  console.log(
    'Then: fill the notes stub (a summary starting with TODO fails devices-check), run\n' +
      "  mise run devices-generate && mise run devices-check\n" +
      'The artwork row in gen-device-svgs.mjs stays optional (generic art is generated).',
  );
}

await main();
