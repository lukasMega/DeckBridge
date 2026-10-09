import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SimpleApp } from '../src/web/client/simple/SimpleApp.js';
import { patch, getSnapshot, EMPTY_STATUS } from '../src/web/client/lib/store.js';
import { SURVEY_QUESTIONS, SURVEY_VERSION } from '../src/web/server/survey-questions.js';
import type { SurveyDefinition, SurveyPayload } from '../src/web/contract-survey.js';

type Check = (condition: boolean, message: string) => void;
const DRAFT_KEY = 'deckbridge.surveyDraft';
const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

function makeDefinition(): SurveyDefinition {
  return {
    sv: SURVEY_VERSION,
    questions: SURVEY_QUESTIONS,
    short: ['rating', 'nps', 'want'],
    context: { v: 'test', os: 'unknown', ov: 'unknown', dv: 'none' },
    prefill: { features: ['pages'] },
    nudge: true,
    state: {},
  };
}

export async function runSurveyShort(root: HTMLElement, check: Check): Promise<void> {
  const original = globalThis.fetch;
  const before = getSnapshot();
  let definition = makeDefinition();
  let sends = true;
  let calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, body });
    let reply: unknown = {};
    if (url === '/api/survey') {
      reply = init?.method === 'POST' ? { sent: sends, reason: 'mock' } : { ...definition };
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(reply) } as Response);
  }) as typeof fetch;
  const ready = { ...EMPTY_STATUS, driverConnected: true, elgatoConnected: true };
  const mount = async (next: Partial<SurveyDefinition> = {}): Promise<void> => {
    definition = { ...makeDefinition(), ...next };
    calls = [];
    localStorage.removeItem(DRAFT_KEY);
    await act(() => {
      render(null, root);
      patch({ status: ready, connection: 'live' });
      render(<SimpleApp />, root);
    });
    await settle();
  };
  const q = <T extends Element>(sel: string): T => root.querySelector<T>(sel)!;
  const press = async (scope: string, text: string): Promise<void> => {
    await act(() =>
      Array.from(root.querySelectorAll<HTMLButtonElement>(`${scope} button`))
        .find((el) => el.textContent.trim() === text)!
        .click(),
    );
    await settle();
  };
  const pick = async (name: string, value: string): Promise<void> => {
    await act(() => q<HTMLInputElement>(`input[name="${name}"][value="${value}"]`).click());
    await settle();
  };
  const dismissCalls = (): string[] =>
    calls.filter((c) => c.url === '/api/survey/dismiss').map((c) => JSON.stringify(c.body));
  const sendBtn = (): HTMLButtonElement =>
    Array.from(root.querySelectorAll<HTMLButtonElement>('#survey-short button')).find(
      (el) => el.textContent === 'Send 3 answers',
    )!;
  const shortOpen = (): boolean => root.querySelector('#survey-short') !== null;
  const closeWizard = async (): Promise<void> => {
    await act(() => q<HTMLButtonElement>('#survey-modal .pop-close').click());
    await settle();
  };
  const preview = (): { a: Record<string, unknown>; f?: string } & SurveyPayload =>
    JSON.parse(q('#survey-short-preview').textContent) as SurveyPayload;

  try {
    await mount({ nudge: false });
    check(root.querySelector('.survey-nudge') === null, 'Banner hidden while nudge is false');
    check(root.querySelector('#footerFeedback .update-dot') === null, 'No dot without banner');

    // Visit refetch: the tab was opened before the uptime gate passed.
    definition.nudge = true;
    const gets = (): number => calls.filter((c) => c.url === '/api/survey').length;
    const getsBefore = gets();
    await act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    check(gets() === getsBefore + 1, 'Returning to the tab refetches the survey definition');
    check(root.querySelector('.survey-nudge') !== null, 'Banner appears after the refetch');
    check(
      root.querySelector('#footerFeedback .update-dot') !== null,
      'Feedback link shows a dot while the banner is up',
    );
    await act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    check(gets() === getsBefore + 1, 'No refetch once the banner is shown');

    await act(() => patch({ status: EMPTY_STATUS }));
    await settle();
    check(root.querySelector('.survey-nudge') === null, 'Banner is Ready-stage only');
    await act(() => patch({ status: ready }));
    await settle();

    // Face tap -> wizard after rating; closing it offers the short form.
    await pick('nudge-rating', '4');
    check(
      q('#survey-modal .survey-q').textContent === SURVEY_QUESTIONS[1]!.label &&
        q('[role="progressbar"]').getAttribute('aria-valuenow') === '2',
      'Face tap opens the step after rating',
    );
    await press('#survey-modal', 'Back');
    check(q<HTMLInputElement>('input[name="survey-rating"][value="4"]').checked, 'Rating is set');
    await closeWizard();
    check(shortOpen(), 'Closing the wizard unsent opens the short form');
    check(dismissCalls().length === 0, 'Nothing is posted before the short form closes');
    check(q('#survey-short').textContent.includes('Before you go'), 'Short form heading');
    check(
      q<HTMLInputElement>('#survey-short input[name="survey-rating"][value="4"]').checked,
      'Short form is prefilled with the banner rating',
    );
    check(sendBtn().disabled, 'Send is disabled until all 3 are answered');
    check(
      root.querySelector('#survey-short input[value="other"]') === null,
      'Short form hides the want other option',
    );
    await pick('survey-nps', '9');
    check(sendBtn().disabled, 'Two of three answers keep Send disabled');
    await pick('survey-want', 'widgets');
    check(!sendBtn().disabled, 'All 3 answers enable Send');
    const shown = preview();
    check(
      Object.keys(shown.a)
        .toSorted((a, b) => a.localeCompare(b))
        .join() === 'nps,rating,want' && shown.f === 'short',
      'Preview holds only the 3 ids and f: short',
    );
    check(localStorage.getItem(DRAFT_KEY) !== null, 'Wizard draft exists before No thanks');
    await press('#survey-short', 'No thanks');
    check(
      !shortOpen() && dismissCalls().join() === '{"never":false}',
      'No thanks posts the 30-day snooze',
    );
    check(localStorage.getItem(DRAFT_KEY) !== null, 'No thanks keeps the wizard draft');
    check(root.querySelector('.survey-nudge') === null, 'Banner is gone after the short form');
    await act(() => q<HTMLButtonElement>('#footerFeedback').click());
    await settle();
    await closeWizard();
    check(!shortOpen(), 'Short form is not reopened in the same page life');

    // Banner Not now: short form first, snooze only when it closes unsent; Send path.
    await mount();
    await press('.survey-nudge', 'Not now');
    check(shortOpen() && dismissCalls().length === 0, 'Not now opens the short form unposted');
    check(root.querySelector('.survey-nudge') === null, 'Not now hides the banner');
    await pick('survey-rating', '3');
    await pick('survey-nps', '7');
    await pick('survey-want', 'widgets');
    sends = false;
    await press('#survey-short', 'Send 3 answers');
    check(
      q('#survey-short').textContent.includes('Not sent: mock mode never sends feedback.'),
      'Unsent short form shows the matching message',
    );
    sends = true;
    const exact = JSON.stringify(preview());
    await press('#survey-short', 'Send 3 answers');
    const posted = calls.filter((c) => c.url === '/api/survey' && c.body !== undefined);
    const body = posted[posted.length - 1]!.body as SurveyPayload;
    check(
      JSON.stringify(body) === exact &&
        body.f === 'short' &&
        Object.keys(body.a)
          .toSorted((a, b) => a.localeCompare(b))
          .join() === 'nps,rating,want' &&
        body.a.rating === '3' &&
        body.sv === SURVEY_VERSION &&
        !('c' in body),
      'Posted payload has only the 3 ids and f: short',
    );
    check(root.querySelector('.survey-celebrate') !== null, 'Sent short form thanks the user');
    check(localStorage.getItem(DRAFT_KEY) === null, 'Short send clears the wizard draft');
    await act(() => q<HTMLButtonElement>('#survey-short .pop-close').click());
    await settle();
    check(dismissCalls().length === 0, 'Closing after a send posts no snooze');

    // Don't ask again never offers the short form.
    await mount();
    await press('.survey-nudge', "Don't ask again");
    check(
      !shortOpen() && dismissCalls().join() === '{"never":true}',
      "Don't ask again skips the short form",
    );

    // Don't send on the review step -> short form prefilled from wizard answers.
    await mount();
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        sv: SURVEY_VERSION,
        savedAt: Date.now(),
        step: SURVEY_QUESTIONS.length + 1,
        answers: { rating: '2', nps: '9', want: ['widgets', 'other'] },
        drafts: { want: 'something' },
        comment: '',
      }),
    );
    await act(() => q<HTMLButtonElement>('#footerFeedback').click());
    await settle();
    await press('#survey-modal', 'Continue');
    await press('#survey-modal', "Don't send");
    check(shortOpen(), "Don't send opens the short form");
    check(
      q<HTMLInputElement>('#survey-short input[name="survey-nps"][value="9"]').checked &&
        q<HTMLInputElement>('#survey-short input[name="survey-want"][value="widgets"]').checked,
      'Short form is prefilled from wizard answers',
    );
    check(
      JSON.stringify(preview().a.want) === '["widgets"]' && !sendBtn().disabled,
      'Other is stripped from the prefilled want',
    );
    await press('#survey-short', 'No thanks');

    // Banner face tap with a saved draft keeps the draft and resumes at its step.
    await mount();
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        sv: SURVEY_VERSION,
        savedAt: Date.now(),
        step: 3,
        answers: { nps: '8' },
        drafts: {},
        comment: '',
      }),
    );
    await pick('nudge-rating', '5');
    check(
      q('[role="progressbar"]').getAttribute('aria-valuenow') === '4' &&
        root.querySelector('#survey-modal')!.textContent.includes('Continue your unfinished') ===
          false,
      'Face tap with a draft resumes at the draft step',
    );
    await closeWizard();
    check(
      q<HTMLInputElement>('#survey-short input[name="survey-rating"][value="5"]').checked &&
        q<HTMLInputElement>('#survey-short input[name="survey-nps"][value="8"]').checked,
      'Draft answers and the new rating both reach the short form',
    );
    await press('#survey-short', 'No thanks');

    // Skipped when the survey is finished with.
    for (const state of [{ never: true }, { submittedSv: SURVEY_VERSION }]) {
      await mount({ state });
      await act(() => q<HTMLButtonElement>('#footerFeedback').click());
      await settle();
      await closeWizard();
      check(!shortOpen(), `Short form skipped for ${JSON.stringify(state)}`);
    }

    // Notification deep link: wizard opens once and the param is stripped.
    const basePath = location.pathname;
    history.replaceState(null, '', `${basePath}?survey=1&x=1#h`);
    await mount({ nudge: false });
    check(
      root.querySelector('#survey-modal') !== null,
      '?survey=1 opens the survey wizard without a banner',
    );
    check(
      location.search === '?x=1' && location.hash === '#h',
      `survey param stripped, others kept (${location.search}${location.hash})`,
    );
    await closeWizard();
    await mount({ nudge: false });
    check(root.querySelector('#survey-modal') === null, 'Reload without the param stays closed');
  } finally {
    history.replaceState(null, '', location.pathname);
    localStorage.removeItem(DRAFT_KEY);
    await act(() => render(null, root));
    await act(() => patch(before));
    globalThis.fetch = original;
  }
}
