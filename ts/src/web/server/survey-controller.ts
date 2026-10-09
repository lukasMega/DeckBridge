import type {
  SurveyContext,
  SurveyDefinition,
  SurveyPayload,
  SurveySendResult,
} from '../contract-survey.js';
import type { PersistedSettings } from '../../infra/settings.js';
import {
  SHORT_QUESTIONS,
  SURVEY_QUESTIONS,
  SURVEY_VERSION,
  prefillSurvey,
  shortSurveyPayload,
  shouldNotifySurvey,
  shouldNudgeSurvey,
  surveyPayload,
} from './survey.js';

export interface SurveyDeps {
  context: () => Promise<SurveyContext>;
  isMock: () => boolean;
  send: (body: string, version: string) => Promise<SurveySendResult>;
  now?: () => Date;
  uptimeMs: () => number;
}

type RawSurvey = { [K in keyof SurveyPayload]?: unknown };

function hasOtherThanShort(input: RawSurvey): boolean {
  const ids = Object.keys(typeof input.a === 'object' && input.a ? input.a : {});
  return (
    ids.some((id) => !SHORT_QUESTIONS.includes(id)) ||
    input.c !== undefined ||
    input.useForOther !== undefined ||
    input.wantOther !== undefined
  );
}

function buildPayload(context: SurveyContext, input: RawSurvey): SurveyPayload | undefined {
  if (input.f === 'short')
    return hasOtherThanShort(input) ? undefined : shortSurveyPayload(context, input.a);
  const payload = surveyPayload(context, input.a, input.c, input.useForOther, input.wantOther);
  const missingDetail =
    (payload.a['use-for']?.includes('other') && !payload.useForOther) ||
    (payload.a.want?.includes('other') && !payload.wantOther);
  return missingDetail ? undefined : payload;
}

export class SurveyController {
  private deps: SurveyDeps = {
    context: () => Promise.resolve({ v: __VERSION__, os: 'unknown', ov: 'unknown', dv: 'none' }),
    isMock: () => true,
    send: () => Promise.resolve({ sent: false, reason: 'mock' }),
    uptimeMs: () => 0,
  };
  private sending = false;

  constructor(private readonly settings: PersistedSettings) {}

  configure(deps: SurveyDeps): void {
    this.deps = deps;
  }

  async view(): Promise<SurveyDefinition> {
    const saved = JSON.parse(this.settings.json()) as Parameters<typeof prefillSurvey>[0];
    saved.accessTokens = [...this.settings.accessTokenRecords()];
    return {
      sv: SURVEY_VERSION,
      questions: SURVEY_QUESTIONS,
      short: SHORT_QUESTIONS,
      context: await this.deps.context(),
      prefill: prefillSurvey(saved),
      nudge: shouldNudgeSurvey(saved, this.now(), this.deps.uptimeMs()),
      state: this.settings.survey ?? {},
    };
  }

  /** True once per survey version when the native notification is due; marks it
   *  notified first so a failed delivery never repeats. Mock mode never notifies. */
  takeNotification(webUiOpened: boolean): boolean {
    if (this.deps.isMock()) return false;
    const saved = JSON.parse(this.settings.json()) as Parameters<typeof prefillSurvey>[0];
    if (!shouldNotifySurvey(saved, this.now(), this.deps.uptimeMs(), webUiOpened)) return false;
    this.settings.survey = { ...this.settings.survey, notifiedSv: SURVEY_VERSION };
    this.settings.persist();
    return true;
  }

  dismiss(never: boolean): void {
    this.settings.survey = {
      ...this.settings.survey,
      ...(never
        ? { never: true }
        : {
            snoozedUntil: new Date(this.now().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          }),
    };
    this.settings.persist();
  }

  async submit(body: unknown): Promise<SurveySendResult> {
    if (this.deps.isMock()) return { sent: false, reason: 'mock' };
    if (this.sending || !body || typeof body !== 'object')
      return { sent: false, reason: 'rejected' };
    const input = body as RawSurvey;
    if (input.sv !== SURVEY_VERSION || (input.f !== undefined && input.f !== 'short'))
      return { sent: false, reason: 'rejected' };
    this.sending = true;
    try {
      const context = await this.deps.context();
      // Reject changed context so the reviewed JSON remains exactly what is sent.
      if (
        Object.entries(context).some(([key, value]) => input[key as keyof SurveyContext] !== value)
      )
        return { sent: false, reason: 'rejected' };
      const payload = buildPayload(context, input);
      if (!payload) return { sent: false, reason: 'rejected' };
      const result = await this.deps.send(JSON.stringify(payload), context.v);
      if (result.sent) {
        this.settings.survey = {
          ...this.settings.survey,
          submittedSv: SURVEY_VERSION,
          submittedAt: this.now().toISOString(),
        };
        this.settings.persist();
      }
      return result;
    } catch {
      return { sent: false, reason: 'offline' };
    } finally {
      this.sending = false;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
