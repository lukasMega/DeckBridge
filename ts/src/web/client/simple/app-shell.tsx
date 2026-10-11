import { ICON } from '../components/Icon.js';
import { ThemeButton } from '../components/ThemeButton.js';
import { switchToAdvanced } from './handlers.js';
import { BackButton } from './controls.js';

export function Topbar({
  updateBadge,
  onBack,
  onHome,
  onAbout,
  onSettings,
  onStatistics,
}: Readonly<{
  updateBadge: string | null;
  onBack: (() => void) | null;
  onHome: () => void;
  onAbout: () => void;
  onSettings: () => void;
  onStatistics: () => void;
}>): preact.JSX.Element {
  return (
    <div class="topbar">
      <div class="topbar-left">
        <div class="brand">
          <button class="brand-home" type="button" title="Home" onClick={onHome}>
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
            onClick={onAbout}
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
          {!__DEMO__ && (
            <>
              <button
                class="iconbtn circle"
                id="settingsBtn"
                aria-label="Settings"
                title="Settings"
                type="button"
                onClick={onSettings}
                // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
                dangerouslySetInnerHTML={{ __html: ICON.gear }}
              />
              {updateBadge && (
                <span class="update-dot" title={`DeckBridge v${updateBadge} available`} />
              )}
              <button
                class="iconbtn circle"
                id="statisticsBtn"
                aria-label="Statistics"
                title="Statistics"
                type="button"
                onClick={onStatistics}
                // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
                dangerouslySetInnerHTML={{ __html: ICON.stats }}
              />
            </>
          )}
        </div>
        {onBack !== null && <BackButton onClick={onBack} />}
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
  );
}

export function AppFooter({
  showDot,
  onAbout,
  onFeedback,
}: Readonly<{
  showDot: boolean;
  onAbout: () => void;
  onFeedback: () => void;
}>): preact.JSX.Element {
  return (
    <footer class="disclaimer">
      Unofficial hobby project ·{' '}
      <button class="linkbtn" id="footerAbout" type="button" onClick={onAbout}>
        About
      </button>{' '}
      {!__DEMO__ && '·'}{' '}
      {!__DEMO__ && (
        <button class="linkbtn" id="footerFeedback" type="button" onClick={onFeedback}>
          Feedback
          {showDot && <span class="update-dot" />}
        </button>
      )}
    </footer>
  );
}
