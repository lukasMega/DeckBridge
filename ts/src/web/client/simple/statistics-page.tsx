import { useEffect, useRef, useState } from 'preact/hooks';
import type { DeckCounters, DeckStats, StatsSnapshot } from '../../contract-stats.js';
import { ChipRadioGroup } from '../components/ChipRadioGroup.js';
import { IdentityRow } from '../components/IdentityRow.js';
import { StatusChip } from '../components/StatusChip.js';
import { useFetched } from '../lib/ui-api.js';
import { useDismiss } from '../lib/ui-hooks.js';
import { useStore } from '../lib/store.js';

const POLL_MS = 5000;
const TOP_KEYS = 5;
const CHART_BAR = 10;
const CHART_HEIGHT = 40;

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

function StatRow({
  label,
  value,
}: Readonly<{ label: string; value: string | number }>): preact.JSX.Element {
  const text = typeof value === 'number' ? value.toLocaleString() : value;
  return (
    <IdentityRow label={label}>
      <code class="identity-value">{text}</code>
    </IdentityRow>
  );
}

function minutesLabel(index: number, count: number): string {
  const ago = count - 1 - index;
  return ago === 0 ? 'Now (partial minute)' : `${ago} min ago`;
}

function ActivityChart({ activity }: Readonly<{ activity: number[] }>): preact.JSX.Element {
  const max = Math.max(1, ...activity);
  const total = activity.reduce((sum, n) => sum + n, 0);
  return (
    <>
      <svg
        class="stats-chart"
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
      <div class="visually-hidden">
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
      </div>
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
  data,
  error,
}: Readonly<{ data: StatsSnapshot; error: string | null }>): preact.JSX.Element {
  const docks = useStore((s) => s.status.docks);
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
  const simulated = __MOCK_BUILD__ && data.decks.some((d) => d.source === 'mock');

  return (
    <>
      <p class="help-lead">
        Since DeckBridge started · {formatDuration(data.uptimeMs)}{' '}
        {simulated && <StatusChip variant="dim">Simulated</StatusChip>}
      </p>
      {error !== null && (
        <p class="settings-error">
          Could not refresh. Showing values from {new Date(data.at).toLocaleTimeString()}.
        </p>
      )}
      {data.decks.length > 1 && (
        <div class="tuning-field">
          <span>Deck</span>
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
        </div>
      )}

      <p class="help-section-label">Usage</p>
      <ul class="identity-list panel-inset">
        <StatRow label="Key presses" value={c.keyPresses} />
        {scope.some((d) => d.hasEncoders) && (
          <StatRow
            label="Dial presses / detents"
            value={`${c.dialPresses.toLocaleString()} / ${c.dialDetents.toLocaleString()}`}
          />
        )}
        <StatRow
          label="Decks connected / paired"
          value={`${docks.length} / ${docks.filter((d) => d.elgatoConnected).length}`}
        />
        <StatRow label="Reconnects" value={c.reconnects} />
      </ul>

      <p class="help-section-label">Images</p>
      <ul class="identity-list panel-inset">
        <StatRow label="Key images processed" value={measured ? c.imagesProcessed : '—'} />
        <StatRow label="Cache hit rate" value={hitRate} />
      </ul>

      <p class="help-section-label">Key activity · presses per minute, last 15 min</p>
      <ActivityChart activity={c.activity} />

      <p class="help-section-label">Top keys</p>
      <ul class="identity-list panel-inset">
        {keys.map((k) => (
          <StatRow key={k.id} label={k.label} value={k.count} />
        ))}
        {keys.length === 0 && <li class="identity-label">No key presses yet.</li>}
      </ul>
    </>
  );
}

export function StatisticsPage({ onBack }: Readonly<{ onBack: () => void }>): preact.JSX.Element {
  const stats = useFetched<StatsSnapshot>('/api/stats');
  const headingRef = useRef<HTMLHeadingElement>(null);
  // `reload` is a fresh closure every render; the timer must not restart on each one.
  const reloadRef = useRef(stats.reload);
  reloadRef.current = stats.reload;

  useDismiss(onBack);
  useEffect(function focusHeading() {
    headingRef.current?.focus();
  }, []);
  useEffect(function pollStats() {
    function tick(): void {
      if (!document.hidden) void reloadRef.current();
    }
    const timer = setInterval(tick, POLL_MS);
    return function stopPolling() {
      clearInterval(timer);
    };
  }, []);

  return (
    <div class="help settings-page">
      <h1 ref={headingRef} tabIndex={-1}>
        Statistics
      </h1>
      {stats.data ? (
        <Report data={stats.data} error={stats.error} />
      ) : (
        <p class={stats.error === null ? 'help-lead' : 'settings-error'}>
          {stats.error === null ? 'Loading…' : 'Could not load statistics.'}
        </p>
      )}
    </div>
  );
}
