// Settings-page block for the push API: token admin + the live channel table.
// Values live in memory on the server; this panel only reads and clears them.
import { DocsLink } from '../components/DocsLink.js';
import { useEffect, useState } from 'preact/hooks';
import { Collapsible } from '../components/Collapsible.js';
import { TextInput } from '../components/Fields.js';
import { GhostButton } from '../components/GhostButton.js';
import { copyLabel, useCopyText } from '../lib/use-copy-text.js';
import { getJson, postJson } from '../lib/ui-api.js';
import { Feedback, useAsyncAction } from '../lib/ui-async.js';
import { patch, useStore } from '../lib/store.js';
import { useNow } from '../lib/ui-hooks.js';
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
      <GhostButton onClick={() => copy.copy(created.token)}>
        {copyLabel(copy.status, 'Copy')}
      </GhostButton>
      <GhostButton onClick={onClose}>Done</GhostButton>
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
            <GhostButton disabled={action.busy} onClick={() => rotate(t)}>
              Rotate
            </GhostButton>
            <GhostButton disabled={action.busy} onClick={() => revoke(t)}>
              Revoke
            </GhostButton>
          </li>
        ))}
      </ul>
      <Feedback error={action.error} status={action.status} />
    </>
  );
}

function ChannelTable({ channels }: Readonly<{ channels: PushChannelView[] }>): preact.JSX.Element {
  const now = useNow(channels.length > 0);
  const action = useAsyncAction();
  const [test, setTest] = useState({ channel: '', text: '' });
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
                  <GhostButton onClick={() => clear(c.channel)}>Clear</GhostButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div class="push-test">
        <TextInput
          placeholder="channel"
          aria-label="Push test channel"
          maxLength={32}
          value={test.channel}
          onChange={(channel) => setTest({ ...test, channel })}
        />
        <TextInput
          placeholder="text"
          aria-label="Push test text"
          value={test.text}
          onChange={(text) => setTest({ ...test, text })}
        />
        <GhostButton disabled={action.busy || !test.channel} onClick={send}>
          Send test
        </GhostButton>
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
        Let other tools write text onto side keys. <DocsLink topic="push-api" />
      </p>
      {created && <TokenReveal created={created} onClose={() => setCreated(null)} />}
      <TokenList tokens={tokens ?? []} onChanged={loadTokens} onCreated={setCreated} />
      <div class="push-test">
        <TextInput
          placeholder="token name"
          aria-label="New push token name"
          maxLength={NAME_MAX}
          value={name}
          onChange={setName}
        />
        <GhostButton disabled={action.busy || !name.trim()} onClick={create}>
          Create token
        </GhostButton>
      </div>
      <Feedback error={action.error} status={action.status} />
      <ChannelTable channels={channels} />
    </Collapsible>
  );
}
