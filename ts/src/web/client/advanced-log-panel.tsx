/**
 * LogConsolePanel — Preact renders the chrome (tabs, filters, clear buttons) as
 * controlled JSX, but the log containers are UNCONTROLLED: populated via refs +
 * rAF flush, never by the reconciler. A filter change wipes and re-renders from
 * the store snapshot; new entries append incrementally, tracked by array index.
 */
import { useState, useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';
import { subscribe as storeSubscribe, getSnapshot } from './store.js';
import type { StoreState } from './store.js';
import type { ServerLog, CommLog } from './ui-types.js';
import { useCopyText } from './use-copy-text.js';

// Constants

const LOG_MAX = 2000;
const SCROLL_TOLERANCE = 4;

// Pure DOM-entry builders (mirrors ui-logs.ts)

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 23);
}

function buildServerEntry(e: ServerLog): HTMLElement {
  const sp = document.createElement('span');
  const levelClass: Record<string, string> = { error: 'le', warn: 'lw', info: 'li' };
  sp.className = levelClass[e.level] ?? 'li';
  sp.textContent = `[${fmtTime(e.ts)}] [${e.level.toUpperCase()}] [${e.component}] ${e.message}\n`;
  return sp;
}

function buildCommEntry(e: CommLog, showHex: boolean): HTMLElement {
  const hex = showHex && e.hex ? ` <span class="cx">${e.hex}…</span>` : '';
  const d = document.createElement('div');
  d.className = 'ce';
  d.innerHTML =
    `<span class="ct">${fmtTime(e.ts)}</span>` +
    ` <span class="cd cd-${e.direction}">${e.direction === 'rx' ? '↓' : '↑'}${e.direction.toUpperCase()}</span>` +
    ` <span class="cp cp-${e.protocol}">${e.protocol.toUpperCase()}</span>` +
    ` <span class="ch">${esc(e.human)}</span>${hex}`;
  return d;
}

// useLogPane — one uncontrolled, rAF-flushed log container

interface LogPaneOpts<T> {
  getLogs: (s: StoreState) => readonly T[];
  buildEntry: (e: T) => HTMLElement;
  passes: (e: T) => boolean;
  filterDeps: unknown[];
}

/**
 * Owns the DOM container for one log stream: incremental appends batched into a
 * DocumentFragment on rAF, scroll anchored to the bottom, trimmed to LOG_MAX, and
 * fully re-rendered when `filterDeps` change. Both log tabs are instances of this.
 */
function useLogPane<T, E extends HTMLElement>(
  opts: LogPaneOpts<T>,
): { ref: RefObject<E>; clear: () => void } {
  const elRef = useRef<E>(null);
  // Index of the last log entry rendered into the DOM (for incremental appends)
  const renderedRef = useRef(0);
  // rAF scheduling flag (mirrors ui-logs.ts serverFlushScheduled / commFlushScheduled)
  const scheduledRef = useRef(false);
  // Latest callbacks, so rAF flushes see current filter state without a stale closure
  // and without adding deps to the mount effect.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  function flush(): void {
    scheduledRef.current = false;
    const el = elRef.current;
    if (!el) return;
    const { getLogs, passes, buildEntry } = optsRef.current;
    const logs = getLogs(getSnapshot());
    const from = renderedRef.current;
    if (from >= logs.length) return;
    const atBot = el.scrollHeight - el.clientHeight <= el.scrollTop + SCROLL_TOLERANCE;
    const frag = document.createDocumentFragment();
    for (let i = from; i < logs.length; i++) {
      const e = logs[i];
      if (e !== undefined && passes(e)) frag.appendChild(buildEntry(e));
    }
    renderedRef.current = logs.length;
    el.appendChild(frag);
    while (el.children.length > LOG_MAX) el.removeChild(el.firstChild!);
    if (atBot) el.scrollTop = el.scrollHeight;
  }

  function schedule(): void {
    if (scheduledRef.current) return;
    scheduledRef.current = true;
    requestAnimationFrame(flush);
  }

  // Mount: initial render + subscribe for live appends
  useEffect(() => {
    schedule();
    let prevLen = optsRef.current.getLogs(getSnapshot()).length;
    return storeSubscribe(() => {
      const len = optsRef.current.getLogs(getSnapshot()).length;
      if (len !== prevLen) {
        prevLen = len;
        schedule();
      }
    });
    // eslint-disable-next-line @eslint-react/exhaustive-deps -- mount-only: schedule uses only refs and is effectively stable; adding it would re-subscribe on every render
  }, []);

  // Filter change: wipe the DOM and re-render from the snapshot
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    el.innerHTML = '';
    renderedRef.current = 0;
    schedule();
    // eslint-disable-next-line @eslint-react/exhaustive-deps -- deps are the caller's filter values; schedule uses only refs, so listing it would re-render every cycle
  }, opts.filterDeps);

  function clear(): void {
    const el = elRef.current;
    if (el) el.innerHTML = '';
    renderedRef.current = 0;
  }

  return { ref: elRef, clear };
}

function FilterCheck({
  id,
  label,
  checked,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}>): preact.JSX.Element {
  return (
    <label>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />{' '}
      {label}
    </label>
  );
}

// LogConsolePanel

