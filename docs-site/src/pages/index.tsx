import { useEffect, useState, type ReactNode } from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './index.module.css';
import { RotatingWord } from './_home/RotatingWord';
import { BridgeMark } from './_home/BridgeMark';
import { Flow } from './_home/Flow';
import { Comparison } from './_home/Comparison';
import { FEATURES } from './_home/features';
import { GITHUB_URL, BRANDS, NETWORKS, DEVICES, STACK, HIGHLIGHTS } from './_home/content';

export default function Home(): ReactNode {
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (open === null) return;
    if (!window.matchMedia('(max-width: 900px)').matches) return;
    const id = setTimeout(
      () =>
        document
          .getElementById('feature-detail')
          ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
      0,
    );
    return () => clearTimeout(id);
  }, [open]);
  return (
    <Layout
      title="DeckBridge — USB Stream Deck over WiFi"
      description="Use a USB Stream Deck with the Elgato app over your local network. Free, standalone binary — no Network Dock, no Node.js."
    >
      <main className={styles.landing}>
        <div className={styles.inner}>
          {/* ---- hero ---- */}
          <section className={styles.hero}>
            <div className={styles.mark}>
              <BridgeMark />
            </div>
            <h1 className={styles.title}>
              USB buttons/keys:{' '}
              <span className={styles.accent}>
                <RotatingWord words={BRANDS} />
              </span>
              <br /> Stream D<RotatingWord words={['e', 'o']} fade />
              ck,{' '}
              <span className={styles.accent}>
                over <RotatingWord words={NETWORKS} interval={1_500} />.
              </span>
            </h1>
            <p className={styles.subtitle}>
              <strong>DeckBridge</strong> runs on your computer and appears to the Elgato app as a
              network device - your buttons work there. No Network Dock required.
            </p>
            <div className={styles.cta}>
              <Link className={styles.ctabtn} to="/getting-started">
                Get started
              </Link>
              <a className={styles.ghostbtn} href={GITHUB_URL} target="_blank" rel="noreferrer">
                GitHub ↗
              </a>
            </div>
            <div className={styles.trust}>
              <span>free</span>
              <span>&lt; 5 MB binary</span>
              <span>TypeScript + Rust</span>
              <span>
                no <RotatingWord words={['Node.js', 'Bun', 'Deno']} />
              </span>
              <span>
                no <code>sudo</code> required
              </span>
            </div>
          </section>

          {/* ---- how it works ---- */}
          <section className={`${styles.section} ${styles.reveal}`}>
            <p className={styles.sectionLabel}>How it works</p>
            <h2 className={styles.sectionTitle}>One bridge, two protocols</h2>
            <p className={styles.sectionLead}>
              DeckBridge speaks USB HID to your deck and emulates an Elgato Network Dock on the LAN.
              The app discovers it like real hardware.
            </p>
            <div className={styles.panel}>
              <Flow />
            </div>
            <p className={styles.flowCaption}>
              Key presses travel deck → DeckBridge → app. Button images travel back, resized and
              rotated to match your device before they're written over USB.
            </p>
          </section>

          {/* ---- features ---- */}
          <section className={`${styles.section} ${styles.reveal}`}>
            <p className={styles.sectionLabel}>Why</p>
            <h2 className={styles.sectionTitle}>What you can do with it</h2>
            <div className={styles.features}>
              {FEATURES.map((f, idx) => {
                const isOpen = open === idx;
                return (
                  <div className={styles.feature} data-open={isOpen} key={f.title}>
                    <div className={styles.featureIco}>{f.icon}</div>
                    <h3 className={styles.featureTitle}>{f.title}</h3>
                    <p className={styles.featureText}>{f.text}</p>
                    <button
                      type="button"
                      className={styles.learnBtn}
                      aria-expanded={isOpen}
                      aria-controls="feature-detail"
                      onClick={() => setOpen((o) => (o === idx ? null : idx))}
                    >
                      {isOpen ? 'Show less' : 'Learn more'}
                      <svg
                        className={styles.chev}
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M6 9l6 6 6-6"
                          stroke="currentColor"
                          strokeWidth="2.2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
            {open !== null && (
              <div
                className={styles.featureDetail}
                id="feature-detail"
                role="region"
                aria-label={FEATURES[open].title}
                key={open}
              >
                <div className={styles.detailAnim}>{FEATURES[open].anim}</div>
                <div className={styles.detailBody}>
                  <h3 className={styles.detailTitle}>{FEATURES[open].title}</h3>
                  <p className={styles.detailText}>{FEATURES[open].detail}</p>
                </div>
              </div>
            )}
          </section>

          {/* ---- comparison ---- */}
          <section className={`${styles.section} ${styles.reveal}`} id="compare">
            <p className={styles.sectionLabel}>Compare</p>
            <h2 className={styles.sectionTitle}>How it stacks up</h2>
            <p className={styles.sectionLead}>
              Against the official Network Dock and the closed app that ships with many non-Elgato
              decks.
            </p>
            <Comparison />
          </section>

          {/* ---- under the hood ---- */}
          <section className={`${styles.section} ${styles.reveal}`}>
            <p className={styles.sectionLabel}>Under the hood</p>
            <h2 className={styles.sectionTitle}>Built with</h2>
            <p className={styles.sectionLead}>
              One standalone binary: TypeScript logic and Rust image code compiled onto the txiki.js
              runtime. Nothing to install — no Node.js.
            </p>
            <div className={styles.compareWrap}>
              <div className={styles.compareGrid}>
                {STACK.map((s) => (
                  <div className={styles.compareCard} key={s.name}>
                    <div className={styles.compareCardHead}>
                      {s.href ? (
                        <a href={s.href} target="_blank" rel="noreferrer">
                          {s.name} ↗
                        </a>
                      ) : (
                        s.name
                      )}
                    </div>
                    <p className={styles.compareItemVal}>{s.role}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className={styles.devices}>
              {HIGHLIGHTS.map((h) => (
                <span className={styles.chip} key={h}>
                  {h}
                </span>
              ))}
            </div>
          </section>

          {/* ---- supported devices ---- */}
          <section className={`${styles.section} ${styles.reveal}`}>
            <p className={styles.sectionLabel}>Hardware</p>
            <h2 className={styles.sectionTitle}>Supported devices</h2>
            <div className={styles.devices}>
              {DEVICES.map((d) => (
                <span className={styles.chip} key={d}>
                  {d}
                </span>
              ))}
            </div>
            <p className={styles.devicesNote}>
              Hardware-tested on macOS: 293V3, 293S, K1 Pro, and Stream Deck Mini. MK.2 and the
              Linux / Windows builds are implemented but not hardware-verified.
            </p>
            <p className={styles.devicesNote}>
              No plans to add support for other Stream Deck-like devices (Mirabox, Ajazz, etc.).
            </p>
            <p className={styles.devicesNote}>
              Want to wire up your own device? <Link to="/adding-a-device">Adding a device →</Link>
            </p>
          </section>

          {/* ---- disclaimers (legal) ---- */}
          <section className={styles.notices}>
            <p className={styles.notice}>
              <strong>⚠ Not affiliated with Elgato / Corsair.</strong> "Stream Deck" and "Elgato"
              are trademarks of their respective owners. DeckBridge is for{' '}
              <strong>hobby and personal use only</strong> and <strong>does not replace</strong> the
              Elgato Network Dock. For professional or reliable setups, use officially supported
              Elgato hardware.
            </p>
            <p className={`${styles.notice} ${styles.noticeOk}`}>
              <strong>ℹ Nothing reverse-engineered.</strong> The USB HID and Elgato CORA protocol
              handling is reused from existing open-source projects - DeckBridge only wires that
              prior work together.
            </p>
          </section>
        </div>
      </main>
    </Layout>
  );
}
