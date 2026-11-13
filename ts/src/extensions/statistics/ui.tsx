// Statistics extension, browser side: polls the snapshot route and renders it with the
// WebUI's own components (api.kit), so the page looks like the rest of the app.
import { useEffect, useState } from 'preact/hooks';
import type { ExtensionUiApi } from '../../extension/api.js';
import { bindHost } from '../sdk/preact-shim.js';
import type { DeckCounters, DeckStats, StatsSnapshot } from './contract.js';

const POLL_MS = 5000;
const TOP_KEYS = 5;
const CHART_BAR = 10;
const CHART_HEIGHT = 40;
/** Started this close to DeckBridge = counted from DeckBridge's start. */
const WITH_APP_MS = 10_000;

type Api = Readonly<{ api: ExtensionUiApi }>;

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${s}s`;
}

const count = (n: number): string => n.toLocaleString();

function minutesLabel(index: number, total: number): string {
  const ago = total - 1 - index;
  return ago === 0 ? 'Now (partial minute)' : `${ago} min ago`;
}

function ActivityChart({
  api,
  activity,
}: Api & Readonly<{ activity: number[] }>): preact.JSX.Element {
  const { VisuallyHidden } = api.kit;
  const max = Math.max(1, ...activity);
  const total = activity.reduce((sum, n) => sum + n, 0);
  return (
    <>
      <svg
        style={{ display: 'block', width: '100%', height: '64px', color: 'var(--accent)' }}
        role="img"
        aria-label={`Key presses per minute over the last ${activity.length} minutes: ${total} in total`}
        viewBox={`0 0 ${activity.length * CHART_BAR} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
      >
        {activity.map((n, i) => {
          const h = Math.max(1, (n / max) * CHART_HEIGHT);
          return (
            <rect
              // eslint-disable-next-line @eslint-react/no-array-index-key -- fixed-length series, position is the identity
              key={i}
              x={i * CHART_BAR + 1}
              y={CHART_HEIGHT - h}
              width={CHART_BAR - 2}
              height={h}
              fill="currentColor"
              opacity={n > 0 ? 1 : 0.25}
            />
          );
        })}
      </svg>
      {/* Clip a normal box: Firefox can paint a table caption outside the table's clip. */}
      <VisuallyHidden>
        <table>
          <caption>Key presses per minute</caption>
          <thead>
            <tr>
              <th scope="col">Minute</th>
              <th scope="col">Presses</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((n, i) => (
              // eslint-disable-next-line @eslint-react/no-array-index-key -- fixed-length series, position is the identity
              <tr key={i}>
                <th scope="row">{minutesLabel(i, activity.length)}</th>
                <td>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </VisuallyHidden>
    </>
  );
}

/** Top keys across the scope; the deck name is added only when it disambiguates. */
function topKeys(
  scope: DeckStats[],
  withDeck: boolean,
): { id: string; label: string; count: number }[] {
  return scope
    .flatMap((d) =>
      d.keys.map((k) => ({
        id: `${d.deviceKey}/${k.label}`,
        label: withDeck ? `${k.label} · ${d.modelName}` : k.label,
        count: k.count,
      })),
    )
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, TOP_KEYS);
}

function Report({
  api,
  data,
  error,
}: Api & Readonly<{ data: StatsSnapshot; error: string | null }>): preact.JSX.Element {
  const { Lead, ErrorText, Field, ChipRadioGroup, SectionLabel, List, Row, EmptyRow, StatusChip } =
    api.kit;
  const docks = api.useDocks();
  const [picked, setPicked] = useState('');
  const deck = data.decks.find((d) => d.deviceKey === picked);
  const scope = deck ? [deck] : data.decks;
  const c: DeckCounters = deck ?? data.totals;
  const measured = scope.some((d) => d.source === 'usb');
  const hitRate =
    measured && c.imagesProcessed > 0
      ? `${Math.round((c.cacheHits / c.imagesProcessed) * 100)}%`
      : '—';
  const keys = topKeys(scope, !deck && data.decks.length > 1);
  const since =
    data.startedAt - data.appStartedAt < WITH_APP_MS
      ? 'Since DeckBridge started'
      : 'Since Statistics was turned on';

  return (
    <>
      <Lead>
        {since} · {formatDuration(data.uptimeMs)}{' '}
        {data.decks.some((d) => d.source === 'mock') && (
          <StatusChip variant="dim">Simulated</StatusChip>
        )}
      </Lead>
      {error !== null && (
        <ErrorText>
          Could not refresh. Showing values from {new Date(data.at).toLocaleTimeString()}.
        </ErrorText>
      )}
      {data.decks.length > 1 && (
        <Field label="Deck">
          <ChipRadioGroup
            name="statsDeck"
            label="Deck"
            value={deck ? deck.deviceKey : ''}
            options={[
              { value: '', label: 'All decks' },
              ...data.decks.map((d) => ({ value: d.deviceKey, label: d.modelName })),
            ]}
            onChange={setPicked}
          />
        </Field>
      )}

      <SectionLabel>Usage</SectionLabel>
      <List>
        <Row label="Key presses" value={count(c.keyPresses)} />
        {scope.some((d) => d.hasEncoders) && (
          <Row
            label="Dial presses / detents"
            value={`${count(c.dialPresses)} / ${count(c.dialDetents)}`}
          />
        )}
        <Row
          label="Decks connected / paired"
          value={`${docks.length} / ${docks.filter((d) => d.elgatoConnected).length}`}
        />
        <Row label="Reconnects" value={count(c.reconnects)} />
      </List>

      <SectionLabel>Images</SectionLabel>
      <List>
        <Row label="Key images processed" value={measured ? count(c.imagesProcessed) : '—'} />
        <Row label="Cache hit rate" value={hitRate} />
      </List>

      <SectionLabel>Key activity · presses per minute, last 15 min</SectionLabel>
      <ActivityChart api={api} activity={c.activity} />

      <SectionLabel>Top keys</SectionLabel>
      <List>
        {keys.map((k) => (
          <Row key={k.id} label={k.label} value={count(k.count)} />
        ))}
        {keys.length === 0 && <EmptyRow>No key presses yet.</EmptyRow>}
      </List>
    </>
  );
}

function StatisticsView({ api }: Api): preact.JSX.Element {
  const [data, setData] = useState<StatsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    function pollStats() {
      const ctrl = new AbortController();
      function load(): void {
        api
          .getJson<StatsSnapshot>('snapshot', ctrl.signal)
          .then((snap) => {
            if (ctrl.signal.aborted) return undefined;
            setData(snap);
            setError(null);
            return undefined;
          })
          .catch((e: unknown) => {
            if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Request failed');
          });
      }
      function tick(): void {
        if (!document.hidden) load();
      }
      load();
      const timer = setInterval(tick, POLL_MS);
      return function stopPolling() {
        ctrl.abort();
        clearInterval(timer);
      };
    },
    [api],
  );

  if (data) return <Report api={api} data={data} error={error} />;
  const { Lead, ErrorText } = api.kit;
  return error === null ? <Lead>Loading…</Lead> : <ErrorText>Could not load statistics.</ErrorText>;
}

export function mount(el: HTMLElement, api: ExtensionUiApi): () => void {
  bindHost(api);
  api.preact.render(<StatisticsView api={api} />, el);
  return () => api.preact.render(null, el);
}
