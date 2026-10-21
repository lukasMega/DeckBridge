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
import type { ExtensionInfo, Status } from '../ui-types.js';
import { deriveState, isMultiDockView, updateBadgeVersion } from '../ui-helpers.js';
import { AboutPopover, SettingsPage, HelpScreen } from './overlays.js';
import { ExtensionPage } from './extension-page.js';
import { ICON, Icon } from '../components/Icon.js';
import { AppFooter, Topbar } from './app-shell.js';
import { useSurveyFlow } from './survey-flow.js';
import { VerifyHost } from './verify-wizard/verify-entry.js';
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

/** 'ext:<id>' = an extension's page. */
type Page = 'home' | 'settings' | `ext:${string}`;

function SubPage({
  page,
  ext,
  onBack,
  onFeedback,
}: Readonly<{
  page: Page;
  ext: ExtensionInfo | undefined;
  onBack: () => void;
  onFeedback: () => void;
}>): preact.JSX.Element {
  return ext ? (
    <ExtensionPage key={page} ext={ext} onBack={onBack} />
  ) : (
    <SettingsPage onBack={onBack} onFeedback={onFeedback} />
  );
}

function isReady(status: Status): boolean {
  return isMultiDockView(status.docks)
    ? status.docks.every((d) => d.elgatoConnected)
    : deriveState(status) === 'ready';
}

function StageContent({
  page,
  ext,
  activeHelp,
  onHelp,
  onBack,
  onClosePage,
  onFeedback,
}: Readonly<{
  page: Page;
  ext: ExtensionInfo | undefined;
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
    return <SubPage page={page} ext={ext} onBack={onClosePage} onFeedback={onFeedback} />;
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
  const extensions = useStore((s) => s.extensions.extensions);
  const [picked, setPicked] = useState<Page>('home');
  const pages = extensions.filter((e) => e.state === 'running' && e.page);
  const ext = pages.find((e) => picked === `ext:${e.id}`);
  // An extension that stops while its page is open falls back to home.
  const page: Page = picked.startsWith('ext:') && !ext ? 'home' : picked;
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
  const closePage = (): void => setPicked('home');
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
          onSettings={() => setPicked('settings')}
          pages={pages}
          onPage={(id) => setPicked(`ext:${id}`)}
        />
        <StaleBanner />
        {flow.banner}
        {/* inert: the shown status is cached, so its controls must not act on it. */}
        {/* Extension pages may repaint on every poll; announcing that would be noise. */}
        <section class="stage" id="stage" aria-live={ext ? 'off' : 'polite'} inert={stale}>
          <StageContent
            page={page}
            ext={ext}
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
      <VerifyHost />
      {!__DEMO__ && flow.overlays}
    </>
  );
}
