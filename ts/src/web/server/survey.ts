import type {
  SurveyAnswers,
  SurveyContext,
  SurveyOption,
  SurveyPayload,
  SurveyQuestion,
} from '../contract-survey.js';
import type { Settings, DeviceIdentitySettings } from '../../infra/settings-store.js';
import { buildPayload } from '../../infra/daily-ping.js';
import type { PayloadInput } from '../../infra/daily-ping.js';

import { SURVEY_VERSION, SURVEY_QUESTIONS, SHORT_QUESTIONS } from './survey-questions.js';
export { SURVEY_VERSION, SURVEY_QUESTIONS, SHORT_QUESTIONS } from './survey-questions.js';

export const SURVEY_MIN_UPTIME_MS = 10 * 60 * 1000;
export const SURVEY_NOTIFY_UPTIME_MS = 30 * 60 * 1000;

function optionFor(q: SurveyQuestion, id: string): SurveyOption | undefined {
  return q.options.find((o) => o.id === id || o.options?.some((sub) => sub.id === id));
}

function validMulti(q: SurveyQuestion, values: unknown[]): string[] {
  const kept = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const option = optionFor(q, value);
    if (option && !kept.has(option.id)) kept.set(option.id, value);
  }
  if (q.exclusive && kept.has(q.exclusive)) return [q.exclusive];
  return [...kept.values()].slice(0, q.max ?? q.options.length);
}

// eslint-disable-next-line sonarjs/function-return-type -- Wire answers are strings or arrays.
function validAnswer(q: SurveyQuestion, value: unknown): string | string[] | undefined {
  if (q.kind === 'single')
    return typeof value === 'string' && optionFor(q, value) ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const values = validMulti(q, value);
  return values.length ? values : undefined;
}

export function validateSurvey(
  raw: unknown,
  comment: unknown,
  useForOther?: unknown,
  wantOther?: unknown,
): Pick<SurveyPayload, 'a' | 'c' | 'useForOther' | 'wantOther'> {
  const a: SurveyAnswers = {};
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  for (const q of SURVEY_QUESTIONS) {
    const value = validAnswer(q, input[q.id]);
    if (value !== undefined) a[q.id] = value;
  }
  const c = typeof comment === 'string' ? comment.trim().slice(0, 280) : '';
  const detail =
    a['use-for']?.includes('other') && typeof useForOther === 'string'
      ? useForOther.trim().slice(0, 300)
      : '';
  const request =
    a.want?.includes('other') && typeof wantOther === 'string'
      ? wantOther.trim().slice(0, 100)
      : '';
  return {
    a,
    ...(c ? { c } : {}),
    ...(detail ? { useForOther: detail } : {}),
    ...(request ? { wantOther: request } : {}),
  };
}

export function surveyContext(input: PayloadInput): SurveyContext {
  const { v, os, ov, dv } = buildPayload(input);
  return { v, os, ov, dv };
}

export function surveyPayload(
  context: SurveyContext,
  answers: unknown,
  comment: unknown,
  useForOther?: unknown,
  wantOther?: unknown,
): SurveyPayload {
  return {
    sv: SURVEY_VERSION,
    ...context,
    ...validateSurvey(answers, comment, useForOther, wantOther),
  };
}

function usesStandby(standby: DeviceIdentitySettings['standby']): boolean {
  if (!standby) return false;
  return !!(
    standby.idleDim ||
    standby.offWhenIdle ||
    standby.night ||
    standby.pixelShift ||
    (standby.appGoneAction && standby.appGoneAction !== 'none')
  );
}

function addDeviceFeatures(features: Set<string>, device: DeviceIdentitySettings): void {
  const layouts = [device.extraKeys, ...(device.pages ?? []).map((p) => p.extraKeys)];
  if (layouts.some((layout) => Object.keys(layout ?? {}).length)) features.add('side-keys');
  if (device.pages?.length) features.add('pages');
  if (device.encoders || (device.touchStripMode && device.touchStripMode !== 'elgato'))
    features.add('touch-strip');
  if (usesStandby(device.standby)) features.add('standby');
  if (layouts.some((layout) => Object.values(layout ?? {}).some((key) => key.widget === 'plugin')))
    features.add('plugin-widgets');
}

export function prefillSurvey(settings: Settings): SurveyAnswers {
  const features = new Set<string>();
  if (settings.multiDeck) features.add('multi-deck');
  if (settings.virtualDeck?.enabled) features.add('browser-deck');
  if (settings.accessTokens?.some((t) => t.scopes.includes('push'))) features.add('push-api');
  if (Object.keys(settings.modelOverrides ?? {}).length) features.add('device-tuning');
  if (settings.elgatoAutoRestart !== false && settings.devices?.some((d) => d.pairedAt))
    features.add('auto-restart');
  for (const device of settings.devices ?? []) addDeviceFeatures(features, device);
  return features.size
    ? {
        features: SURVEY_QUESTIONS.find((q) => q.id === 'features')!
          .options.map((o) => o.id)
          .filter((id) => features.has(id)),
      }
    : {};
}

// The short form has no free-text field, so `other` is dropped from `want`
// rather than rejected; an empty `want` then leaves the form incomplete.
export function shortSurveyPayload(
  context: SurveyContext,
  answers: unknown,
): SurveyPayload | undefined {
  const input = typeof answers === 'object' && answers !== null ? answers : {};
  const raw: Record<string, unknown> = {};
  for (const id of SHORT_QUESTIONS) raw[id] = (input as Record<string, unknown>)[id];
  if (Array.isArray(raw.want)) raw.want = raw.want.filter((id) => id !== 'other');
  const { a } = validateSurvey(raw, null);
  if (!SHORT_QUESTIONS.every((id) => a[id] !== undefined)) return undefined;
  return { sv: SURVEY_VERSION, ...context, a, f: 'short' };
}

function surveyOpen(settings: Settings, now: Date): boolean {
  const state = settings.survey ?? {};
  if (state.never || (state.submittedSv ?? 0) >= SURVEY_VERSION) return false;
  if (Date.parse(state.snoozedUntil ?? '') > now.getTime()) return false;
  return (settings.devices ?? []).some((d) => Number.isFinite(Date.parse(d.pairedAt ?? '')));
}

export function shouldNudgeSurvey(settings: Settings, now: Date, uptimeMs: number): boolean {
  return uptimeMs >= SURVEY_MIN_UPTIME_MS && surveyOpen(settings, now);
}

/** Native OS notification: only for runs where the WebUI was never opened (the banner
 *  covers the rest), and at most once per survey version. */
export function shouldNotifySurvey(
  settings: Settings,
  now: Date,
  uptimeMs: number,
  webUiOpened: boolean,
): boolean {
  if (webUiOpened || uptimeMs < SURVEY_NOTIFY_UPTIME_MS) return false;
  if ((settings.survey?.notifiedSv ?? 0) >= SURVEY_VERSION) return false;
  return surveyOpen(settings, now);
}
