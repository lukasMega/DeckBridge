// Stage renderers — one per device state (see deriveState in ui-helpers).
import { useState, useEffect } from 'preact/hooks';
import { useStore } from '../store.js';
import { ICON } from '../ui-icons.js';
import { Icon } from './Icon.js';
import { Step, KeyGridPreview, Brightness, ManualAddPanel } from './controls.js';
import { openSdApp, quitElgatoApp } from './handlers.js';

export function StageReady(): preact.JSX.Element {
  const keyCount = useStore((s) => s.status.keyCount ?? 15);
  const columns = useStore((s) => s.status.columns ?? 5);
  const modelId = useStore((s) => s.status.modelId);

  return (
    <>
      <div class="hero">
        {/* eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup */}
        <div class="hero-badge" dangerouslySetInnerHTML={{ __html: ICON.check }} />
        <h1>Everything&apos;s working</h1>
        <p>Your Stream Deck is connected to the Elgato app and ready to use.</p>
      </div>
      <KeyGridPreview keyCount={keyCount} columns={columns} dimmed={false} modelId={modelId} />
      <Brightness />
    </>
  );
}

export function StageDeviceNoElgato({
  onHelp,
}: Readonly<{ onHelp: (id: string) => void }>): preact.JSX.Element {
  const keyCount = useStore((s) => s.status.keyCount ?? 15);
  const columns = useStore((s) => s.status.columns ?? 5);
  const modelId = useStore((s) => s.status.modelId);
  const modelName = useStore((s) => s.status.modelName);

  return (
    <>
      {/* eslint-disable @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted HTML string literal */}
      <h1
        class="stage-title"
        dangerouslySetInnerHTML={{
          __html: 'Almost there — <span class="accent">1 step left</span>',
        }}
      />
      {/* eslint-enable @eslint-react/dom-no-dangerously-set-innerhtml */}
      <div class="checklist">
        <Step kind="done" title="Stream Deck connected">
          {modelName !== undefined && <div class="step-sub">{modelName}</div>}
        </Step>
        <Step kind="active" title="Open the Elgato Stream Deck app">
          <div class="step-sub">
            <a
              href="streamdeck://"
              id="openSdApp"
              class="app-link"
              title="Open Elgato Stream Deck"
              onClick={openSdApp}
            >
              Click to open Stream Deck app
            </a>
          </div>
          <ManualAddPanel onHelp={onHelp} />
        </Step>
      </div>
      <KeyGridPreview keyCount={keyCount} columns={columns} dimmed={true} modelId={modelId} />
    </>
  );
}

export function StageNoDevice({
  onHelp,
}: Readonly<{ onHelp: (id: string) => void }>): preact.JSX.Element {
  const [hidapiMissing, setHidapiMissing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/requirements', { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<Array<{ name: string; ok: boolean }>>) : null))
      .then((results) => {
        if (!results) return undefined;
        const hidapi = results.find((r) => r.name === 'libhidapi');
        if (hidapi !== undefined && !hidapi.ok) setHidapiMissing(true);
        return undefined;
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return;
      });
    return () => controller.abort();
  }, []);

  return (
    <>
      <h1 class="stage-title">Let&apos;s get you set up</h1>
      <div class="checklist">
        <Step kind="active" title="Plug in your Stream Deck" helpId="plug-in" onHelp={onHelp}>
          <div class="step-sub">
            Connect it via USB. Make sure the Elgato desktop app is not running.
          </div>
        </Step>
        <Step
          kind="pending"
          title="Open the Elgato Stream Deck app"
          helpId="open-app"
          onHelp={onHelp}
        >
          <div class="step-sub">Once your deck is detected, this lights up next.</div>
        </Step>
      </div>
      <div class="status-line">
        <span class="ico-spin" /> Waiting for a device…
      </div>
      {hidapiMissing && (
        <div class="warnrow">
          <Icon class="w-ico" html={ICON.warn} />
          <span>
            <code>libhidapi</code> not found
          </span>
          <a class="linkbtn fix" href="/requirements" target="_blank" rel="noopener">
            How to fix
          </a>
        </div>
      )}
    </>
  );
}

export function StageConflict(): preact.JSX.Element {
  return (
    <div class="conflict">
      {/* eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup */}
      <div class="conflict-badge" dangerouslySetInnerHTML={{ __html: ICON.warn }} />
      <h1>Elgato app is blocking access</h1>
      <p class="conflict-body">
        The Elgato Stream Deck app is running and has claimed the USB device. Quit it so DeckBridge
        can take over.
      </p>
      <button class="ctabtn" id="quitElgatoBtn" type="button" onClick={quitElgatoApp}>
        Quit Elgato App
      </button>
      <p class="conflict-after">
        After quitting, reconnect your Stream Deck if it isn&apos;t detected automatically.
      </p>
    </div>
  );
}
