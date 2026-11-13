import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import Layout from '@theme/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './demo.module.css';
import appIcon from '../../../src-tauri/icons/128x128.png';
import trayDisconnected from '../../../rust/deckbridge-tray/icons/icon-disconnected.png';
import trayUsb from '../../../rust/deckbridge-tray/icons/icon-usb-only.png';
import trayFull from '../../../rust/deckbridge-tray/icons/icon-full.png';

export default function Demo(): ReactNode {
  const demoUrl = useBaseUrl('/demo-app/index.html');
  const downloadUrl = useBaseUrl('/getting-started/#latest-downloads');
  const frame = useRef<HTMLIFrameElement>(null);
  const pairedModal = useRef<HTMLDialogElement>(null);
  const wasPaired = useRef(false);
  const [running, setRunning] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const [tray, setTray] = useState({ icon: trayDisconnected, status: 'No device' });
  const [pairedDevice, setPairedDevice] = useState<string | null>(null);
  const [launchHintVisible, setLaunchHintVisible] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [wallpaper, setWallpaper] = useState<CSSProperties>();

  useEffect(() => {
    const size = 160 + Math.random() * 80;
    const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="110.852" viewBox="0 0 192 110.852">
      <defs><g id="hex" stroke="#1d283d" stroke-opacity=".3" stroke-width=".6">
        <path d="M0 0L64 0 32 55.426Z" fill="white" fill-opacity=".1"/>
        <path d="M0 0L32 55.426 -32 55.426Z" fill="white" fill-opacity=".04"/>
        <path d="M0 0L-32 55.426 -64 0Z" fill="black" fill-opacity=".12"/>
        <path d="M0 0L-64 0 -32 -55.426Z" fill="black" fill-opacity=".06"/>
        <path d="M0 0L-32 -55.426 32 -55.426Z" fill="white" fill-opacity=".02"/>
        <path d="M0 0L32 -55.426 64 0Z" fill="white" fill-opacity=".12"/>
      </g></defs>
      <use href="#hex" x="64" y="55.426"/>
      <use href="#hex" x="-32" y="0"/>
      <use href="#hex" x="-32" y="110.852"/>
      <use href="#hex" x="160" y="0"/>
      <use href="#hex" x="160" y="110.852"/>
    </svg>`;
    setWallpaper({
      '--wallpaper-pattern': `url("data:image/svg+xml,${encodeURIComponent(tile)}")`,
      '--wallpaper-size': `${size}px ${size * (110.852 / 192)}px`,
      '--wallpaper-x': `${20 + Math.random() * 60}%`,
      '--wallpaper-y': `${50 + Math.random() * 35}%`,
      '--wallpaper-angle': `${Math.random() * 360}deg`,
    } as CSSProperties);
  }, []);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (running) return;
    const timer = window.setTimeout(() => setLaunchHintVisible(true), 2000);
    return () => window.clearTimeout(timer);
  }, [running]);

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
    setLaunchHintVisible(false);
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
            <h1 className={styles.eyebrow}>Live demo</h1>
          </div>
        </header>
        <div
          className={styles.preview}
          onClick={() => setTrayOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setTrayOpen(false);
          }}
        >
          <div className={styles.menuBar} style={{ opacity: windowOpen ? 0.5 : 1 }}>
            <div className={styles.desktopLabel}>
              <span>Desktop</span>
              <p className={styles.lead}>Launch DeckBridge. Open its tray.</p>
            </div>
            <div className={styles.trayArea} onClick={(event) => event.stopPropagation()}>
              {running && (
                <div className={styles.trayIcon}>
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
                  {!windowOpen && !trayOpen && (
                    <p className={styles.trayHint}>
                      <span aria-hidden="true">↑</span> Click tray icon
                    </p>
                  )}
                </div>
              )}
              <time
                className={styles.trayClock}
                dateTime={now?.toISOString()}
                aria-label="Date and time"
              >
                <span>
                  {now?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                <span>
                  {now?.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </span>
              </time>
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
                  <button
                    className={styles.openWebUi}
                    onClick={() => {
                      setWindowOpen(true);
                      setTrayOpen(false);
                    }}
                  >
                    Open Web UI
                  </button>
                  <hr />
                  <button onClick={quit}>Quit</button>
                </div>
              )}
            </div>
          </div>
          <div className={styles.desktop} style={wallpaper}>
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
                {!running && launchHintVisible && (
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
            {running && (
              <div
                id="deckbridge-demo-controls"
                className={styles.controlsHost}
                hidden={!windowOpen}
              />
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
          <h2 id="demo-paired-title">Demo pairing complete</h2>
          <div id="demo-paired-message">
            <p>This demo cannot connect to the Elgato app.</p>
            <p>
              Run the native DeckBridge app on your PC to control your{' '}
              <strong>{pairedDevice}</strong> buttons with the Elgato app.
            </p>
            <p>
              <a href={downloadUrl}>Download DeckBridge</a>
            </p>
          </div>
          <button onClick={() => setPairedDevice(null)}>Got it</button>
        </dialog>
      </main>
    </Layout>
  );
}
