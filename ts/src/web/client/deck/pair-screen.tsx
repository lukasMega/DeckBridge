// Shown when the page has no token (or the server dropped it): trade a one-time code for one.
import { useEffect, useState } from 'preact/hooks';
import type { DeckPairRequest, DeckPairResponse } from '../../contract-deck.js';

export interface PairError {
  error?: string;
  code?: string;
}

/** Human text for a failed pair call; 429 carries the wait in `Retry-After` seconds. */
export function pairErrorMessage(status: number, body: PairError, retryAfter: number): string {
  if (status === 429) return `Too many attempts. Try again in ${retryAfter || 60} s.`;
  if (status === 403) return 'Wrong code. Check the 6 digits in DeckBridge and try again.';
  if (status === 410)
    return 'Code expired — create a new one in DeckBridge (Settings → Browser deck).';
  if (status === 409) return body.error ?? 'DeckBridge has too many paired devices.';
  return body.error ?? `Pairing failed (${status}).`;
}

export function guessDeviceName(
  ua: string = navigator.userAgent,
  touchPoints: number = navigator.maxTouchPoints || 0,
): string {
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  return 'Browser';
}

export async function submitPairing(
  req: DeckPairRequest,
): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  try {
    const r = await fetch('/deck/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const body = (await r.json().catch(() => ({}))) as PairError & Partial<DeckPairResponse>;
    if (r.ok && typeof body.token === 'string') return { ok: true, token: body.token };
    const retry = Number(r.headers.get('Retry-After')) || 0;
    return { ok: false, message: pairErrorMessage(r.status, body, retry) };
  } catch {
    return { ok: false, message: 'Could not reach DeckBridge. Check the Wi-Fi and the address.' };
  }
}

export function PairScreen({
  initialCode,
  notice,
  onPaired,
}: Readonly<{
  /** The long code from a scanned QR (`#pair=`): pairs without typing. */
  initialCode?: string;
  notice?: string;
  onPaired: (token: string) => void;
}>): preact.JSX.Element {
  const [shortCode, setShortCode] = useState('');
  const [name, setName] = useState(() => guessDeviceName());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pair(code: Pick<DeckPairRequest, 'code' | 'shortCode'>): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await submitPairing({ ...code, name });
    setBusy(false);
    if (res.ok) onPaired(res.token);
    else setError(res.message);
  }

  useEffect(function autoPairFromQr() {
    if (initialCode) void pair({ code: initialCode });
    // Once per mount: the code is single use.
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const valid = /^\d{6}$/.test(shortCode);
  function handleSubmit(e: Event): void {
    e.preventDefault();
    if (valid && !busy) void pair({ shortCode });
  }

  return (
    <form class="deck-pair" id="pair-screen" onSubmit={handleSubmit}>
      <h1>Pair this device</h1>
      <p>
        In DeckBridge open Settings → Browser deck → Pair a device, then scan the QR code or type
        the 6 digits.
      </p>
      {notice && <p class="deck-banner">{notice}</p>}
      <input
        class="deck-input"
        id="pair-code"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        autoComplete="off"
        placeholder="6-digit code"
        aria-label="6-digit code"
        value={shortCode}
        onInput={(e) => setShortCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))}
      />
      <input
        class="deck-input"
        id="pair-name"
        type="text"
        maxLength={40}
        aria-label="Device name"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
      />
      <button class="deck-button" id="pair-submit" type="submit" disabled={!valid || busy}>
        {busy ? 'Pairing…' : 'Pair'}
      </button>
      {error && (
        <p class="deck-error" id="pair-error">
          {error}
        </p>
      )}
    </form>
  );
}
