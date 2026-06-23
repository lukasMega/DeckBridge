import type { ReactNode } from 'react';
import styles from '../index.module.css';

export function Flow(): ReactNode {
  return (
    <svg
      className={styles.flow}
      viewBox="0 0 640 150"
      role="img"
      aria-label="Data flow: USB Stream Deck to your computer running DeckBridge, then to the Elgato app or Bitfocus Companion over WiFi"
    >
      {/* wires */}
      <line className={styles.flowWire} x1="170" y1="75" x2="240" y2="75" />
      <line className={styles.flowWire} x1="400" y1="75" x2="470" y2="75" />
      <text className={styles.flowEdgeLabel} x="205" y="66" textAnchor="middle">
        USB
      </text>
      <text className={styles.flowEdgeLabel} x="435" y="66" textAnchor="middle">
        WiFi / LAN
      </text>

      {/* stream deck device glyph (above the first node) */}
      <g aria-hidden="true">
        <rect className={styles.deckBody} x="60" y="8" width="70" height="34" rx="6" />
        <rect className={styles.deckKey} x="67" y="14" width="14" height="8" rx="2" />
        <rect className={styles.deckKeyOn} x="88" y="14" width="14" height="8" rx="2" />
        <rect className={styles.deckKey} x="109" y="14" width="14" height="8" rx="2" />
        <rect className={styles.deckKey} x="67" y="28" width="14" height="8" rx="2" />
        <rect className={styles.deckKey} x="88" y="28" width="14" height="8" rx="2" />
        <rect className={styles.deckKey} x="109" y="28" width="14" height="8" rx="2" />
      </g>

      {/* boxes */}
      <rect className={styles.flowBox} x="20" y="48" width="150" height="54" rx="12" />
      <text className={styles.flowTitle} x="95" y="74" textAnchor="middle">
        USB Stream Deck
      </text>
      <text className={styles.flowSub} x="95" y="92" textAnchor="middle">
        Mirabox · Ajazz · Mini
      </text>

      <rect className={styles.flowBoxActive} x="240" y="48" width="160" height="54" rx="12" />
      <text className={styles.flowTitle} x="320" y="74" textAnchor="middle">
        DeckBridge
      </text>
      <text className={styles.flowAccent} x="320" y="92" textAnchor="middle">
        Your computer
      </text>

      <text className={styles.flowSub} x="545" y="34" textAnchor="middle">
        or Bitfocus Companion
      </text>
      <rect className={styles.flowBox} x="470" y="48" width="150" height="54" rx="12" />
      <text className={styles.flowTitle} x="545" y="74" textAnchor="middle">
        Elgato app
      </text>
      <text className={styles.flowOk} x="545" y="92" textAnchor="middle">
        ✓ accepts it
      </text>

      {/* packet 1: left → right (deck → app, x: 170 → 470) */}
      <circle className={styles.packet} cx="170" cy="75" r="5" />
      {/* packet 2: right → left (app → deck, x: 470 → 170) */}
      <circle className={`${styles.packet} ${styles.packet2}`} cx="470" cy="75" r="5" />
    </svg>
  );
}
