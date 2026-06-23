/**
 * SimpleApp — Preact replacement for the SIMPLE view (end-user wizard).
 *
 * Renders into #simple-view and reads from store.ts. Top-level shell only;
 * the stages, overlays, and controls live under ./simple/.
 * The ADVANCED view is untouched legacy code.
 */
import { useState } from 'preact/hooks';
import { useStore } from './store.js';
import { deriveState } from './ui-helpers.js';
import { switchToAdvanced } from './simple/handlers.js';
import { AboutPopover, HelpScreen } from './simple/overlays.js';
import { StageReady, StageDeviceNoElgato, StageNoDevice, StageConflict } from './simple/stages.js';

export function SimpleApp(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const [activeHelp, setActiveHelp] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  const deviceState = deriveState(status);

  const openAbout = (): void => setAboutOpen(true);
  const closeAbout = (): void => setAboutOpen(false);
  const handleHelp = (id: string): void => setActiveHelp(id);
  const handleBack = (): void => setActiveHelp(null);

  let stageContent: preact.JSX.Element;
  if (activeHelp !== null) {
    stageContent = <HelpScreen topicId={activeHelp} onBack={handleBack} />;
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
          </div>
          {!__SIMPLE_ONLY__ && (
            <button class="ghostbtn" id="advancedBtn" type="button" onClick={switchToAdvanced}>
              Advanced <span>›</span>
            </button>
          )}
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
