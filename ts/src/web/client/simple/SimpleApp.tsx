/**
 * SimpleApp — Preact replacement for the SIMPLE view (end-user wizard).
 *
 * Renders into #simple-view and reads from store.ts. Top-level shell only;
 * the stages, overlays, and controls live under ./simple/.
 * The ADVANCED view is untouched legacy code.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SurveyAnswers, SurveyDefinition } from '../../contract-survey.js';
import { SurveyModal } from './survey-modal.js';
import { SurveyNudge } from './survey-nudge.js';
import { SurveyShort } from './survey-short.js';
import { Modal } from '../components/Modal.js';
import { GhostButton } from '../components/GhostButton.js';
import { fire, postJson, useFetched } from '../lib/ui-api.js';
import { useStore } from '../lib/store.js';
import { deriveState, isMultiDockView, updateBadgeVersion } from '../ui-helpers.js';
import { switchToAdvanced } from './handlers.js';
import { AboutPopover, SettingsPage, HelpScreen } from './overlays.js';
import { BackButton } from './controls.js';
import { ICON, Icon } from '../components/Icon.js';
import { ThemeButton } from '../components/ThemeButton.js';
import {
  StageReady,
  StageDeviceNoElgato,
  StageNoDevice,
  StageConflict,
  StageMultiPairing,
} from './stages.js';

function StaleBanner(): preact.JSX.Element | null {
  const stale = useStore((s) => s.connection === 'stale');
  if (!stale) return null;
  return (
    <div class="warnrow conn-banner" id="connBanner" role="status">
      <Icon class="w-ico" html={ICON.warn} />
      <span>Connection interrupted. Retrying…</span>
    </div>
  );
}

export function SimpleApp(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const updateInfo = useStore((s) => s.updateInfo);
  const stale = useStore((s) => s.connection === 'stale');
  const [activeHelp, setActiveHelp] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const updateBadge = updateBadgeVersion(updateInfo);

  // DailyPing's fallback when the OS-level locale probe fails (see
  // daily-ping.ts) — best-effort, fire-and-forget like every other beacon.
  useEffect(function postBrowserLocale() {
    let timeZone = '';
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {}
    if (navigator.language) fire('/api/browser-locale', { locale: navigator.language, timeZone });
  }, []);

  const deviceState = deriveState(status);
  const docks = status.docks;

  const openSurvey = async (): Promise<void> => {
    setAboutOpen(false);
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
  const ready = isMultiDockView(docks)
    ? docks.every((d) => d.elgatoConnected)
    : deviceState === 'ready';
  const showNudge =
    ready && !settingsOpen && activeHelp === null && !!survey.data?.nudge && !surveyDismissed;

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
  const openAbout = (): void => setAboutOpen(true);
  const closeAbout = (): void => setAboutOpen(false);
  const openSettings = (): void => setSettingsOpen(true);
  const closeSettings = (): void => setSettingsOpen(false);
  const goHome = (): void => {
    setSettingsOpen(false);
    setActiveHelp(null);
  };
  const handleHelp = (id: string): void => setActiveHelp(id);
  const handleBack = (): void => setActiveHelp(null);
  let headerBack: (() => void) | null = null;
  if (settingsOpen) headerBack = closeSettings;
  else if (activeHelp !== null) headerBack = handleBack;

  let stageContent: preact.JSX.Element;
  if (settingsOpen) {
    stageContent = (
      <SettingsPage
        onBack={() => {
          if (!surveyOpen && !shortOpen) closeSettings();
        }}
        onFeedback={() => void openSurvey()}
      />
    );
  } else if (activeHelp !== null) {
    stageContent = <HelpScreen topicId={activeHelp} onBack={handleBack} />;
  } else if (isMultiDockView(docks)) {
    stageContent = docks.every((d) => d.elgatoConnected) ? (
      <StageReady docks={docks} onHelp={handleHelp} />
    ) : (
      <StageMultiPairing docks={docks} onHelp={handleHelp} />
    );
  } else if (deviceState === 'ready') {
    stageContent = <StageReady />;
  } else if (deviceState === 'device-no-elgato') {
    stageContent = <StageDeviceNoElgato onHelp={handleHelp} />;
  } else if (deviceState === 'no-device-elgato-conflict') {
    stageContent = <StageConflict />;
  } else {
    stageContent = <StageNoDevice onHelp={handleHelp} />;
  }

  return (
    <>
      <div class="app">
        <div class="topbar">
          <div class="topbar-left">
            <div class="brand">
              <button class="brand-home" type="button" title="Home" onClick={goHome}>
                <span class="mark" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <circle cx="3.4" cy="8" r="2" fill="white" fill-opacity="0.95" />
                    <circle cx="12.6" cy="8" r="2" fill="white" fill-opacity="0.95" />
                    <path
                      d="M5.4 8h5.2"
                      stroke="white"
                      stroke-opacity="0.95"
                      stroke-width="1.6"
                      stroke-linecap="round"
                    />
                  </svg>
                </span>
                <span class="wordmark">DeckBridge</span>
              </button>
              <button
                class="iconbtn circle"
                id="aboutBtn"
                aria-label="About DeckBridge"
                title="About DeckBridge"
                type="button"
                onClick={openAbout}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.4" />
                  <circle cx="8" cy="4.8" r="0.95" fill="currentColor" />
                  <path
                    d="M8 7.2v4.2"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
              <button
                class="iconbtn circle"
                id="settingsBtn"
                aria-label="Settings"
                title="Settings"
                type="button"
                onClick={openSettings}
                // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
                dangerouslySetInnerHTML={{ __html: ICON.gear }}
              />
              {updateBadge && (
                <span class="update-dot" title={`DeckBridge v${updateBadge} available`} />
              )}
            </div>
            {headerBack !== null && <BackButton onClick={headerBack} />}
          </div>
          <div class="topbar-actions">
            <span class="app-version" title="DeckBridge version">
              v{__VERSION__}
            </span>
            <ThemeButton id="themeBtn" />
            {!__SIMPLE_ONLY__ && (
              <button class="ghostbtn" id="advancedBtn" type="button" onClick={switchToAdvanced}>
                Advanced <span>›</span>
              </button>
            )}
          </div>
        </div>
        <StaleBanner />
        {showNudge && (
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
        )}
        {/* inert: the shown status is cached, so its controls must not act on it. */}
        <section class="stage" id="stage" aria-live="polite" inert={stale}>
          {stageContent}
        </section>
        <footer class="disclaimer">
          Unofficial hobby project ·{' '}
          <button class="linkbtn" id="footerAbout" type="button" onClick={openAbout}>
            About
          </button>{' '}
          ·{' '}
          <button
            class="linkbtn"
            id="footerFeedback"
            type="button"
            onClick={() => void openSurvey()}
          >
            Feedback
            {showNudge && <span class="update-dot" />}
          </button>
        </footer>
      </div>
      <div class="toast" id="toast" role="status" aria-live="polite" />
      {aboutOpen && <AboutPopover onClose={closeAbout} onFeedback={() => void openSurvey()} />}
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
          onSent={() => {
            setSurveyDismissed(true);
            void survey.reload();
          }}
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
          onSent={() => {
            setSurveyDismissed(true);
            void survey.reload();
          }}
          onRefresh={survey.reload}
        />
      )}
    </>
  );
}