export function LogConsolePanel(): preact.JSX.Element {
  const [activeTab, setActiveTab] = useState<'server' | 'comm'>('server');
  const { status: copyStatus, copy } = useCopyText();
  const copyLabel = { idle: 'Copy All', copied: 'Copied!', error: 'Copy failed' }[copyStatus];

  // Server filter state
  const [sfLevel, setSfLevel] = useState('');
  const [sfComponent, setSfComponent] = useState('');

  // Comm filter state
  const [cfProtocol, setCfProtocol] = useState('');
  const [cfDirection, setCfDirection] = useState('');
  const [cfHideImages, setCfHideImages] = useState(false);
  const [cfHideKeepalives, setCfHideKeepalives] = useState(false);
  const [cfShowHex, setCfShowHex] = useState(true);

  const server = useLogPane<ServerLog, HTMLPreElement>({
    getLogs: (s) => s.serverLogs,
    buildEntry: buildServerEntry,
    passes: (e) =>
      (!sfLevel || e.level === sfLevel) &&
      (!sfComponent || e.component.toLowerCase().includes(sfComponent.toLowerCase())),
    filterDeps: [sfLevel, sfComponent],
  });

  const comm = useLogPane<CommLog, HTMLDivElement>({
    getLogs: (s) => s.commLogs,
    buildEntry: (e) => buildCommEntry(e, cfShowHex),
    passes: (e) =>
      (!cfProtocol || e.protocol === cfProtocol) &&
      (!cfDirection || e.direction === cfDirection) &&
      !(cfHideImages && e.human.includes('image-data chunk')) &&
      !(cfHideKeepalives && e.human.includes('keepalive')),
    filterDeps: [cfProtocol, cfDirection, cfHideImages, cfHideKeepalives, cfShowHex],
  });

  // Copy all logs (same format as legacy ui-logs.ts)

  function handleCopyLogs(): void {
    const snap = getSnapshot();
    const sl = snap.serverLogs.map(
      (e) => `[${fmtTime(e.ts)}] [${e.level.toUpperCase()}] [${e.component}] ${e.message}`,
    );
    const cl = snap.commLogs.map((e) => {
      const arrow = e.direction === 'rx' ? '<--' : '-->';
      return `${fmtTime(e.ts)} ${arrow} ${e.protocol.toUpperCase()} ${e.human}${e.hex ? ' ' + e.hex : ''}`;
    });
    const text = `**SERVER LOGS:**\n\n${sl.join('\n')}\n\n---\n\n**COMM LOGS:**\n\n${cl.join('\n')}`;
    void copy(text);
  }

  const isServer = activeTab === 'server';

  return (
    <div class="panel log-panel">
      <div class="log-header">
        <div class="log-tabs">
          <button
            class={`ghostbtn tab-btn${isServer ? ' active' : ''}`}
            id="tab-server"
            type="button"
            onClick={() => setActiveTab('server')}
          >
            Server
          </button>
          <button
            class={`ghostbtn tab-btn${!isServer ? ' active' : ''}`}
            id="tab-comm"
            type="button"
            onClick={() => setActiveTab('comm')}
          >
            Comm
          </button>
          <button
            id="copy-logs"
            aria-live="polite"
            title={
              copyStatus === 'error' ? 'Copy failed. Select and copy logs manually.' : undefined
            }
            class="ghostbtn"
            type="button"
            style="margin-left: 8px"
            onClick={handleCopyLogs}
          >
            {copyLabel}
          </button>
        </div>
        <div id="server-filters" class="filter-row" style={{ display: isServer ? '' : 'none' }}>
          <select
            id="log-level-filter"
            class="input"
            value={sfLevel}
            onChange={(e) => setSfLevel((e.target as HTMLSelectElement).value)}
          >
            <option value="">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <input
            id="log-comp-filter"
            class="input"
            type="text"
            placeholder="component"
            maxLength={20}
            value={sfComponent}
            onInput={(e) => setSfComponent((e.target as HTMLInputElement).value)}
          />
          <button id="clr-log" class="ghostbtn" type="button" onClick={server.clear}>
            Clear
          </button>
        </div>
        <div id="comm-filters" class="filter-row" style={{ display: isServer ? 'none' : '' }}>
          <select
            id="comm-proto-filter"
            class="input"
            value={cfProtocol}
            onChange={(e) => setCfProtocol((e.target as HTMLSelectElement).value)}
          >
            <option value="">All</option>
            <option value="elgato">Elgato</option>
            <option value="mirabox">Mirabox</option>
          </select>
          <select
            id="comm-dir-filter"
            class="input"
            value={cfDirection}
            onChange={(e) => setCfDirection((e.target as HTMLSelectElement).value)}
          >
            <option value="">All dirs</option>
            <option value="rx">RX</option>
            <option value="tx">TX</option>
          </select>
          <FilterCheck
            id="hide-img"
            label="no img"
            checked={cfHideImages}
            onChange={setCfHideImages}
          />
          <FilterCheck
            id="hide-ka"
            label="no keepalive"
            checked={cfHideKeepalives}
            onChange={setCfHideKeepalives}
          />
          <FilterCheck id="show-hex" label="hex" checked={cfShowHex} onChange={setCfShowHex} />
          <button id="clr-comm" class="ghostbtn" type="button" onClick={comm.clear}>
            Clear
          </button>
        </div>
      </div>
      <div id="server-tab" class="log-content" style={{ display: isServer ? '' : 'none' }}>
        <pre id="log-console" ref={server.ref} />
      </div>
      <div id="comm-tab" class="log-content" style={{ display: isServer ? 'none' : '' }}>
        <div id="comm-console" ref={comm.ref} />
      </div>
    </div>
  );
}
