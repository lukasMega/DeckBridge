// Settings-page block for the push API: token admin + the live channel table.
// Values live in memory on the server; this panel only reads and clears them.
import { useEffect, useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { copyLabel, useCopyText } from '../lib/use-copy-text.js';
import { getJson, postJson } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import { patch, useStore } from '../lib/store.js';
import type { PushChannelView, PushTokenCreated, PushTokenView } from '../ui-types.js';

const NAME_MAX = 40;

function expiresIn(ch: PushChannelView, now: number): string {
  if (ch.expiresAt === null) return 'never';
  const s = Math.round((ch.expiresAt - now) / 1000);
  return s <= 0 ? 'expired' : `${s}s`;
}

function TokenReveal({
  created,
  onClose,
}: Readonly<{ created: PushTokenCreated; onClose: () => void }>): preact.JSX.Element {
  const copy = useCopyText();
  return (
    <div class="push-reveal panel-inset">
      <p class="settings-status">Shown once — copy it now.</p>
      <code class="push-token">{created.token}</code>
      <button class="ghostbtn" type="button" onClick={() => void copy.copy(created.token)}>
        {copyLabel(copy.status, 'Copy')}
      </button>
      <button class="ghostbtn" type="button" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

function TokenList({
  tokens,
  onChanged,
  onCreated,
}: Readonly<{
  tokens: PushTokenView[];
  onChanged: () => Promise<void>;
  onCreated: (c: PushTokenCreated) => void;
}>): preact.JSX.Element {
  const action = useAsyncAction();
  const revoke = (t: PushTokenView): Promise<void> =>
    action.run(async () => {
      if (!confirm(`Revoke token "${t.name}"? Anything using it stops working.`)) return;
      await postJson(`/api/push-tokens/${t.id}/revoke`);
      await onChanged();
    });
  const rotate = (t: PushTokenView): Promise<void> =>
    action.run(async () => {
      onCreated(await postJson<PushTokenCreated>(`/api/push-tokens/${t.id}/rotate`));
      await onChanged();
    });
  return (
    <>
      {tokens.length === 0 && (
        <p class="multi-deck-note">No tokens — the push API rejects every call.</p>
      )}
      <ul class="push-tokens">
        {tokens.map((t) => (
          <li key={t.id}>
            <span class="push-token-name">{t.name}</span> <code>dbp_{t.prefix}…</code>
            <span class="multi-deck-note">
              {' '}
              {t.lastUsedAt
                ? `last used ${new Date(t.lastUsedAt).toLocaleTimeString()} (since start)`
                : 'unused'}
            </span>
            <button
              class="ghostbtn"
              type="button"
              disabled={action.busy}
              onClick={() => void rotate(t)}
            >
              Rotate
            </button>
            <button
              class="ghostbtn"
              type="button"
              disabled={action.busy}
              onClick={() => void revoke(t)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
      <Feedback error={action.error} status={action.status} />
    </>
  );
}

function ChannelTable({ channels }: Readonly<{ channels: PushChannelView[] }>): preact.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  const action = useAsyncAction();
  const [test, setTest] = useState({ channel: '', text: '' });
  const ticking = channels.length > 0;
  useEffect(
    function tickCountdown() {
      if (!ticking) return undefined;
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
    },
    [ticking],
  );
  const clear = (c: string): Promise<void> =>
    action.run(async () => {
      await postJson(`/api/push-channels/${encodeURIComponent(c)}/clear`);
    });
  const send = (): Promise<void> =>
    action.run(async () => {
      const channel = test.channel.trim().toLowerCase();
      await postJson(`/api/push-channels/${encodeURIComponent(channel)}`, {
        text: test.text,
        ttl: 60,
      });
      return 'Sent (60 s TTL).';
    });
  return (
    <>
      {channels.length === 0 ? (
        <p class="multi-deck-note">No values pushed since start.</p>
      ) : (
        <table class="push-channels">
          <tbody>
            {channels.map((c) => (
              <tr key={c.channel}>
                <td>{c.channel}</td>
                <td>{c.text.split('\n')[0]}</td>
                <td>{c.bound} bound</td>
                <td>{expiresIn(c, now)}</td>
                <td>
                  <button class="ghostbtn" type="button" onClick={() => void clear(c.channel)}>
                    Clear
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div class="push-test">
        <input
          class="input"
          type="text"
          placeholder="channel"
          aria-label="Push test channel"
          maxLength={32}
          value={test.channel}
          onInput={(e) => setTest({ ...test, channel: (e.target as HTMLInputElement).value })}
        />
        <input
          class="input"
          type="text"
          placeholder="text"
          aria-label="Push test text"
          value={test.text}
          onInput={(e) => setTest({ ...test, text: (e.target as HTMLInputElement).value })}
        />
        <button
          class="ghostbtn"
          type="button"
          disabled={action.busy || !test.channel}
          onClick={() => void send()}
        >
          Send test
        </button>
      </div>
      <Feedback error={action.error} status={action.status} />
    </>
  );
}

export function PushApiPanel(): preact.JSX.Element {
  const channels = useStore((s) => s.pushChannels);
  const [tokens, setTokens] = useState<PushTokenView[] | null>(null);
  const [created, setCreated] = useState<PushTokenCreated | null>(null);
  const [name, setName] = useState('');
  const action = useAsyncAction();

  const loadTokens = async (): Promise<void> => {
    const r = await getJson<{ tokens: PushTokenView[] }>('/api/push-tokens');
    // Browser-deck tokens (scope 'deck') are managed in the Browser deck panel.
    setTokens(r.tokens.filter((t) => t.scopes.includes('push')));
  };
  useEffect(function loadInitial() {
    void loadTokens().catch(() => undefined);
    void getJson<{ channels: PushChannelView[] }>('/api/push-channels')
      .then((r) => patch({ pushChannels: r.channels }))
      .catch(() => undefined);
  }, []);

  const create = (): Promise<void> =>
    action.run(async () => {
      setCreated(await postJson<PushTokenCreated>('/api/push-tokens', { name }));
      setName('');
      await loadTokens();
    });

  return (
    <Collapsible
      title="Push API"
      bodyId="push-api-body"
      status={tokens === null ? null : tokens.length > 0}
    >
      <p class="multi-deck-note">
        Let other tools write text onto side keys. Plain HTTP; reachable from the LAN only with
        --bind. See docs/push-api.md.
      </p>
      {created && <TokenReveal created={created} onClose={() => setCreated(null)} />}
      <TokenList tokens={tokens ?? []} onChanged={loadTokens} onCreated={setCreated} />
      <div class="push-test">
        <input
          class="input"
          type="text"
          placeholder="token name"
          aria-label="New push token name"
          maxLength={NAME_MAX}
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <button
          class="ghostbtn"
          type="button"
          disabled={action.busy || !name.trim()}
          onClick={() => void create()}
        >
          Create token
        </button>
      </div>
      <Feedback error={action.error} status={action.status} />
      <ChannelTable channels={channels} />
    </Collapsible>
  );
}
