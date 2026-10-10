import { useEffect, useRef, useState, type ReactNode } from 'react';
import Layout from '@theme/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './demo.module.css';
import appIcon from '../../../src-tauri/icons/128x128.png';
import trayDisconnected from '../../../rust/deckbridge-tray/icons/icon-disconnected.png';
import trayUsb from '../../../rust/deckbridge-tray/icons/icon-usb-only.png';
import trayFull from '../../../rust/deckbridge-tray/icons/icon-full.png';

export default function Demo(): ReactNode {
  const demoUrl = useBaseUrl('/demo-app/index.html');
  const frame = useRef<HTMLIFrameElement>(null);
  const pairedModal = useRef<HTMLDialogElement>(null);
  const wasPaired = useRef(false);
  const [running, setRunning] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const [tray, setTray] = useState({ icon: trayDisconnected, status: 'No device' });
  const [pairedDevice, setPairedDevice] = useState<string | null>(null);

  useEffect(() => {
    function onStatus(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow)
        return;
      if (event.data?.type !== 'deckbridge-demo-status') return;
      const { plugged, elgatoConnected, modelName } = event.data;
      const paired = Boolean(plugged && elgatoConnected);
      if (paired && !wasPaired.current) setPairedDevice(modelName);
      if (!paired) setPairedDevice(null);
      wasPaired.current = paired;
      setTray({
        icon: plugged ? (elgatoConnected ? trayFull : trayUsb) : trayDisconnected,
        status: plugged
          ? elgatoConnected
            ? `${modelName} + Elgato app connected`
            : `${modelName} connected (Elgato app not paired)`
          : 'No device',
      });
    }
    window.addEventListener('message', onStatus);
    return () => window.removeEventListener('message', onStatus);
  }, []);

  useEffect(() => {
    const modal = pairedModal.current;
    if (pairedDevice) modal?.showModal();
    else if (modal?.open) modal.close();
  }, [pairedDevice]);

  function quit() {
    setRunning(false);
    setTrayOpen(false);
    setWindowOpen(false);
    wasPaired.current = false;
    setPairedDevice(null);
    setTray({ icon: trayDisconnected, status: 'No device' });
  }

  return (
    <Layout
      title="Live demo"
      description="Try DeckBridge in your browser with a mock deck or your real device over WebHID."
    >
      <main className={styles.playground}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Live demo</p>
            <h1>Try DeckBridge</h1>
            <p className={styles.lead}>Launch DeckBridge. Open its tray.</p>
          </div>
          <span className={styles.badge}>No install · Nothing saved</span>
        </header>
        <div
          className={styles.preview}
          onClick={() => setTrayOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setTrayOpen(false);
          }}
        >
          <div className={styles.menuBar}>
            <span>Desktop</span>
            <div className={styles.trayArea} onClick={(event) => event.stopPropagation()}>
              <span className={styles.trayLabel}>System tray</span>
              {running && (
                <button
                  className={styles.trayButton}
                  aria-label="DeckBridge tray"
                  aria-expanded={trayOpen}
                  aria-controls="demo-tray-menu"
                  title={tray.status}
                  onClick={() => setTrayOpen((open) => !open)}
                >
                  <img src={tray.icon} alt="" width={22} height={22} />
                </button>
              )}
              {trayOpen && (
                <div
                  className={styles.trayMenu}
                  id="demo-tray-menu"
                  role="group"
                  aria-label="DeckBridge tray menu"
                >
                  <strong>DeckBridge</strong>
                  <p role="status">Status: {tray.status}</p>
                  <hr />
                  <button onClick={() => {
                    setWindowOpen(true);
                    setTrayOpen(false);
                  }}>
                    Open Web UI
                  </button>
                  <hr />
                  <button onClick={quit}>Quit</button>
                </div>
              )}
            </div>
          </div>
          <div className={styles.desktop}>
            {!windowOpen && (
              <div className={styles.launcher}>
                <button
                  className={styles.appIcon}
                  aria-label="Run DeckBridge"
                  onClick={() => {
                    setRunning(true);
                    setTrayOpen(false);
                  }}
                >
                  <img src={appIcon} alt="" width={64} height={64} />
                  <span>DeckBridge</span>
                </button>
                {!running && (
                  <div className={styles.launchHint}>
                    <svg viewBox="0 0 72 48" fill="none" aria-hidden="true">
                      <path
                        d="M68 4Q60 38 8 38m10-9L8 38l10 9"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>Click to run DeckBridge</span>
                  </div>
                )}
              </div>
            )}
            {running && !windowOpen && !trayOpen && (
              <p className={styles.trayHint}>
                <span aria-hidden="true">↑</span> Click tray icon
              </p>
            )}
            {running && (
              <div className={styles.appWindow} hidden={!windowOpen}>
                <div className={styles.windowBar}>
                  <button aria-label="Close demo window" onClick={() => setWindowOpen(false)}>
                    ×
                  </button>
                  <span>DeckBridge · Web UI</span>
                </div>
                <iframe
                  ref={frame}
                  src={demoUrl}
                  title="DeckBridge demo"
                  allow="hid"
                  className={styles.frame}
                />
              </div>
            )}
          </div>
        </div>
        <dialog
          ref={pairedModal}
          className={styles.pairedModal}
          aria-labelledby="demo-paired-title"
          aria-describedby="demo-paired-message"
          onCancel={() => setPairedDevice(null)}
          onClose={() => setPairedDevice(null)}
        >
          <h2 id="demo-paired-title">Paired!</h2>
          <p id="demo-paired-message">
            Now you can control your <strong>{pairedDevice}</strong> buttons with the Elgato app.
          </p>
          <button onClick={() => setPairedDevice(null)}>Got it</button>
        </dialog>
      </main>
    </Layout>
  );
}
