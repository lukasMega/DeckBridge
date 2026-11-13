import type { SurveyAnswers, SurveyDefinition } from '../../contract-survey.js';

const KEY = 'deckbridge.surveyDraft';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SurveyDraft {
  sv: number;
  savedAt: number;
  step: number;
  answers: SurveyAnswers;
  drafts: Record<string, string>;
  comment: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clearSurveyDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage can be blocked; the in-memory draft still works.
  }
}

export function saveSurveyDraft(draft: Omit<SurveyDraft, 'savedAt'>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
    // Quota or blocked storage: losing the draft beats breaking the survey.
  }
}

function cleanAnswers(raw: Record<string, unknown>, ids: Set<string>): SurveyAnswers {
  const answers: SurveyAnswers = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!ids.has(id)) continue;
    if (
      typeof value === 'string' ||
      (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    )
      answers[id] = value;
  }
  return answers;
}

function cleanDrafts(raw: Record<string, unknown>): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value === 'string') drafts[id] = value;
  }
  return drafts;
}

function readRaw(): unknown {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return undefined;
  }
}

/** Returns null (and drops the entry) when absent, malformed, stale or from another survey version. */
export function loadSurveyDraft(definition: SurveyDefinition): SurveyDraft | null {
  const raw = readRaw();
  if (raw === null) return null;
  if (
    !isRecord(raw) ||
    raw.sv !== definition.sv ||
    typeof raw.savedAt !== 'number' ||
    Date.now() - raw.savedAt > MAX_AGE_MS ||
    !isRecord(raw.answers) ||
    !isRecord(raw.drafts)
  ) {
    clearSurveyDraft();
    return null;
  }
  const last = definition.questions.length + 1;
  const step = typeof raw.step === 'number' ? Math.min(Math.max(0, Math.trunc(raw.step)), last) : 0;
  return {
    sv: definition.sv,
    savedAt: raw.savedAt,
    step,
    answers: cleanAnswers(raw.answers, new Set(definition.questions.map((q) => q.id))),
    drafts: cleanDrafts(raw.drafts),
    comment: typeof raw.comment === 'string' ? raw.comment.slice(0, 280) : '',
  };
}
