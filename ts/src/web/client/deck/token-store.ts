// The phone's credential: localStorage plus the URL fragment. On iOS the home-screen app has
// storage separate from Safari, but "Add to Home Screen" copies the URL, so `#t=` carries
// the token across (plan D8). Fragments never reach the server or its logs.
export const TOKEN_KEY = 'deckbridge.deck.token';

export interface HashParams {
  pair?: string;
  token?: string;
}

/** Parses `#pair=<code>` / `#t=<token>`; unknown keys are ignored. */
export function parseHash(hash: string): HashParams {
  const out: HashParams = {};
  const body = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq);
    let value = part.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    if (value === '') continue;
    if (key === 'pair') out.pair = value;
    else if (key === 't') out.token = value;
  }
  return out;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>;

// Safari private mode and some embedded browsers throw on any storage access.
export function readToken(storage: ReadStorage | null = safeStorage()): string | null {
  try {
    return storage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveToken(token: string, storage: WriteStorage | null = safeStorage()): void {
  try {
    storage?.setItem(TOKEN_KEY, token);
  } catch {
    // keep going: the `#t=` fragment still carries it for this page
  }
}

export function clearToken(storage: WriteStorage | null = safeStorage()): void {
  try {
    storage?.removeItem(TOKEN_KEY);
  } catch {
    // nothing stored
  }
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The fragment that carries the token into a home-screen launch. */
export function tokenFragment(token: string): string {
  return `#t=${encodeURIComponent(token)}`;
}
