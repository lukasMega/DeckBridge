import type { ReactNode } from 'react';
import styles from '../index.module.css';

export type Feature = {
  title: string;
  text: string;
  detail: string | ReactNode;
  icon: ReactNode;
  anim: ReactNode;
};

export const FEATURES: Feature[] = [
  {
    title: 'Reuse a non-Elgato deck',
    text: 'Drive a Mirabox or Ajazz deck from the official Elgato app — it looks like genuine hardware.',
    detail: (
      <>
        Already own a Mirabox or Ajazz pad? The Elgato app sees it as genuine hardware — your
        existing profiles and plugins just work, with no firmware flashing and{' '}
        <a
          href="#compare"
          onClick={(e) => {
            e.preventDefault();
            const el = document.getElementById('compare');
            if (!el) return;
            const top = el.getBoundingClientRect().top + window.scrollY - 76;
            window.scrollTo({ top, behavior: 'smooth' });
          }}
        >
          no vendor tool
        </a>
        .
      </>
    ),
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 7h16v10H4zM8 4v3m8-3v3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    anim: (
      <svg className={styles.aWrap} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          className={styles.adraw}
          pathLength={1}
          d="M4 7h16v10H4z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className={styles.adraw}
          style={{ animationDelay: '0.55s' }}
          pathLength={1}
          d="M8 4v3m8-3v3"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: 'Save $70+ on the Network Dock',
    text: 'Skip the hardware dock — run this app instead and use a USB deck over WiFi.',
    detail:
      'The ~$70 Elgato Network Dock puts a deck on your network; DeckBridge does the same job in software for any supported USB deck.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M5 12a7 7 0 0114 0M8.5 12a3.5 3.5 0 017 0M12 12h.01"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    ),
    anim: (
      <svg className={styles.aWrap} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          className={styles.sig}
          style={{ animationDelay: '0.3s' }}
          d="M5 12a7 7 0 0114 0"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          className={styles.sig}
          style={{ animationDelay: '0.15s' }}
          d="M8.5 12a3.5 3.5 0 017 0"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle className={styles.sigDot} cx="12" cy="12" r="1.4" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: 'Skip opaque vendor software',
    text: 'Use supported decks without bundled software claiming broad system telemetry.',
    detail:
      "One bundled app's EULA permits collection of device, system, installed-app, and peripheral data, but provides no privacy-policy link and caps liability at $50. DeckBridge is open source and collects no data.",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3l7 3v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6zM9 12l2 2 4-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
    anim: (
      <svg className={styles.aWrap} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          className={styles.adraw}
          pathLength={1}
          d="M12 3l7 3v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          className={styles.adraw}
          style={{ animationDelay: '0.55s' }}
          pathLength={1}
          d="M9 12l2 2 4-5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: 'Hobby control surface',
    text: 'A budget board for personal streaming, shortcuts, and scene switching.',
    detail:
      'A budget deck plus DeckBridge gives you a tactile controller for OBS, media keys, and macros — aimed at hobby and home setups.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="2" />
        <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" fill="currentColor" opacity="0.9" />
        <rect
          x="4"
          y="13.5"
          width="6.5"
          height="6.5"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="2"
        />
        <rect
          x="13.5"
          y="13.5"
          width="6.5"
          height="6.5"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
    ),
    anim: (
      <svg className={styles.aWrap} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          className={styles.gCell}
          style={{ animationDelay: '0s' }}
          x="4"
          y="4"
          width="6.5"
          height="6.5"
          rx="1.5"
          fill="currentColor"
        />
        <rect
          className={styles.gCell}
          style={{ animationDelay: '0.5s' }}
          x="13.5"
          y="4"
          width="6.5"
          height="6.5"
          rx="1.5"
          fill="currentColor"
        />
        <rect
          className={styles.gCell}
          style={{ animationDelay: '0.75s' }}
          x="4"
          y="13.5"
          width="6.5"
          height="6.5"
          rx="1.5"
          fill="currentColor"
        />
        <rect
          className={styles.gCell}
          style={{ animationDelay: '0.25s' }}
          x="13.5"
          y="13.5"
          width="6.5"
          height="6.5"
          rx="1.5"
          fill="currentColor"
        />
      </svg>
    ),
  },
];
