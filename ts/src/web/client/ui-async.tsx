// The busy/status/error triple every settings-page action needs, plus the footer
// that renders it. `settings-error` / `settings-status` are styled in ui-simple.css.
import { useCallback, useState } from 'preact/hooks';

export interface AsyncAction {
  /** True while `run` is in flight — wire it to the buttons' `disabled`. */
  busy: boolean;
  status: string | null;
  error: string | null;
  /** Drop both messages, e.g. when the selection they described changes. */
  reset: () => void;
  /** Report a status mid-action. Only needed when the action keeps awaiting
   *  afterwards and a late status would outlive what it describes; otherwise
   *  just return the string from `run`. */
  setStatus: (status: string | null) => void;
  /** Clear the messages, run `fn`, and turn a thrown error or a returned string
   *  into the error/status message. */
  run: (fn: () => Promise<string | void>, fallback?: string) => Promise<void>;
}

export function useAsyncAction(): AsyncAction {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback((): void => {
    setStatus(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (fn: () => Promise<string | void>, fallback = 'Failed.'): Promise<void> => {
      setBusy(true);
      reset();
      try {
        const done = await fn();
        if (typeof done === 'string') setStatus(done);
      } catch (e) {
        setError((e as Error).message || fallback);
      } finally {
        setBusy(false);
      }
    },
    [reset],
  );

  return { busy, status, error, reset, setStatus, run };
}

/** Standard action footer: the error wins, so a stale status can't sit under it. */
export function Feedback({
  error,
  status,
}: Readonly<{ error: string | null; status: string | null }>): preact.JSX.Element {
  return (
    <>
      {error && <p class="settings-error">{error}</p>}
      {status && !error && <p class="settings-status">{status}</p>}
    </>
  );
}
