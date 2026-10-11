/**
 * SimpleApp — Preact replacement for the SIMPLE view (end-user wizard).
 *
 * Renders into #simple-view and reads from store.ts. Top-level shell only;
 * the stages, overlays, and controls live under ./simple/.
 * The ADVANCED view is untouched legacy code.
 */
import { useEffect, useState } from 'preact/hooks';
import { fire } from '../lib/ui-api.js';
import { useStore } from '../lib/store.js';
import type { Status } from '../ui-types.js';
import { deriveState, isMultiDockView, updateBadgeVersion } from '../ui-helpers.js';
import { AboutPopover, SettingsPage, HelpScreen } from './overlays.js';
import { StatisticsPage } from './statistics-page.js';
import { ICON, Icon } from '../components/Icon.js';
import { AppFooter, Topbar } from './app-shell.js';
import { useSurveyFlow } from './survey-flow.js';
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

// Statistics repaints every poll; announcing it would be noise.
const STAGE_LIVE = { home: 'polite', settings: 'polite', statistics: 'off' } as const;

function SubPage({
  page,
  onBack,
  onFeedback,
}: Readonly<{
  page: 'settings' | 'statistics';
  onBack: () => void;
  onFeedback: () => void;
}>): preact.JSX.Element {
  return page === 'settings' ? (
    <SettingsPage onBack={onBack} onFeedback={onFeedback} />
  ) : (
    <StatisticsPage onBack={onBack} />
  );
}

type Page = 'home' | 'settings' | 'statistics';

function isReady(status: Status): boolean {
  return isMultiDockView(status.docks)
    ? status.docks.every((d) => d.elgatoConnected)
    : deriveState(status) === 'ready';
}

function StageContent({
  page,
  activeHelp,
  onHelp,
  onBack,
  onClosePage,
  onFeedback,
}: Readonly<{
  page: Page;
  activeHelp: string | null;
  onHelp: (id: string) => void;
  onBack: () => void;
  onClosePage: () => void;
  onFeedback: () => void;
}>): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const docks = status.docks;
  const deviceState = deriveState(status);
  if (!__DEMO__ && page !== 'home')
    return <SubPage page={page} onBack={onClosePage} onFeedback={onFeedback} />;
  if (activeHelp !== null) return <HelpScreen topicId={activeHelp} onBack={onBack} />;
  if (isMultiDockView(docks))
    return isReady(status) ? (
      <StageReady docks={docks} onHelp={onHelp} />
    ) : (
      <StageMultiPairing docks={docks} onHelp={onHelp} />
    );
  if (deviceState === 'ready') return <StageReady />;
  if (deviceState === 'device-no-elgato') return <StageDeviceNoElgato onHelp={onHelp} />;
  if (deviceState === 'no-device-elgato-conflict') return <StageConflict />;
  return <StageNoDevice onHelp={onHelp} />;
}

export function SimpleApp(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const updateInfo = useStore((s) => s.updateInfo);
  const stale = useStore((s) => s.connection === 'stale');
  const [activeHelp, setActiveHelp] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [page, setPage] = useState<Page>('home');
  const closeAbout = (): void => setAboutOpen(false);
  const flow = useSurveyFlow(
    !__DEMO__ && isReady(status) && page === 'home' && activeHelp === null,
    closeAbout,
  );
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

  const openAbout = (): void => setAboutOpen(true);
  const closePage = (): void => setPage('home');
  const handleBack = (): void => setActiveHelp(null);
  const goHome = (): void => {
    closePage();
    handleBack();
  };
  let headerBack: (() => void) | null = null;
  if (page !== 'home') headerBack = closePage;
  else if (activeHelp !== null) headerBack = handleBack;

  return (
    <>
      <div class="app">
        <Topbar
          updateBadge={updateBadge}
          onBack={headerBack}
          onHome={goHome}
          onAbout={openAbout}
          onSettings={() => setPage('settings')}
          onStatistics={() => setPage('statistics')}
        />
        <StaleBanner />
        {flow.banner}
        {/* inert: the shown status is cached, so its controls must not act on it. */}
        <section class="stage" id="stage" aria-live={STAGE_LIVE[page]} inert={stale}>
          <StageContent
            page={page}
            activeHelp={activeHelp}
            onHelp={setActiveHelp}
            onBack={handleBack}
            onClosePage={() => {
              if (!flow.blocking) closePage();
            }}
            onFeedback={flow.open}
          />
        </section>
        <AppFooter showDot={flow.showNudge} onAbout={openAbout} onFeedback={flow.open} />
      </div>
      <div class="toast" id="toast" role="status" aria-live="polite" />
      {aboutOpen && <AboutPopover onClose={closeAbout} onFeedback={flow.open} />}
      {!__DEMO__ && flow.overlays}
    </>
  );
}
