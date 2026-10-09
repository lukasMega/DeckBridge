import type { SurveyPayload, SurveySendResult } from '../../contract-survey.js';
import { postJson } from '../lib/ui-api.js';

export const UNSENT: Record<NonNullable<SurveySendResult['reason']>, string> = {
  mock: 'Not sent: mock mode never sends feedback.',
  offline: 'Not sent: connection failed. Your answers are kept on this device for retry.',
  'no-curl': 'Not sent: curl is unavailable. Your answers are kept on this device for retry.',
  rejected:
    'Not sent: response rejected or device context changed. Retry after reviewing the updated preview.',
};

/** A transport failure reads as `offline`, same as a send the server could not deliver. */
export async function submitSurvey(payload: SurveyPayload): Promise<SurveySendResult> {
  try {
    return await postJson<SurveySendResult>('/api/survey', payload, 'Send failed');
  } catch {
    return { sent: false, reason: 'offline' };
  }
}
