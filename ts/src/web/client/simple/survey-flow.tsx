import { useEffect, useRef, useState } from 'preact/hooks';
import type { SurveyAnswers, SurveyDefinition } from '../../contract-survey.js';
import { SurveyModal } from './survey-modal.js';
import { SurveyNudge } from './survey-nudge.js';
import { SurveyShort } from './survey-short.js';
import { Modal } from '../components/Modal.js';
import { GhostButton } from '../components/GhostButton.js';
import { postJson, useFetched } from '../lib/ui-api.js';

export interface SurveyFlow {
  banner: preact.JSX.Element | null;
  overlays: preact.JSX.Element;
  showNudge: boolean;
  /** A survey form is up, so a page behind it must not close. */
  blocking: boolean;
  open: () => void;
}

/** Feedback survey state: nudge banner, wizard, short form. `eligible`: banner may show now. */
export function useSurveyFlow(eligible: boolean, onBeforeOpen: () => void): SurveyFlow {
  const survey = useFetched<SurveyDefinition>('/api/survey');
  const [surveyOpen, setSurveyOpen] = useState(false);
  const [surveyStarted, setSurveyStarted] = useState(false);
  const [surveyDismissed, setSurveyDismissed] = useState(false);
  const [surveyRating, setSurveyRating] = useState<string | undefined>(undefined);
  const [surveySession, setSurveySession] = useState(0);
  const [shortOpen, setShortOpen] = useState(false);
  const [shortSeed, setShortSeed] = useState<SurveyAnswers>({});
  const shortShownRef = useRef(false);
  const [surveyError, setSurveyError] = useState('');
  const showNudge = eligible && !!survey.data?.nudge && !surveyDismissed;

  const openSurvey = async (): Promise<void> => {
    onBeforeOpen();
    await survey.reload();
    setSurveyStarted(true);
    setSurveyOpen(true);
  };
  const rateFromBanner = (rating: string): void => {
    setSurveyRating(rating);
    setSurveySession((n) => n + 1);
    setSurveyStarted(true);
    setSurveyOpen(true);
  };
  const neverAsk = async (): Promise<void> => {
    try {
      await postJson('/api/survey/dismiss', { never: true });
      setSurveyDismissed(true);
    } catch {
      setSurveyError('Could not save feedback preference. Try again.');
    }
  };
  // Once per page life, so declining can never loop.
  const offerShort = (answers: SurveyAnswers): void => {
    const def = survey.data;
    if (!def || shortShownRef.current || def.state.never || (def.state.submittedSv ?? 0) >= def.sv)
      return;
    shortShownRef.current = true;
    setShortSeed(answers);
    setShortOpen(true);
  };

  // The gate is uptime-based, so a tab opened early only learns it may nudge on return.
  const reloadRef = useRef(survey.reload);
  reloadRef.current = survey.reload;
  useEffect(
    function refetchOnReturn() {
      if (showNudge || surveyDismissed || surveyOpen || shortOpen) return;
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') void reloadRef.current();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => document.removeEventListener('visibilitychange', onVisible);
    },
    [showNudge, surveyDismissed, surveyOpen, shortOpen],
  );
  // Native-notification deep link: open the wizard once, then drop the param so a
  // reload does not reopen it.
  useEffect(function openSurveyFromLink() {
    const url = new URL(location.href);
    if (url.searchParams.get('survey') !== '1') return;
    url.searchParams.delete('survey');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    async function open(): Promise<void> {
      await reloadRef.current();
      setSurveyStarted(true);
      setSurveyOpen(true);
    }
    void open();
  }, []);

  const banner = showNudge ? (
    <SurveyNudge
      rating={survey.data?.questions.find((q) => q.id === 'rating')}
      error={surveyError}
      onRate={rateFromBanner}
      onNotNow={() => {
        setSurveyDismissed(true);
        offerShort({});
      }}
      onNever={() => void neverAsk()}
    />
  ) : null;
  const markSent = (): void => {
    setSurveyDismissed(true);
    void survey.reload();
  };
  const overlays = (
    <>
      {surveyOpen && !survey.data && (
        <Modal
          title="Quick feedback"
          titleId="survey-loading-title"
          onClose={() => setSurveyOpen(false)}
        >
          <p role="status">{survey.error ?? 'Loading feedback…'}</p>
          <GhostButton onClick={survey.reload}>Retry</GhostButton>
        </Modal>
      )}
      {surveyStarted && survey.data && (
        <SurveyModal
          definition={survey.data}
          key={surveySession}
          open={surveyOpen}
          initialRating={surveyRating}
          onClose={(answers, sent) => {
            setSurveyOpen(false);
            if (!sent) offerShort(answers);
          }}
          onSent={markSent}
          onRefresh={survey.reload}
        />
      )}
      {shortOpen && survey.data && (
        <SurveyShort
          definition={survey.data}
          seed={shortSeed}
          onClose={() => {
            setShortOpen(false);
            setSurveyDismissed(true);
          }}
          onSent={markSent}
          onRefresh={survey.reload}
        />
      )}
    </>
  );
  return {
    banner,
    overlays,
    showNudge,
    blocking: surveyOpen || shortOpen,
    open: () => void openSurvey(),
  };
}
