// `deckbridge push`: a thin HTTP client for POST/DELETE /api/push/:channel. Never loads
// native libs or settings, and never opens HID.
import { isPushChannel, pushBodyError } from '../shared/push-text.js';
import { WEBUI_PORT } from '../shared/types.js';

export interface PushArgs {
  channel: string;
  text?: string;
  clear: boolean;
  ttl?: number;
  color?: string;
  background?: string;
  url: string;
  token: string;
}

type Env = Record<string, string | undefined>;

const VALUE_FLAGS = ['--ttl', '--color', '--background', '--url', '--token'];

interface RawPush {
  positional: string[];
  flags: Map<string, string>;
  clear: boolean;
}

function splitArgs(rest: string[]): RawPush | { error: string } {
  const raw: RawPush = { positional: [], flags: new Map(), clear: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--clear') raw.clear = true;
    else if (VALUE_FLAGS.includes(a)) {
      const v = rest[++i];
      if (v === undefined) return { error: `${a} requires a value` };
      raw.flags.set(a, v);
    } else if (a.startsWith('--')) return { error: `unknown flag '${a}'` };
    else raw.positional.push(a);
  }
  return raw;
}

function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

function usageError(raw: RawPush, text: string | undefined): string | null {
  if (raw.clear) return text === undefined ? null : '--clear takes no text';
  const ok = text !== undefined && raw.positional.length <= 2;
  return ok ? null : 'usage: deckbridge push <channel> <text>';
}

/** Pure: argv (after `push`) + env → args or a usage error. */
export function parsePushArgs(rest: string[], env: Env): PushArgs | { error: string } {
  const raw = splitArgs(rest);
  if ('error' in raw) return raw;
  const { positional, flags, clear } = raw;
  const channel = positional[0]?.toLowerCase();
  if (!isPushChannel(channel)) {
    return { error: 'channel must be 1–32 of a-z 0-9 . _ - (starting with a letter or digit)' };
  }
  const text = positional[1];
  const usage = usageError(raw, text);
  if (usage) return { error: usage };
  const token = flags.get('--token') ?? env.DECKBRIDGE_PUSH_TOKEN ?? '';
  if (!token) return { error: 'no token: set $DECKBRIDGE_PUSH_TOKEN or pass --token' };
  const base = flags.get('--url') ?? `http://127.0.0.1:${env.DECKBRIDGE_WEBUI_PORT ?? WEBUI_PORT}`;
  const args: PushArgs = {
    channel,
    text,
    clear,
    ttl: flags.has('--ttl') ? Number(flags.get('--ttl')) : undefined,
    color: flags.get('--color'),
    background: flags.get('--background'),
    url: trimTrailingSlashes(base),
    token,
  };
  const invalid = clear ? null : pushBodyError(pushBody(args));
  return invalid ? { error: invalid } : args;
}

function pushBody(a: PushArgs): Record<string, unknown> {
  return {
    text: a.text,
    ...(a.ttl !== undefined ? { ttl: a.ttl } : {}),
    ...(a.color !== undefined ? { color: a.color } : {}),
    ...(a.background !== undefined ? { background: a.background } : {}),
  };
}

/** Runs one request; returns the process exit code. `fetchImpl` is a test seam. */
export async function runPushCommand(
  rest: string[],
  fetchImpl: typeof fetch = fetch,
  env: Env = tjs.env,
): Promise<number> {
  const args = parsePushArgs(rest, env);
  if ('error' in args) {
    console.error(`deckbridge push: ${args.error}`);
    return 2;
  }
  const url = `${args.url}/api/push/${encodeURIComponent(args.channel)}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${args.token}` };
  let res: Response;
  try {
    res = args.clear
      ? await fetchImpl(url, { method: 'DELETE', headers })
      : await fetchImpl(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(pushBody(args)),
        });
  } catch (e) {
    console.error(`deckbridge push: cannot reach ${args.url} (${(e as Error).message})`);
    return 1;
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      // keep the status line
    }
    console.error(`deckbridge push: ${msg}`);
    return 1;
  }
  if (args.clear) return 0;
  const r = (await res.json()) as { replaced?: number; truncated?: boolean };
  const notes: string[] = [];
  if (r.replaced) notes.push(`${r.replaced} unsupported character(s) shown as ?`);
  if (r.truncated) notes.push('text truncated to 256 characters');
  if (notes.length > 0) console.error(`deckbridge push: ${notes.join('; ')}`);
  return 0;
}
