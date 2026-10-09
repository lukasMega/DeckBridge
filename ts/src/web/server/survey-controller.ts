import type {
  SurveyContext,
  SurveyDefinition,
  SurveyPayload,
  SurveySendResult,
} from '../contract-survey.js';
import type { PersistedSettings } from '../../infra/settings.js';
import {
  SURVEY_QUESTIONS,
  SURVEY_VERSION,
  prefillSurvey,
  shouldNudgeSurvey,
  surveyPayload,
} from './survey.js';

export interface SurveyDeps {
  context: () => Promise<SurveyContext>;
  isMock: () => boolean;
  send: (body: string, version: string) => Promise<SurveySendResult>;
  now?: () => Date;
}

export class SurveyController {
  private deps: SurveyDeps = {
    context: () => Promise.resolve({ v: __VERSION__, os: 'unknown', ov: 'unknown', dv: 'none' }),
    isMock: () => true,
    send: () => Promise.resolve({ sent: false, reason: 'mock' }),
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
      context: await this.deps.context(),
      prefill: prefillSurvey(saved),
      nudge: shouldNudgeSurvey(saved, this.now()),
      state: this.settings.survey ?? {},
    };
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
    const input = body as Partial<SurveyPayload>;
    if (input.sv !== SURVEY_VERSION) return { sent: false, reason: 'rejected' };
    this.sending = true;
    try {
      const context = await this.deps.context();
      // Reject changed context so the reviewed JSON remains exactly what is sent.
      if (
        Object.entries(context).some(([key, value]) => input[key as keyof SurveyContext] !== value)
      )
        return { sent: false, reason: 'rejected' };
      const payload = surveyPayload(context, input.a, input.c, input.useForOther, input.wantOther);
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
