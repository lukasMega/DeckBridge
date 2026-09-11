#!/usr/bin/env node
// Generates one front-elevation SVG illustration per supported device into
// docs/img/devices/. Every illustration comes out of the same layout engine, so the
// whole set stays visually consistent: identical key-face recipe, recess treatment,
// stand language and label typography. Only the grid shape, key pitch, chassis tone,
// accent hue, wordmark placement and stand type vary per model.
//
//   node ts/scripts/gen-device-svgs.mjs           # write files
//   node ts/scripts/gen-device-svgs.mjs --check   # fail if any file is out of date
//
// Proportions come from vendor product photography (see DEVICE-ARTWORK.md for the
// source list), not from the LCD panel pixel dimensions — those live in the registry.
//
// The key GRID always mirrors ts/src/devices/registry.ts, i.e. what DeckBridge actually
// drives. Where the physical product has more surface than DeckBridge exposes (the
// Ajazz rev. 2 boards), the illustration follows the registry, not the retail box.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', '..', 'docs', 'img', 'devices');

// ---------------------------------------------------------------------------
// Style constants — the single source of the "same style for all devices" rule.
// ---------------------------------------------------------------------------

const KEY = 62; // key face edge
const KEY_R = 9; // key corner radius
const STRIP_W = 38; // width of the 3-segment LCD status strip on the 18-key boards
const BEZEL = 24; // chassis margin around the key panel
const BAND = 40; // branding band (top or bottom, per model)
const KNOB_R = 21; // rotary encoder radius
const KNOB_BAND = 60; // vertical space a knob row occupies
const PAD = 28; // canvas padding around the chassis (room for the stand + shadow)

/** Chassis colourways. All share the same shading recipe; only the tones differ. */
const CHASSIS = {
  graphite: { top: '#3a3d45', bottom: '#25272d', edge: '#14161a', text: '#9aa0ad' },
  black: { top: '#2a2c31', bottom: '#17181c', edge: '#0c0d10', text: '#8d939f' },
  ink: { top: '#23252b', bottom: '#121317', edge: '#08090b', text: '#848a96' },
  white: { top: '#f4f5f8', bottom: '#dcdee6', edge: '#b9bcc7', text: '#5c6170' },
};

/**
 * The device set. `id` matches the anchor used in docs/devices.mdx.
 *
 *   cols/rows  main key grid, straight out of the device registry
 *   strip      right-hand 3-segment LCD status column (the v1 18-key boards) — flush
 *              with the face, not pressable, so it gets no keycap bevel
 *   knobs      rotary-encoder row below the keys
 *   gap        key gap as a fraction of key width, traced from product photos
 *   bodyR      chassis corner radius (Mirabox's plate is squarer than Elgato's slab)
 *   brand      wordmark placement: top | top-left | bottom | bottom-right
 *   stand      wedge (detachable) | integrated (one-piece) | bracket (folding easel) | none
 *   underglow  RGB light strip along the base (Fifine only)
 */
