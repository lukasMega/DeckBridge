// Picks the pair screen or the deck from what the URL and storage hold, and moves between them.
import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { DeckByeReason } from '../../contract-deck.js';
import type { SocketLike } from './deck-socket.js';
import { DeckScreen } from './deck-screen.js';
import { PairScreen } from './pair-screen.js';
import { clearToken, parseHash, readToken, saveToken, tokenFragment } from './token-store.js';

interface Boot {
  token: string | null;
  pairCode?: string;
}

/** `#t=` (home-screen launch) wins and is stored; else the stored token; `#pair=` starts pairing. */
export function bootstrap(hash: string = location.hash): Boot {
  const params = parseHash(hash);
  if (params.token) {
    saveToken(params.token);
    return { token: params.token };
  }
  const stored = readToken();
  if (stored) return { token: stored };
  return { token: null, ...(params.pair ? { pairCode: params.pair } : {}) };
}

function setFragment(fragment: string): void {
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}${fragment}`);
  } catch {
    // old webviews: the stored token still works for this install
  }
}

export function DeckApp({
  createSocket,
}: Readonly<{ createSocket?: (url: string) => SocketLike }>): preact.JSX.Element {
  const [boot] = useState(bootstrap);
  const [token, setToken] = useState(boot.token);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  // A QR code is single use: drop it once the page has been through a pairing or a revoke.
  const [pairCode, setPairCode] = useState(boot.pairCode);

  function handlePaired(newToken: string): void {
    saveToken(newToken);
    // Keep the credential in the URL so "Add to Home Screen" on iOS carries it (plan D8).
    setFragment(tokenFragment(newToken));
    setToken(newToken);
    setNotice(undefined);
    setPairCode(undefined);
  }

  function handleUnauthorized(reason: DeckByeReason): void {
    clearToken();
    setFragment('');
    setNotice(
      reason === 'revoked'
        ? 'This device was removed in DeckBridge. Pair it again to continue.'
        : 'This device is not paired (any more). Pair it again to continue.',
    );
    setPairCode(undefined);
    setToken(null);
  }

  if (token)
    return (
      <DeckScreen
        token={token}
        onUnauthorized={handleUnauthorized}
        {...(createSocket ? { createSocket } : {})}
      />
    );
  return <PairScreen initialCode={pairCode} notice={notice} onPaired={handlePaired} />;
}

export function mountDeck(): void {
  const el = document.getElementById('deck');
  if (el) render(<DeckApp />, el);
}
