import type { ReactNode } from 'react';
import styles from '../index.module.css';
import { GITHUB_URL } from './content';

type Step = { title: string; text: ReactNode };

const STEPS: Step[] = [
  {
    title: 'Download & run',
    text: (
      <>
        Grab the{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          release
        </a>{' '}
        for your OS, unzip, run <code>./deckbridge</code>.
      </>
    ),
  },
  {
    title: 'Plug in your deck',
    text: 'Connect a supported USB deck. macOS asks for Input Monitoring once.',
  },
  {
    title: 'Open the Elgato app',
    text: 'On any machine on the same LAN. The deck shows up like real Elgato hardware.',
  },
];

export function Quickstart(): ReactNode {
  return (
    <div className={styles.steps}>
      {STEPS.map((s, idx) => (
        <div className={styles.step} key={s.title}>
          <span className={styles.stepNum}>{idx + 1}</span>
          <h3 className={styles.stepTitle}>{s.title}</h3>
          <p className={styles.stepText}>{s.text}</p>
        </div>
      ))}
    </div>
  );
}
