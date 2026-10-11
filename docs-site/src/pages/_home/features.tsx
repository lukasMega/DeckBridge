import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import styles from '../index.module.css';

export type Feature = {
  title: string;
  text: string;
  detail: string | ReactNode;
  anim: ReactNode;
};

export const FEATURES: Feature[] = [
  {
    title: 'Create a virtual browser deck',
    text: 'Turn your phone, tablet, or browser into a 15-key deck. Tap or hold to run Elgato actions — no USB hardware needed.',
    detail: (
      <>
        Enable Browser deck in Settings, pair your browser with a one-time code, then add the deck
        in the Elgato app. Set up actions there and use them from your phone, tablet, or computer on
        the same network. Connected browsers share one deck and profile.{' '}
        <Link to="/browser-deck">Set up a browser deck →</Link>
      </>
    ),
    anim: (
      <svg className={styles.aWrap} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          className={styles.adraw}
          pathLength={1}
          d="M7 2.5h10a2 2 0 012 2v15a2 2 0 01-2 2H7a2 2 0 01-2-2v-15a2 2 0 012-2z"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {[0, 1, 2].map((row) =>
          [0, 1, 2].map((column) => (
            <rect
              key={`${row}-${column}`}
              className={styles.gCell}
              style={{ animationDelay: `${(row + column) * 0.15}s` }}
              x={8 + column * 3}
              y={6 + row * 3}
              width="2"
              height="2"
              rx="0.5"
              fill="currentColor"
            />
          )),
        )}
        <path d="M10 18h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: 'Update key displays with an API',
    text: 'Send live text and colours from scripts, OBS, or Home Assistant to supported side keys and touch strip zones.',
    detail: (
      <>
        Assign a Push API channel to a display widget, create a token, and send text over HTTP or
        with the deckbridge push command. Choose colours and an expiry time for recording status,
        timers, or other live values. This updates displays; it does not trigger Elgato key actions.{' '}
        <Link to="/push-api">Explore the Push API →</Link>
      </>
    ),
    anim: (
      <svg className={styles.aWrap} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          className={styles.adraw}
          pathLength={1}
          d="M8 5H5a2 2 0 00-2 2v10a2 2 0 002 2h14a2 2 0 002-2v-3M13 3h8v8M21 3l-9 9"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className={styles.adraw}
          style={{ animationDelay: '0.55s' }}
          pathLength={1}
          d="M7 15h6"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: 'Make extra displays your own',
    text: 'Show clocks, weather, command output, or JavaScript widgets. Save layouts that follow your Elgato pages.',
    detail: (
      <>
        On supported decks, customise side keys and touch strip zones with live widgets, text
        styles, and colours. They keep updating while your browser is closed. Save a page-specific
        layout to switch widgets when the Elgato app changes pages or folders.{' '}
        <Link to="/side-keys">Build your display layout →</Link>
      </>
    ),
    anim: (
      <svg className={styles.aWrap} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          className={styles.adraw}
          pathLength={1}
          d="M3 4h18v16H3zM3 14h18M15 4v10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <circle cx="9" cy="9" r="3" stroke="currentColor" strokeWidth="1.5" />
        <path
          className={styles.adraw}
          style={{ animationDelay: '0.55s' }}
          pathLength={1}
          d="M9 7v2l1 1M17 8h2M6 17h12"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: 'Let your deck rest',
    text: 'Dim idle screens, schedule night brightness, and shift widgets to reduce static images on your displays.',
    detail: (
      <>
        Enable standby controls per deck: dim after inactivity, turn the screen off, or lower
        brightness overnight. Physical decks can show a moving clock when the Elgato app is away.
        Optional pixel shift moves DeckBridge widgets without changing Elgato key images.{' '}
        <Link to="/features#standby-and-burn-in-care">Configure standby and display care →</Link>
      </>
    ),
    anim: (
      <svg className={styles.aWrap} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          className={styles.adraw}
          pathLength={1}
          d="M19 14a8 8 0 01-9-11 9 9 0 109 11z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          className={styles.adraw}
          style={{ animationDelay: '0.55s' }}
          pathLength={1}
          d="M16 4v4M14 6h4M20 10v2M19 11h2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
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