const DEVICES = [
  // --- Elgato -------------------------------------------------------------
  { id: 'mk2', name: 'Stream Deck MK.2', brand: 'ELGATO', cols: 5, rows: 3, gap: 0.22, bodyR: 18, label: 'top', stand: 'wedge', chassis: 'graphite', accent: '#4f63d2' }, // prettier-ignore
  { id: 'mini', name: 'Stream Deck Mini', brand: 'ELGATO', cols: 3, rows: 2, gap: 0.22, bodyR: 18, label: 'top', stand: 'integrated', chassis: 'graphite', accent: '#4f63d2' }, // prettier-ignore

  // --- Mirabox ------------------------------------------------------------
  { id: 'mirabox-293', name: 'Mirabox 293V3', brand: 'MIRABOX', cols: 5, rows: 3, gap: 0.32, bodyR: 10, label: 'bottom-right', stand: 'bracket', chassis: 'black', accent: '#22b8cf' }, // prettier-ignore
  { id: 'mirabox-293s', name: 'Mirabox 293S', brand: 'MIRABOX', cols: 5, rows: 3, strip: true, gap: 0.24, bodyR: 14, label: 'top', stand: 'wedge', chassis: 'black', accent: '#22b8cf' }, // prettier-ignore
  { id: 'mirabox-k1pro', name: 'Mirabox K1 Pro', brand: 'MIRABOX', cols: 3, rows: 2, knobs: 3, gap: 0.38, bodyR: 14, label: 'bottom', stand: 'none', chassis: 'black', accent: '#22b8cf' }, // prettier-ignore

  // --- Ajazz --------------------------------------------------------------
  { id: 'ajazz-akp153e-rev2', name: 'Ajazz AKP153E (rev. 2)', brand: 'AJAZZ', cols: 5, rows: 3, gap: 0.30, bodyR: 14, label: 'bottom', stand: 'wedge', chassis: 'ink', accent: '#e8590c' }, // prettier-ignore
  { id: 'ajazz-akp153r-rev2', name: 'Ajazz AKP153R (rev. 2)', brand: 'AJAZZ', cols: 5, rows: 3, gap: 0.30, bodyR: 14, label: 'bottom', stand: 'wedge', chassis: 'white', accent: '#e8590c' }, // prettier-ignore
  { id: 'ajazz-akp153', name: 'Ajazz AKP153', brand: 'AJAZZ', cols: 5, rows: 3, strip: true, gap: 0.30, bodyR: 14, label: 'bottom', stand: 'wedge', chassis: 'ink', accent: '#e8590c' }, // prettier-ignore
  { id: 'ajazz-akp153e', name: 'Ajazz AKP153E (rev. 1)', brand: 'AJAZZ', cols: 5, rows: 3, strip: true, gap: 0.30, bodyR: 14, label: 'bottom', stand: 'wedge', chassis: 'ink', accent: '#e8590c' }, // prettier-ignore
  { id: 'ajazz-akp153r', name: 'Ajazz AKP153R (rev. 1)', brand: 'AJAZZ', cols: 5, rows: 3, strip: true, gap: 0.30, bodyR: 14, label: 'bottom', stand: 'wedge', chassis: 'white', accent: '#e8590c' }, // prettier-ignore

  // --- Fifine -------------------------------------------------------------
  { id: 'fifine-d6', name: 'Fifine AmpliGame D6', brand: 'AMPLIGAME', cols: 5, rows: 3, gap: 0.19, bodyR: 14, label: 'top', stand: 'integrated', underglow: true, chassis: 'ink', accent: '#f59f00' }, // prettier-ignore
  { id: 'fifine-d6-rev2', name: 'Fifine AmpliGame D6 (rev. 2)', brand: 'AMPLIGAME', cols: 5, rows: 3, gap: 0.19, bodyR: 14, label: 'top', stand: 'integrated', underglow: true, chassis: 'ink', accent: '#f59f00' }, // prettier-ignore

  // --- v1 rebadges (all the same Mirabox 293S tooling) --------------------
  { id: 'mars-msd-one', name: 'Mars Gaming MSD-ONE', brand: 'MARS GAMING', cols: 5, rows: 3, strip: true, gap: 0.30, bodyR: 14, label: 'top', stand: 'integrated', chassis: 'black', accent: '#e03131' }, // prettier-ignore
  { id: 'maddog-gk150k', name: 'Mad Dog GK150K', brand: 'MAD DOG', cols: 5, rows: 3, strip: true, gap: 0.30, bodyR: 14, label: 'bottom-right', stand: 'wedge', chassis: 'black', accent: '#94d82d' }, // prettier-ignore
  { id: 'risemode-vision-01', name: 'Risemode Vision 01', brand: 'RISE MODE', cols: 5, rows: 3, strip: true, gap: 0.30, bodyR: 14, label: 'bottom', stand: 'integrated', chassis: 'ink', accent: '#7950f2' }, // prettier-ignore
  { id: 'tmice-stream-controller', name: 'TMICE Stream Controller', brand: 'TMICE', cols: 5, rows: 3, strip: true, gap: 0.30, bodyR: 14, label: 'top-left', stand: 'integrated', chassis: 'ink', accent: '#20c997' }, // prettier-ignore
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Deterministic 0..1 hash — drives which key faces read as "lit" so a device's
 *  artwork is stable across runs but doesn't look like a repeating pattern. */
function jitter(id, i) {
  let h = 2166136261;
  for (const ch of `${id}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

function render(d) {
  const c = CHASSIS[d.chassis];
  const gap = Math.round(KEY * d.gap);
  const knobs = d.knobs ?? 0;
  const labelTop = d.label === 'top' || d.label === 'top-left';

  const gridW = d.cols * KEY + (d.cols - 1) * gap;
  const panelW = gridW + (d.strip ? gap + STRIP_W : 0);
  const panelH = d.rows * KEY + (d.rows - 1) * gap;
  const bodyW = panelW + BEZEL * 2;
  const bodyH = BEZEL + panelH + (knobs ? KNOB_BAND : 0) + BAND;
  const W = bodyW + PAD * 2;
  const H = bodyH + PAD * 2;
  const bx = PAD;
  const by = PAD;
  const px = bx + BEZEL;
  const py = by + (labelTop ? BAND : BEZEL);

  const uid = d.id.replace(/[^a-z0-9]/g, '');

  // --- keys ---------------------------------------------------------------
  const keyEls = [];
  for (let r = 0; r < d.rows; r++) {
    for (let col = 0; col < d.cols; col++) {
      const i = r * d.cols + col;
      const j = jitter(d.id, i);
      const lit = j > 0.66;
      const x = px + col * (KEY + gap);
      const y = py + r * (KEY + gap);
      keyEls.push(
        `<g transform="translate(${x},${y})">` +
          `<rect width="${KEY}" height="${KEY}" rx="${KEY_R}" fill="${c.edge}"/>` +
          `<rect x="1" y="1" width="${KEY - 2}" height="${KEY - 2}" rx="${KEY_R - 1}" fill="url(#idle${uid})"/>` +
          (lit
            ? `<rect x="1" y="1" width="${KEY - 2}" height="${KEY - 2}" rx="${KEY_R - 1}" fill="${d.accent}" opacity="${(0.35 + j * 0.6).toFixed(2)}"/>`
            : '') +
          `<rect x="1" y="1" width="${KEY - 2}" height="${KEY - 2}" rx="${KEY_R - 1}" fill="url(#gloss${uid})"/>` +
          `<rect x="1.5" y="1.5" width="${KEY - 3}" height="${KEY - 3}" rx="${KEY_R - 1.5}" fill="none" stroke="#ffffff" stroke-opacity="0.07"/>` +
          `</g>`,
      );
    }
  }

  // --- side status strip ---------------------------------------------------
  // One flush LCD divided into 3 zones — deliberately NOT drawn as keycaps: on the
  // real 18-key boards this column is a display, even though DeckBridge exposes its
  // three zones as extra key ids.
  let stripEls = '';
  if (d.strip) {
    const sx = px + gridW + gap;
    const segH = panelH / 3;
    const segs = Array.from({ length: 3 }, (_, i) => {
      const j = jitter(`${d.id}:strip`, i);
      const y = i * segH;
      const divider =
        i > 0
          ? `<rect x="6" y="${y.toFixed(1)}" width="${STRIP_W - 12}" height="1" fill="#ffffff" opacity="0.10"/>`
          : '';
      return (
        `<rect x="7" y="${(y + segH / 2 - 7).toFixed(1)}" width="${STRIP_W - 14}" height="4" rx="2" fill="${d.accent}" opacity="${(0.3 + j * 0.5).toFixed(2)}"/>` +
        `<rect x="7" y="${(y + segH / 2 + 1).toFixed(1)}" width="${(STRIP_W - 14) * (0.4 + j * 0.5)}" height="3" rx="1.5" fill="#ffffff" opacity="0.16"/>` +
        divider
      );
    }).join('');
    stripEls =
      `<g transform="translate(${sx},${py})">` +
      `<rect width="${STRIP_W}" height="${panelH}" rx="6" fill="${c.edge}"/>` +
      `<rect x="1" y="1" width="${STRIP_W - 2}" height="${panelH - 2}" rx="5" fill="url(#idle${uid})"/>` +
      segs +
      `<rect x="1" y="1" width="${STRIP_W - 2}" height="${panelH - 2}" rx="5" fill="url(#gloss${uid})"/>` +
      `</g>`;
  }

  // --- knobs ---------------------------------------------------------------
  const knobY = py + panelH + KNOB_BAND / 2;
  const knobEls = knobs
    ? Array.from({ length: knobs }, (_, i) => {
        const step = panelW / knobs;
        const kx = px + step * (i + 0.5);
        return (
          `<g transform="translate(${kx.toFixed(1)},${knobY})">` +
          `<circle r="${KNOB_R}" fill="${c.edge}"/>` +
          `<circle r="${KNOB_R - 2}" fill="url(#knob${uid})"/>` +
          `<circle r="${KNOB_R - 8}" fill="none" stroke="#ffffff" stroke-opacity="0.08"/>` +
          `<rect x="-1" y="${-KNOB_R + 4}" width="2" height="7" rx="1" fill="${d.accent}" opacity="0.85"/>` +
          `</g>`
        );
      }).join('')
    : '';

  // --- stand ---------------------------------------------------------------
  // Front elevation, so the four stand types read as silhouette differences only.
  let standEls = '';
  if (d.stand === 'wedge') {
    // Separate cradle the slab drops into — a slab peeking out below and behind.
    standEls = `<path d="M ${bx + bodyW * 0.2} ${by + 10} H ${bx + bodyW * 0.8} L ${bx + bodyW * 0.88} ${by + bodyH + 13} H ${bx + bodyW * 0.12} Z" fill="${c.edge}" opacity="0.85"/>`;
  } else if (d.stand === 'integrated') {
    // One-piece wedge: the body itself flares into a wider base.
    standEls = `<path d="M ${bx + 4} ${by + bodyH - 26} H ${bx + bodyW - 4} L ${bx + bodyW + 6} ${by + bodyH + 14} H ${bx - 6} Z" fill="${c.bottom}" opacity="0.95"/>`;
  } else if (d.stand === 'bracket') {
    // Folding easel: two thin legs plus a front rail.
    standEls =
      `<rect x="${bx + bodyW * 0.22}" y="${by + bodyH - 6}" width="9" height="18" rx="3" fill="${c.edge}" opacity="0.85"/>` +
      `<rect x="${bx + bodyW * 0.78 - 9}" y="${by + bodyH - 6}" width="9" height="18" rx="3" fill="${c.edge}" opacity="0.85"/>` +
      `<rect x="${bx + bodyW * 0.18}" y="${by + bodyH + 8}" width="${bodyW * 0.64}" height="6" rx="3" fill="${c.edge}" opacity="0.7"/>`;
  }

  // --- labels --------------------------------------------------------------
  const bandMidY = labelTop ? by + BAND / 2 + 5 : by + bodyH - BAND / 2 + 5;
  const gridLabel = `${d.cols}×${d.rows}${d.strip ? ' + 3' : ''}${knobs ? ` + ${knobs}○` : ''}`;
  const font = 'Inter, Helvetica Neue, Arial, sans-serif';
  let wordmark;
  if (d.label === 'top') {
    wordmark = `<text x="${bx + bodyW / 2}" y="${bandMidY}" text-anchor="middle" font-family="${font}" font-size="13" font-weight="600" letter-spacing="2.4" fill="${c.text}">${d.brand}</text>`;
  } else if (d.label === 'bottom-right') {
    wordmark = `<text x="${bx + bodyW - BEZEL}" y="${bandMidY}" text-anchor="end" font-family="${font}" font-size="13" font-weight="600" letter-spacing="2.4" fill="${c.text}">${d.brand}</text>`;
  } else {
    // 'bottom' and 'top-left' both hang off the left bezel edge.
    wordmark = `<text x="${bx + BEZEL}" y="${bandMidY}" font-family="${font}" font-size="13" font-weight="600" letter-spacing="2.4" fill="${c.text}">${d.brand}</text>`;
  }
  // The grid caption shares the wordmark's band (the opposite band is only a plain
  // bezel and too shallow to hold text without touching the key recess) and hangs off
  // whichever edge the wordmark left free.
  const capRight = d.label !== 'bottom-right';
  const capX = capRight ? bx + bodyW - BEZEL : bx + BEZEL;
  const capAnchor = capRight ? 'text-anchor="end" ' : '';
  const caption = `<text x="${capX}" y="${bandMidY}" ${capAnchor}font-family="${font}" font-size="12" fill="${c.text}" opacity="0.7">${gridLabel}</text>`;

  const underglow = d.underglow
    ? `<rect x="${bx + 10}" y="${by + bodyH - 5}" width="${bodyW - 20}" height="4" rx="2" fill="${d.accent}" opacity="0.75"/>`
    : '';

  const recessH = panelH + 14 + (knobs ? KNOB_BAND - 6 : 0);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${d.name} — ${gridLabel} key stream deck">
  <title>${d.name}</title>
  <defs>
    <linearGradient id="body${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.top}"/>
      <stop offset="1" stop-color="${c.bottom}"/>
    </linearGradient>
    <linearGradient id="idle${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1e2027"/>
      <stop offset="1" stop-color="#0e0f13"/>
    </linearGradient>
    <linearGradient id="gloss${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.18"/>
    </linearGradient>
    <linearGradient id="knob${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.top}"/>
      <stop offset="1" stop-color="${c.edge}"/>
    </linearGradient>
    <filter id="shadow${uid}" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <!-- stand -->
  ${standEls}

  <!-- chassis -->
  <g filter="url(#shadow${uid})">
    <rect x="${bx}" y="${by}" width="${bodyW}" height="${bodyH}" rx="${d.bodyR}" fill="url(#body${uid})"/>
    <rect x="${bx + 0.5}" y="${by + 0.5}" width="${bodyW - 1}" height="${bodyH - 1}" rx="${d.bodyR - 0.5}" fill="none" stroke="#ffffff" stroke-opacity="0.10"/>
  </g>
  ${underglow}

  <!-- key panel recess -->
  <rect x="${px - 7}" y="${py - 7}" width="${panelW + 14}" height="${recessH}" rx="14" fill="#000000" opacity="0.22"/>

  <!-- keys -->
  <g>${keyEls.join('')}</g>
  ${stripEls}
  ${knobEls ? `<g>${knobEls}</g>` : ''}

  <!-- wordmark + grid caption -->
  ${wordmark}
  ${caption}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const check = process.argv.includes('--check');
mkdirSync(OUT_DIR, { recursive: true });

let stale = 0;
for (const d of DEVICES) {
  const file = join(OUT_DIR, `${d.id}.svg`);
  const svg = render(d);
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current !== svg) {
      console.error(`out of date: docs/img/devices/${d.id}.svg`);
      stale++;
    }
  } else {
    writeFileSync(file, svg);
  }
}

if (check) {
  if (stale) {
    console.error(`\n${stale} device SVG(s) out of date — run 'node ts/scripts/gen-device-svgs.mjs'.`);
    process.exit(1);
  }
  console.log(`device SVGs up to date (${DEVICES.length})`);
} else {
  console.log(`wrote ${DEVICES.length} device SVGs -> docs/img/devices/`);
}

export { DEVICES };
