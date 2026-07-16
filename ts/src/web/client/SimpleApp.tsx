/**
 * SimpleApp — Preact replacement for the SIMPLE view (end-user wizard).
 *
 * Renders into #simple-view and reads from store.ts. Top-level shell only;
 * the stages, overlays, and controls live under ./simple/.
 * The ADVANCED view is untouched legacy code.
 */
import { useState } from 'preact/hooks';
import { useStore } from './store.js';
import {
  deriveState,
  deriveDocks,
  isMultiDockView,
  getTheme,
  setTheme as persistTheme,
  type ThemePref,
} from './ui-helpers.js';
import { switchToAdvanced } from './simple/handlers.js';
import { AboutPopover, SettingsPage, HelpScreen } from './simple/overlays.js';
import { ICON } from './ui-icons.js';
import {
  StageReady,
  StageDeviceNoElgato,
  StageNoDevice,
  StageConflict,
  StageMultiPairing,
} from './simple/stages.js';

const THEME_CYCLE: readonly ThemePref[] = ['light', 'dark', 'auto'];
const THEME_ICON: Record<ThemePref, string> = { light: ICON.sun, dark: ICON.moon, auto: ICON.auto };
const THEME_LABEL: Record<ThemePref, string> = { light: 'Light', dark: 'Dark', auto: 'Auto' };

export function SimpleApp(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const [activeHelp, setActiveHelp] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(() => getTheme());

  const deviceState = deriveState(status);
  const docks = deriveDocks(status);

  const openAbout = (): void => setAboutOpen(true);
  const closeAbout = (): void => setAboutOpen(false);
  const openSettings = (): void => setSettingsOpen(true);
  const closeSettings = (): void => setSettingsOpen(false);
  const handleHelp = (id: string): void => setActiveHelp(id);
  const handleBack = (): void => setActiveHelp(null);
  const cycleTheme = (): void => {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length]!;
    persistTheme(next);
    setTheme(next);
  };

  let stageContent: preact.JSX.Element;
  if (settingsOpen) {
    stageContent = <SettingsPage onBack={closeSettings} />;
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
      <div class="grain" aria-hidden="true" />
      <div class="app">
        <div class="topbar">
          <div class="brand">
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
            <button
              class="iconbtn"
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
              class="iconbtn"
              id="settingsBtn"
              aria-label="Settings"
              title="Settings"
              type="button"
              onClick={openSettings}
              // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
              dangerouslySetInnerHTML={{ __html: ICON.gear }}
            />
          </div>
          <div class="topbar-actions">
            <button
              class="iconbtn"
              id="themeBtn"
              aria-label={`Theme: ${THEME_LABEL[theme]}. Click to change.`}
              title={`Theme: ${THEME_LABEL[theme]}`}
              type="button"
              onClick={cycleTheme}
              // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
              dangerouslySetInnerHTML={{ __html: THEME_ICON[theme] }}
            />
            {!__SIMPLE_ONLY__ && (
              <button class="ghostbtn" id="advancedBtn" type="button" onClick={switchToAdvanced}>
                Advanced <span>›</span>
              </button>
            )}
          </div>
        </div>
        <section class="stage" id="stage" aria-live="polite">
          {stageContent}
        </section>
        <footer class="disclaimer">
          Not affiliated with Elgato · hobby use only · doesn&apos;t replace the Network Dock ·{' '}
          <button class="linkbtn" id="footerAbout" type="button" onClick={openAbout}>
            About
          </button>
        </footer>
      </div>
      <div class="toast" id="toast" />
      {aboutOpen && <AboutPopover onClose={closeAbout} />}
    </>
  );
}
