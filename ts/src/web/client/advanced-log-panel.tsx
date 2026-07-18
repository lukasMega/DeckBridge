/**
 * LogConsolePanel — UNCONTROLLED log consoles with rAF-batched DOM appends.
 *
 * Split out of AdvancedApp.tsx (file-size refactor, no behavior change).
 *
 * Architecture: Preact renders the chrome (tabs, filters, clear buttons) as
 * normal controlled JSX. The <pre> and <div> log containers are uncontrolled:
 * they are populated imperatively via refs + rAF flush, never by Preact's
 * reconciler. This is plan §5 option 1.
 *
 * Filter changes trigger a full DOM wipe + re-render from store snapshot.
 * New entries from the store are appended incrementally (tracked by array
 * index so we never re-walk already-rendered entries).
 */
import { useState, useEffect, useRef } from 'preact/hooks';
import { subscribe as storeSubscribe, getSnapshot } from './store.js';
import type { ServerLog, CommLog } from './ui-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_MAX = 2000;
const SCROLL_TOLERANCE = 4;

// ---------------------------------------------------------------------------
// Pure DOM-entry builders (mirrors ui-logs.ts)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildServerEntry(e: ServerLog): HTMLElement {
  const sp = document.createElement('span');
  const levelClass: Record<string, string> = { error: 'le', warn: 'lw', info: 'li' };
  sp.className = levelClass[e.level] ?? 'li';
  const t = new Date(e.ts).toISOString().slice(11, 23);
  sp.textContent = `[${t}] [${e.level.toUpperCase()}] [${e.component}] ${e.message}\n`;
  return sp;
}

function buildCommEntry(e: CommLog, showHex: boolean): HTMLElement {
  const t = new Date(e.ts).toISOString().slice(11, 23);
  const hex = showHex && e.hex ? ` <span class="cx">${e.hex}…</span>` : '';
  const d = document.createElement('div');
  d.className = 'ce';
  d.innerHTML =
    `<span class="ct">${t}</span>` +
    ` <span class="cd cd-${e.direction}">${e.direction === 'rx' ? '↓' : '↑'}${e.direction.toUpperCase()}</span>` +
    ` <span class="cp cp-${e.protocol}">${e.protocol.toUpperCase()}</span>` +
    ` <span class="ch">${esc(e.human)}</span>${hex}`;
  return d;
}

// ---------------------------------------------------------------------------
// LogConsolePanel
// ---------------------------------------------------------------------------

