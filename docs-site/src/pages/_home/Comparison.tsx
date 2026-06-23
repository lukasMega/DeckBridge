import type { ReactNode } from 'react';
import styles from '../index.module.css';

type Mark = 'yes' | 'no' | 'warn' | 'na';
type Cell = { mark: Mark; text: string };
type Row = { label: string; cells: [Cell, Cell, Cell] };

const COLUMNS = ['DeckBridge', 'Elgato Network Dock', "Deck's bundled app"];

const c = (mark: Mark, text: string): Cell => ({ mark, text });

const ROWS: Row[] = [
  {
    label: 'Cost',
    cells: [c('yes', 'Free'), c('na', '≈ $70 hardware'), c('na', 'Free download')],
  },
  {
    label: 'Source code',
    cells: [c('yes', 'Open, auditable'), c('no', 'Closed'), c('no', 'Closed binary')],
  },
  {
    label: 'Data collection',
    cells: [
      c('yes', 'None'),
      c('na', 'Per Elgato policy'),
      c('warn', 'Device, installed apps, peripherals — no privacy policy'),
    ],
  },
  {
    label: "Who's behind it",
    cells: [
      c('yes', 'Public GitHub repo'),
      c('yes', 'Elgato / Corsair'),
      c('warn', 'Anonymous vendor, .vip download domain'),
    ],
  },
  {
    label: 'Works in the Elgato app',
    cells: [c('yes', 'Yes'), c('yes', 'Yes (native)'), c('no', 'Its own app only')],
  },
  {
    label: 'Works in Bitfocus Companion',
    cells: [c('yes', 'Yes'), c('yes', 'Yes'), c('no', 'Its own app only')],
  },
  {
    label: 'Over WiFi / LAN',
    cells: [c('yes', 'Yes'), c('yes', 'Yes'), c('no', 'USB only')],
  },
  {
    label: 'If it breaks your PC',
    cells: [
      c('na', 'As-is, hobby use'),
      c('yes', 'Consumer warranty'),
      c('warn', 'Liability capped at $50, "as-is"'),
    ],
  },
];

const GLYPH: Record<Mark, string> = { yes: '✓', no: '✗', warn: '⚠', na: '–' };
const MARK_CLASS: Record<Mark, string> = {
  yes: styles.cellYes,
  no: '',
  warn: styles.cellWarn,
  na: '',
};

export function Comparison(): ReactNode {
  return (
    <div className={styles.compareWrap}>
      <div className={styles.compareGrid}>
        {COLUMNS.map((col, i) => (
          <div
            key={col}
            className={i === 0 ? `${styles.compareCard} ${styles.compareYou}` : styles.compareCard}
          >
            <div className={styles.compareCardHead}>{col}</div>
            <dl className={styles.compareList}>
              {ROWS.map((row) => {
                const cell = row.cells[i];
                return (
                  <div className={styles.compareItem} key={row.label}>
                    <dt className={styles.compareItemLabel}>{row.label}</dt>
                    <dd className={styles.compareItemVal}>
                      <span
                        className={`${styles.cellMark} ${MARK_CLASS[cell.mark]}`}
                        aria-hidden="true"
                      >
                        {GLYPH[cell.mark]}
                      </span>
                      {cell.text}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>
      <p className={styles.compareNote}>
        "Deck's bundled app" reflects red flags found in the EULA of one non-Elgato deck's Windows
        software: an anonymous publisher with no listed address, a <code>.vip</code> download
        domain, broad system telemetry with no privacy policy, and liability capped at $50.
        DeckBridge ships no EULA — the source is the contract.
      </p>
    </div>
  );
}
