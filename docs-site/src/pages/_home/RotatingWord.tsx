import { useEffect, useState, type ReactNode } from 'react';
import styles from '../index.module.css';
import { ANIM_EVENT, animationsDisabled } from '../../animPref';

export function RotatingWord({
  words,
  interval = 3_000,
  fade = false,
}: {
  words: ReactNode[];
  interval?: number;
  fade?: boolean;
}): ReactNode {
  const [i, setI] = useState(0);
  const [frozen, setFrozen] = useState(false);

  // Track the global animations-disabled preference (toggled in src/theme/Root).
  useEffect(() => {
    const sync = () => setFrozen(animationsDisabled());
    sync();
    window.addEventListener(ANIM_EVENT, sync);
    return () => window.removeEventListener(ANIM_EVENT, sync);
  }, []);

  useEffect(() => {
    if (frozen) return; // hold on the current word while animations are off
    const id = setInterval(() => setI((n) => (n + 1) % words.length), interval);
    return () => clearInterval(id);
  }, [words.length, interval, frozen]);
  return (
    <span className={`${styles.rotate}${fade ? ` ${styles.fade}` : ''}`}>
      {words.map((w, idx) => (
        <span
          key={idx}
          className={styles.rotateWord}
          data-active={idx === i}
          aria-hidden={idx !== i}
        >
          {w}
        </span>
      ))}
    </span>
  );
}
