// Live preview tile for the Ulanzi D200 info window (clock / stats / dial / Elgato app). The firmware draws
// these itself, so this is text in the same wide shape, not its real look; the Widget content
// has the server-painted image tile instead (side-key-card.tsx).
import { useEffect, useState } from 'preact/hooks';
import { getJson } from '../lib/ui-api.js';
import type {
  WideKeyContent,
  WideKeyHourFormat,
  WideKeyLiveStats,
  WideKeyView,
} from '../../contract-wide-key.js';

const STATS_POLL_MS = 2000;

const pad = (n: number): string => String(n).padStart(2, '0');
const percent = (n: number | undefined): string => (n === undefined ? '—' : `${n}%`);

/** Fixed formatting, not toLocaleTimeString: the choice is the user's 12H/24H, not the browser's. */
export function formatClock(now: Date, format: WideKeyHourFormat): string {
  const hours = now.getHours();
  const time = `:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  if (format === '24H') return `${pad(hours)}${time}`;
  return `${hours % 12 || 12}${time} ${hours < 12 ? 'AM' : 'PM'}`;
}

function LiveClock({ format }: Readonly<{ format: WideKeyHourFormat }>): preact.JSX.Element {
  const [now, setNow] = useState(() => new Date());
  useEffect(function tick() {
    const timer = setInterval(function advance() {
      setNow(new Date());
    }, 1000);
    return function stop() {
      clearInterval(timer);
    };
  }, []);
  return <span class="wide-live-big">{formatClock(now, format)}</span>;
}

// The server reports the figures the device was last sent (host sampler + optional plugin).
function LiveStats(): preact.JSX.Element {
  const [stats, setStats] = useState<WideKeyLiveStats | undefined>();
  useEffect(function pollStats() {
    const ctrl = new AbortController();
    const load = function load(): void {
      getJson<WideKeyView>('/api/wide-key', ctrl.signal)
        .then((view) => {
          if (!ctrl.signal.aborted) setStats(view.stats);
          return undefined;
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, STATS_POLL_MS);
    return function stop() {
      ctrl.abort();
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      <span>CPU {percent(stats?.cpu)}</span>
      <span>MEM {percent(stats?.mem)}</span>
      {stats !== undefined && stats.gpu > 0 && <span>GPU {percent(stats.gpu)}</span>}
    </>
  );
}

export function WideKeyPreview({
  content,
  hourFormat,
}: Readonly<{
  content: WideKeyContent;
  hourFormat: WideKeyHourFormat;
}>): preact.JSX.Element {
  return (
    <div class="xkey-tile xkey-tile-wide" role="group" aria-label="Info window preview">
      <div class="wide-live">
        {content === 'clock' && <LiveClock format={hourFormat} />}
        {content === 'stats' && <LiveStats />}
        {content === 'dial' && <span class="wide-live-big">Dial</span>}
        {content === 'widget' && <span class="xkey-tile-empty">Widget</span>}
        {content === 'elgato' && <span class="xkey-tile-empty">Elgato app</span>}
      </div>
    </div>
  );
}
