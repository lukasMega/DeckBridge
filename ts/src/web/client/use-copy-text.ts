import { useEffect, useRef, useState } from 'preact/hooks';

// How long the transient "Copied" / "Copy failed" label shows before reverting to idle.
// Failures revert on the same timer as successes: consumers *replace* their label with
// the status text (the address chip loses its "IP"/"Address" caption, the log button its
// "Copy All"), so an error that never cleared would erase that caption for good.
const STATUS_DWELL_MS = 1500;

export function useCopyText(): {
  status: 'idle' | 'copied' | 'error';
  copy: (text: string) => Promise<void>;
} {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current++;
      clearTimeout(timerRef.current);
    },
    [],
  );

  async function copy(text: string): Promise<void> {
    const id = ++requestRef.current;
    clearTimeout(timerRef.current);
    setStatus('idle');
    // Show the outcome, then always fall back to idle — an error that never cleared
    // would leave the consumer's label permanently replaced. The id check drops both
    // the outcome and the reset if a newer copy started or the hook unmounted (the
    // cleanup above bumps requestRef, so a pending timer can never outlive the hook).
    const settle = (next: 'copied' | 'error'): void => {
      if (id !== requestRef.current) return;
      setStatus(next);
      timerRef.current = setTimeout(() => {
        if (id === requestRef.current) setStatus('idle');
      }, STATUS_DWELL_MS);
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- clipboard is absent in insecure contexts
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      settle('copied');
    } catch {
      settle('error');
    }
  }

  return { status, copy };
}
