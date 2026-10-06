// Per-PID hardware evidence records (`variants` in device-notes.json). Generator-side only:
// evidence never ships in the bundle. `tested` stays the model-level label and is never
// upgraded from here.

const RESULT_KEYS = ['image', 'input', 'brightness', 'idle'];
const RESULT_VALUES = new Set(['pass', 'fail', 'unknown']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PID_RE = /^0x[0-9a-f]{4}$/;

function pidErrors(m, v, at) {
  if (typeof v.pid !== 'string' || !PID_RE.test(v.pid)) {
    return [`${at}: pid must be lowercase 0x + 4 hex digits`];
  }
  if (!m.usbProductIds.includes(Number.parseInt(v.pid, 16))) {
    return [`${at}: pid is not one of ${m.id}'s usbProductIds`];
  }
  return [];
}

function resultErrors(v, at) {
  const errors = [];
  for (const [k, value] of Object.entries(v.results ?? {})) {
    if (!RESULT_KEYS.includes(k)) errors.push(`${at}: unknown result '${k}'`);
    else if (!RESULT_VALUES.has(value)) errors.push(`${at}: results.${k} must be pass, fail or unknown`);
  }
  return errors;
}

function variantErrors(m, v) {
  const at = `${m.id} variant ${v.pid ?? '?'}`;
  const errors = pidErrors(m, v, at);
  if (!DATE_RE.test(v.date ?? '')) errors.push(`${at}: date must be YYYY-MM-DD`);
  if (!v.platform) errors.push(`${at}: platform is required`);
  for (const k of ['firmware', 'appVersion', 'profile']) {
    if (v[k] !== null && typeof v[k] !== 'string') {
      errors.push(`${at}: ${k} must be a string or null (never guessed)`);
    }
  }
  return [...errors, ...resultErrors(v, at)];
}

/** Error strings naming the model id; empty when every variant is well formed. */
export function validateVariants(models, notes) {
  return models.flatMap((m) => (notes[m.id]?.variants ?? []).flatMap((v) => variantErrors(m, v)));
}

/** Table rows for the per-PID evidence block; `esc` is the caller's cell escaper. */
export function variantRows(variants, esc, dash) {
  return variants.map((v) => {
    const results = RESULT_KEYS.map((k) => `${k} ${v.results?.[k] ?? 'unknown'}`).join(', ');
    const pid = v.usagePage === undefined ? v.pid : `${v.pid} (usage page 0x${v.usagePage.toString(16)})`;
    return [
      `\`${pid}\``,
      esc(v.platform),
      v.date,
      esc(v.appVersion ?? 'unknown'),
      esc(v.firmware ?? 'unknown'),
      results,
      v.profile ? `\`${v.profile}\`` : dash,
      esc(v.source ?? 'unknown'),
      v.gaps?.length ? v.gaps.map(esc).join('<br />') : dash,
    ];
  });
}

export const VARIANT_HEADERS = [
  'PID',
  'Platform',
  'Date',
  'App',
  'Firmware',
  'Results',
  'Profile',
  'Source',
  'Gaps',
];
