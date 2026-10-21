// The verify wizard's part of the device report: every pick per step, and per area a result
// in the device-notes.json vocabulary. Plus the prefilled GitHub issue link.
import type { VerifySpec } from '../../../contract-verify.js';

export type VerifyResult = 'pass' | 'fixed' | 'fail' | 'unknown';
/** Step id → the user's picks in order (a ladder or a re-pick adds more than one). */
export type VerifyAnswers = Record<string, string[]>;

export interface VerifyReport {
  answers: VerifyAnswers;
  results: Record<'image' | 'input' | 'colours' | 'size' | 'realImages', VerifyResult>;
}

/** What only the wizard knows: the blank ladder ran out, and what the save changed. */
export interface VerifyOutcome {
  failed: boolean;
  imageChanged: boolean;
  sizeChanged: boolean;
}

/** Last pick → result. `ok` = it worked: `fixed` if the save changed it, else `pass`. */
const BY_LAST_PICK: Record<string, Record<string, string>> = {
  colours: { rgb: 'pass', bgr: 'fail', other: 'fail' },
  real: { yes: 'pass', cut: 'fail', wrong: 'fail' },
  buttons: { yes: 'pass', fixed: 'fixed', no: 'fail' },
  size: { fits: 'ok', cut: 'ok', gap: 'ok', fail: 'fail' },
  confirm: { yes: 'ok' },
};

export function verifyReport(answers: VerifyAnswers, outcome: VerifyOutcome): VerifyReport {
  const result = (step: string, changed?: boolean): VerifyResult => {
    const r = BY_LAST_PICK[step]![answers[step]?.at(-1) ?? ''] ?? 'unknown';
    if (r !== 'ok') return r as VerifyResult;
    return changed ? 'fixed' : 'pass';
  };
  return {
    answers,
    results: {
      image: outcome.failed ? 'fail' : result('confirm', outcome.imageChanged),
      input: result('buttons'),
      colours: result('colours'),
      size: result('size', outcome.sizeChanged),
      realImages: result('real'),
    },
  };
}

const ISSUE_URL = 'https://github.com/lukasMega/DeckBridge/issues/new';
/** Longer prefill links fail on GitHub; the report then goes through the clipboard. */
export const MAX_ISSUE_URL = 7500;

/** `withReport` false = the link leaves the report field empty for a paste. */
export function issueUrl(
  spec: Pick<VerifySpec, 'modelId' | 'modelName' | 'appVersion'>,
  report: string,
): { url: string; withReport: boolean } {
  const link = (withReport: boolean): string =>
    `${ISSUE_URL}?${new URLSearchParams({
      template: 'device_verification.yml',
      title: `[Device check]: ${spec.modelName}`,
      model: `${spec.modelName} (${spec.modelId})`,
      version: spec.appVersion,
      ...(withReport ? { report } : {}),
    }).toString()}`;
  const full = link(true);
  return full.length <= MAX_ISSUE_URL
    ? { url: full, withReport: true }
    : { url: link(false), withReport: false };
}
