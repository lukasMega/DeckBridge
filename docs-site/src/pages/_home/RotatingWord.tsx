import { useEffect, useState, type ReactNode } from 'react';
import styles from '../index.module.css';
import { useAnimationsDisabled } from '../../useAnimationsDisabled';

export function RotatingWord({ words }: { words: ReactNode[] }): ReactNode {
  const [i, setI] = useState(0);
  const frozen = useAnimationsDisabled();

  useEffect(() => {
    if (frozen) return; // hold on the current word while animations are off
    const id = setInterval(() => setI((n) => (n + 1) % words.length), 3_000);
    return () => clearInterval(id);
  }, [words.length, frozen]);
  return (
    <span className={styles.rotate}>
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