export function LogConsolePanel(): preact.JSX.Element {
  const [activeTab, setActiveTab] = useState<'server' | 'comm'>('server');
  const [copyLabel, setCopyLabel] = useState('Copy All');

  // Server filter state
  const [sfLevel, setSfLevel] = useState('');
  const [sfComponent, setSfComponent] = useState('');

  // Comm filter state
  const [cfProtocol, setCfProtocol] = useState('');
  const [cfDirection, setCfDirection] = useState('');
  const [cfHideImages, setCfHideImages] = useState(false);
  const [cfHideKeepalives, setCfHideKeepalives] = useState(false);
  const [cfShowHex, setCfShowHex] = useState(true);

  // DOM container refs (uncontrolled — Preact never touches their children)
  const logElRef = useRef<HTMLPreElement>(null);
  const commElRef = useRef<HTMLDivElement>(null);

  // Stable refs to current filter values for use inside rAF callbacks
  // Avoids stale-closure problem without adding deps to the mount effect.
  const sfRef = useRef({ level: '', component: '' });
  const cfRef = useRef({
    protocol: '',
    direction: '',
    hideImages: false,
    hideKeepalives: false,
    showHex: true,
  });

  useEffect(() => {
    sfRef.current = { level: sfLevel, component: sfComponent };
  }, [sfLevel, sfComponent]);

  useEffect(() => {
    cfRef.current = {
      protocol: cfProtocol,
      direction: cfDirection,
      hideImages: cfHideImages,
      hideKeepalives: cfHideKeepalives,
      showHex: cfShowHex,
    };
  }, [cfProtocol, cfDirection, cfHideImages, cfHideKeepalives, cfShowHex]);

  // Index of the last log entry rendered into the DOM (for incremental appends)
  const serverRenderedRef = useRef(0);
  const commRenderedRef = useRef(0);

  // rAF scheduling flags (mirrors ui-logs.ts serverFlushScheduled / commFlushScheduled)
  const serverFlushScheduledRef = useRef(false);
  const commFlushScheduledRef = useRef(false);

  // --- Filter predicates (read current filter state via ref) ---

  function passesServerFilter(e: ServerLog): boolean {
    const sf = sfRef.current;
    return (
      (!sf.level || e.level === sf.level) &&
      (!sf.component || e.component.toLowerCase().includes(sf.component.toLowerCase()))
    );
  }

  function passesCommFilter(e: CommLog): boolean {
    const cf = cfRef.current;
    return (
      (!cf.protocol || e.protocol === cf.protocol) &&
      (!cf.direction || e.direction === cf.direction) &&
      !(cf.hideImages && e.human.includes('image-data chunk')) &&
      !(cf.hideKeepalives && e.human.includes('keepalive'))
    );
  }

  // --- rAF flush functions (mirrors ui-logs.ts flushServerLogs / flushCommLogs) ---

  function flushServerLogs(): void {
    serverFlushScheduledRef.current = false;
    const logEl = logElRef.current;
    if (!logEl) return;
    const logs = getSnapshot().serverLogs;
    const from = serverRenderedRef.current;
    if (from >= logs.length) return;
    const atBot = logEl.scrollHeight - logEl.clientHeight <= logEl.scrollTop + SCROLL_TOLERANCE;
    const frag = document.createDocumentFragment();
    for (let i = from; i < logs.length; i++) {
      const e = logs[i];
      if (e !== undefined && passesServerFilter(e)) frag.appendChild(buildServerEntry(e));
    }
    serverRenderedRef.current = logs.length;
    logEl.appendChild(frag);
    while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild!);
    if (atBot) logEl.scrollTop = logEl.scrollHeight;
  }

  function flushCommLogs(): void {
    commFlushScheduledRef.current = false;
    const commEl = commElRef.current;
    if (!commEl) return;
    const logs = getSnapshot().commLogs;
    const from = commRenderedRef.current;
    if (from >= logs.length) return;
    const atBot = commEl.scrollHeight - commEl.clientHeight <= commEl.scrollTop + SCROLL_TOLERANCE;
    const frag = document.createDocumentFragment();
    const showHex = cfRef.current.showHex;
    for (let i = from; i < logs.length; i++) {
      const e = logs[i];
      if (e !== undefined && passesCommFilter(e)) frag.appendChild(buildCommEntry(e, showHex));
    }
    commRenderedRef.current = logs.length;
    commEl.appendChild(frag);
    while (commEl.children.length > LOG_MAX) commEl.removeChild(commEl.firstChild!);
    if (atBot) commEl.scrollTop = commEl.scrollHeight;
  }

  function scheduleServerFlush(): void {
    if (serverFlushScheduledRef.current) return;
    serverFlushScheduledRef.current = true;
    requestAnimationFrame(flushServerLogs);
  }

  function scheduleCommFlush(): void {
    if (commFlushScheduledRef.current) return;
    commFlushScheduledRef.current = true;
    requestAnimationFrame(flushCommLogs);
  }

  // --- Full wipe + re-render (called when filter state changes) ---

  function reRenderServerLogs(): void {
    const logEl = logElRef.current;
    if (!logEl) return;
    logEl.innerHTML = '';
    serverRenderedRef.current = 0;
    scheduleServerFlush();
  }

  function reRenderCommLogs(): void {
    const commEl = commElRef.current;
    if (!commEl) return;
    commEl.innerHTML = '';
    commRenderedRef.current = 0;
    scheduleCommFlush();
  }

  // --- Mount effect: initial render + subscribe for live log appends ---

  useEffect(() => {
    scheduleServerFlush();
    scheduleCommFlush();

    let prevServerLen = getSnapshot().serverLogs.length;
    let prevCommLen = getSnapshot().commLogs.length;

    const unsub = storeSubscribe(() => {
      const snap = getSnapshot();
      if (snap.serverLogs.length !== prevServerLen) {
        prevServerLen = snap.serverLogs.length;
        scheduleServerFlush();
      }
      if (snap.commLogs.length !== prevCommLen) {
        prevCommLen = snap.commLogs.length;
        scheduleCommFlush();
      }
    });

    return unsub;
    // eslint-disable-next-line @eslint-react/exhaustive-deps -- mount-only: scheduleServerFlush/scheduleCommFlush use only refs and are effectively stable; adding them would re-subscribe on every render
  }, []); // mount-only: flush fns and storeSubscribe are stable

  // --- Filter-change effects: wipe DOM and re-render with updated filter ---

  useEffect(() => {
    reRenderServerLogs();
    // eslint-disable-next-line @eslint-react/exhaustive-deps -- reRenderServerLogs uses only refs; adding it would re-render on every render cycle
  }, [sfLevel, sfComponent]); // re-render when server filters change

  useEffect(() => {
    reRenderCommLogs();
    // eslint-disable-next-line @eslint-react/exhaustive-deps -- reRenderCommLogs uses only refs; adding it would re-render on every render cycle
  }, [cfProtocol, cfDirection, cfHideImages, cfHideKeepalives, cfShowHex]); // re-render when comm filters change

  // --- Clear handlers ---

  function handleClearServer(): void {
    const logEl = logElRef.current;
    if (logEl) logEl.innerHTML = '';
    serverRenderedRef.current = 0;
  }

  function handleClearComm(): void {
    const commEl = commElRef.current;
    if (commEl) commEl.innerHTML = '';
    commRenderedRef.current = 0;
  }

  // --- Copy all logs (same format as legacy ui-logs.ts) ---

  function handleCopyLogs(): void {
    const snap = getSnapshot();
    const sl = snap.serverLogs.map((e) => {
      const t = new Date(e.ts).toISOString().slice(11, 23);
      return `[${t}] [${e.level.toUpperCase()}] [${e.component}] ${e.message}`;
    });
    const cl = snap.commLogs.map((e) => {
      const t = new Date(e.ts).toISOString().slice(11, 23);
      const arrow = e.direction === 'rx' ? '<--' : '-->';
      return `${t} ${arrow} ${e.protocol.toUpperCase()} ${e.human}${e.hex ? ' ' + e.hex : ''}`;
    });
    const text = `**SERVER LOGS:**\n\n${sl.join('\n')}\n\n---\n\n**COMM LOGS:**\n\n${cl.join('\n')}`;
    void navigator.clipboard.writeText(text).then(() => {
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy All'), 1500);
      return undefined;
    });
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
          <button id="clr-log" class="ghostbtn" type="button" onClick={handleClearServer}>
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
          <label>
            <input
              type="checkbox"
              id="hide-img"
              checked={cfHideImages}
              onChange={(e) => setCfHideImages((e.target as HTMLInputElement).checked)}
            />{' '}
            no img
          </label>
          <label>
            <input
              type="checkbox"
              id="hide-ka"
              checked={cfHideKeepalives}
              onChange={(e) => setCfHideKeepalives((e.target as HTMLInputElement).checked)}
            />{' '}
            no keepalive
          </label>
          <label>
            <input
              type="checkbox"
              id="show-hex"
              checked={cfShowHex}
              onChange={(e) => setCfShowHex((e.target as HTMLInputElement).checked)}
            />{' '}
            hex
          </label>
          <button id="clr-comm" class="ghostbtn" type="button" onClick={handleClearComm}>
            Clear
          </button>
        </div>
      </div>
      <div id="server-tab" class="log-content" style={{ display: isServer ? '' : 'none' }}>
        <pre id="log-console" ref={logElRef} />
      </div>
      <div id="comm-tab" class="log-content" style={{ display: isServer ? 'none' : '' }}>
        <div id="comm-console" ref={commElRef} />
      </div>
    </div>
  );
}
