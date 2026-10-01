// Push API text rules: channel names, body validation and the glyph-safe sanitizer.
// Pure (no tjs), so the CLI and the web server share it.
import { fontGlyphIndex } from '../assets/font-atlas.js';

export const PUSH_CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const isPushChannel = (v: unknown): v is string =>
  typeof v === 'string' && PUSH_CHANNEL_RE.test(v);

/** Same cap as a plugin widget value. */
export const PUSH_TEXT_MAX = 256;
export const PUSH_BODY_MAX = 4096;
export const PUSH_TTL_DEFAULT_S = 600;
export const PUSH_TTL_MAX_S = 86_400;

const PUSH_HEX_COLOR = /^#[0-9a-f]{6}$/i;
const PUSH_BODY_KEYS = ['text', 'ttl', 'color', 'background'];

export interface SanitizedText {
  text: string;
  /** Characters replaced by `?` because the font has no glyph. */
  replaced: number;
  truncated: boolean;
}

const FOLDS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '′': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '″': '"',
  '–': '-',
  '—': '-',
  '−': '-',
  '•': '·',
  '€': 'EUR',
  '™': 'TM',
  '→': '->',
  '←': '<-',
  ' ': ' ',
  ' ': ' ',
  '\t': ' ',
};

// Zero-width joiners/spaces, variation selectors and tag characters: invisible, so dropped
// silently instead of becoming a `?`.
function isInvisible(cp: number): boolean {
  return (
    (cp >= 0x200b && cp <= 0x200d) ||
    cp === 0x2060 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0020 && cp <= 0xe007f)
  );
}

const isControl = (cp: number): boolean => (cp < 0x20 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f);

/** Make `raw` drawable with the bundled font (ASCII, Latin-1, `…`). */
export function sanitizePushText(raw: string): SanitizedText {
  const src = raw.normalize('NFC').replace(/\r\n?/g, '\n');
  let out = '';
  let count = 0;
  let replaced = 0;
  let truncated = false;
  for (const ch of src) {
    const folded = FOLDS[ch] ?? ch;
    for (const c of folded) {
      const cp = c.codePointAt(0)!;
      if (isInvisible(cp) || isControl(cp)) continue;
      if (count >= PUSH_TEXT_MAX) {
        truncated = true;
        return { text: out, replaced, truncated };
      }
      if (fontGlyphIndex(cp) < 0 && cp !== 0x0a) {
        out += '?';
        replaced++;
      } else {
        out += c;
      }
      count++;
    }
  }
  return { text: out, replaced, truncated };
}

export interface PushInput {
  text: string;
  ttlS: number;
  color?: string;
  background?: string;
}

/** null when `body` is a valid push body; else a message naming the bad field. */
export function pushBodyError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'body must be a JSON object';
  }
  const r = body as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (!PUSH_BODY_KEYS.includes(k)) return `unknown field: ${k}`;
  }
  if (typeof r.text !== 'string' || r.text.length > PUSH_BODY_MAX) {
    return `text must be a string of at most ${PUSH_BODY_MAX} characters`;
  }
  return ttlError(r.ttl) ?? colorError(r);
}

function ttlError(ttl: unknown): string | null {
  if (ttl === undefined) return null;
  const ok = Number.isInteger(ttl) && (ttl as number) >= 0 && (ttl as number) <= PUSH_TTL_MAX_S;
  return ok ? null : `ttl must be an integer 0..${PUSH_TTL_MAX_S}`;
}

function colorError(r: Record<string, unknown>): string | null {
  for (const f of ['color', 'background']) {
    const v = r[f];
    if (v !== undefined && !(typeof v === 'string' && PUSH_HEX_COLOR.test(v))) {
      return `${f} must be a #rrggbb colour`;
    }
  }
  return null;
}

/** Call only after `pushBodyError` returned null. Text is not sanitized here. */
export function toPushInput(body: unknown): PushInput {
  const r = body as Record<string, unknown>;
  return {
    text: r.text as string,
    ttlS: (r.ttl as number | undefined) ?? PUSH_TTL_DEFAULT_S,
    color: r.color as string | undefined,
    background: r.background as string | undefined,
  };
}
