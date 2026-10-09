// Survey wire DTOs; server owns all question labels and accepted values.
export interface SurveyOption {
  id: string;
  label: string;
  options?: SurveyOption[];
}

export interface SurveyQuestion {
  id: string;
  label: string;
  kind: 'single' | 'multi';
  options: SurveyOption[];
  max?: number;
  exclusive?: string;
  faces?: boolean;
  ends?: [string, string];
}

export type SurveyAnswers = Record<string, string | string[]>;

export interface SurveyContext {
  v: string;
  os: 'macos' | 'windows' | 'linux' | 'unknown';
  ov: string;
  dv: string;
}

export interface SurveyPayload extends SurveyContext {
  sv: number;
  a: SurveyAnswers;
  c?: string;
  useForOther?: string;
  wantOther?: string;
}

export interface SurveyState {
  snoozedUntil?: string;
  never?: boolean;
  submittedSv?: number;
  submittedAt?: string;
}

export interface SurveyDefinition {
  sv: number;
  questions: SurveyQuestion[];
  context: SurveyContext;
  prefill: SurveyAnswers;
  nudge: boolean;
  state: SurveyState;
}

export interface SurveySendResult {
  sent: boolean;
  reason?: 'mock' | 'offline' | 'no-curl' | 'rejected';
}
