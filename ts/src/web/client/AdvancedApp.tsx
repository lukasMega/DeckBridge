/**
 * AdvancedApp — Preact replacement for the ADVANCED view (debug / power-user).
 *
 * Mounts into #advanced-view and reads from store.ts.
 *
 * Log consoles are UNCONTROLLED: Preact mounts the container refs once and
 * never re-renders them. An effect subscribes to the store and appends DOM
 * nodes via a rAF flush (ported verbatim from ui-logs.ts) so a burst of
 * 100 comm packets per image chunk costs one layout, not 100.
 */
import { useState, useEffect, useRef } from 'preact/hooks';
import { useStore, subscribe as storeSubscribe, getSnapshot } from './store.js';
import { KeyPreview } from './key-preview.js';
import type { ServerLog, CommLog, KeyEvent, DeviceModel } from './ui-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_MAX = 2000;
const SCROLL_TOLERANCE = 4;
const GRID_WIDTH_KEY = 'mira2el-grid-width';

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
// Uptime formatter (mirrors ui-status.ts)
// ---------------------------------------------------------------------------

function fmtUp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sc = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Module-level handlers (hoisted out of components — no closure capture)
// ---------------------------------------------------------------------------

function switchToSimple(): void {
  document.documentElement.setAttribute('data-mode', 'simple');
  localStorage.setItem('deckbridge.mode', 'simple');
}

function toggleResize(): void {
  void fetch('/api/resize-toggle', { method: 'POST' });
}

function handleImageModeChange(e: Event): void {
  void fetch('/api/image-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: (e.target as HTMLSelectElement).value }),
  });
}

function handleModelChange(e: Event): void {
  void fetch('/api/device-model', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: (e.target as HTMLSelectElement).value }),
  });
}

function handleBriIgnore(e: Event): void {
  void fetch('/api/brightness-override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: (e.target as HTMLInputElement).checked }),
  });
}

// ---------------------------------------------------------------------------
// AdvHeader — pills, brightness row, mode/model/resize/image-mode/anim, stats
// ---------------------------------------------------------------------------

function AdvHeader(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const stats = useStore((s) => s.stats);
  const brightness = useStore((s) => s.brightness);
  const brightnessOverride = useStore((s) => s.brightnessOverride);
  const resizeEnabled = useStore((s) => s.resizeEnabled);
  const imageMode = useStore((s) => s.imageMode);
  const deviceModels = useStore((s) => s.deviceModels);

  // Live uptime ticks locally from uptimeMs
  const [uptime, setUptime] = useState(() => fmtUp(stats.uptimeMs));
  // Initialized to 0; the stats.uptimeMs effect fires on mount (before the interval) and sets the real value.
  const uptimeBaseRef = useRef(0);
  const uptimeMsRef = useRef(stats.uptimeMs);

  useEffect(() => {
    uptimeMsRef.current = stats.uptimeMs;
    uptimeBaseRef.current = Date.now();
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- syncing display from server data; must stay in effect
    setUptime(fmtUp(stats.uptimeMs));
  }, [stats.uptimeMs]);

  useEffect(() => {
    const tid = setInterval(() => {
      setUptime(fmtUp(uptimeMsRef.current + (Date.now() - uptimeBaseRef.current)));
    }, 1000);
    return () => clearInterval(tid);
  }, []);

  // Anim toggle (local — not in store; body class side effect)
  const [animEnabled, setAnimEnabled] = useState(
    () => localStorage.getItem('animEnabled') !== 'false',
  );
  useEffect(() => {
    document.body.classList.toggle('no-anim', !animEnabled);
  }, [animEnabled]);

  function toggleMode(): void {
    const nm = status.driverMode === 'mock' ? 'real' : 'mock';
    void fetch('/api/driver-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: nm }),
    });
  }

  function toggleAnim(): void {
    const next = !animEnabled;
    setAnimEnabled(next);
    localStorage.setItem('animEnabled', String(next));
  }

  // MB pill derivation (mirrors ui-status.ts applyStatus)
  let mbPillClass = 'pill disconnected';
  let mbPillText = 'REAL · DISCONNECTED';
  let modeBtnText = 'Switch to Mock';
  let modeBtnExtraClass = '';
  if (status.driverMode === 'mock') {
    mbPillClass = 'pill mock-mode-pill';
    mbPillText = 'MOCK · ACTIVE';
    modeBtnText = 'Switch to Real Device';
    modeBtnExtraClass = 'mock-active';
  } else if (status.driverConnected) {
    mbPillClass = 'pill connected';
    mbPillText = 'REAL · CONNECTED';
  }

  const elPillClass = status.elgatoConnected ? 'pill connected' : 'pill disconnected';
  const elPillText = status.elgatoConnected
    ? `ELGATO · ${status.elgatoRemoteAddr ?? 'CONNECTED'}`
    : 'ELGATO · WAITING';

  const resizeBtnClass = resizeEnabled ? 'badge-on' : 'badge-off';
  const animBtnClass = animEnabled ? 'badge-on' : 'badge-off';
  const modelDisabled = status.driverMode === 'real' && status.driverConnected;

  return (
    <header>
      <button class="simple-back-btn" id="simpleBtn" type="button" onClick={switchToSimple}>
        ← Simple
      </button>
      <h1>DeckBr: advanced</h1>
      <span id="mb-pill" class={mbPillClass}>
        {mbPillText}
      </span>
      <span id="el-pill" class={elPillClass}>
        {elPillText}
      </span>
      <div class="bri-row">
        brightness
        <div class="bri-bar">
          <div class="bri-fill" id="bri-fill" style={{ width: `${brightness}%` }} />
        </div>
        <span id="bri-val">{brightness}%</span>
        <label class="bri-ignore">
          <input
            type="checkbox"
            id="bri-ignore-toggle"
            checked={brightnessOverride}
            onChange={handleBriIgnore}
          />
          <span>Ignore brightness from Elgato app</span>
        </label>
      </div>
      <button id="mode-toggle" type="button" class={modeBtnExtraClass} onClick={toggleMode}>
        {modeBtnText}
      </button>
      {deviceModels.length > 0 && (
        <select
          id="model-select"
          onChange={handleModelChange}
          disabled={modelDisabled}
          value={status.modelId ?? ''}
        >
          {deviceModels.map((m: DeviceModel) => (
            <option key={m.id} value={m.id}>
              {m.name} ({m.keyCount} key{m.keyCount !== 1 ? 's' : ''})
            </option>
          ))}
        </select>
      )}
      <button id="resize-toggle" type="button" class={resizeBtnClass} onClick={toggleResize}>
        {resizeEnabled ? 'R' : '1:1'}
      </button>
      <select
        id="image-mode"
        title="Image fit (experimental, applies to active driver)"
        onChange={handleImageModeChange}
        value={imageMode ?? 'default'}
      >
        <option value="default">Fit: Model default</option>
        <option value="resize">Fit: Resize</option>
        <option value="pad-black">Fit: Pad · Black</option>
        <option value="pad-average">Fit: Pad · Avg</option>
        <option value="pad-edge">Fit: Pad · Edge</option>
      </select>
      <button id="anim-toggle" type="button" class={animBtnClass} onClick={toggleAnim}>
        FX
      </button>
      <div id="stats-in-header" class="stats-row">
        <div class="si">
          <span class="sl">UPTIME</span>
          <span class="sv" id="s-up-hdr">
            {uptime}
          </span>
        </div>
        <div class="si">
          <span class="sl">RX</span>
          <span class="sv" id="s-rx-hdr">
            {stats.elgatoRxPkts}
          </span>
        </div>
        <div class="si">
          <span class="sl">TX</span>
          <span class="sv" id="s-tx-hdr">
            {stats.elgatoTxPkts}
          </span>
        </div>
        <div class="si">
          <span class="sl">IMGS</span>
          <span class="sv" id="s-img-hdr">
            {stats.imagesSent}
          </span>
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// AdvKeyGrid — advanced key grid (clickable in mock mode, shows index, flash)
// ---------------------------------------------------------------------------

function AdvKeyGrid(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const gridRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<KeyPreview | null>(null);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const kp = new KeyPreview(el, {
      showIndex: true,
      flash: true,
      onKeyClick: (i) => {
        void fetch(`/api/key/${i}`, { method: 'POST' });
      },
    });
    previewRef.current = kp;
    kp.rebuild(15, 5);
  }, []);

  useEffect(() => {
    const kp = previewRef.current;
    if (!kp) return;
    if (status.keyCount && status.columns) kp.rebuild(status.keyCount, status.columns);
    kp.setModel(status.modelId);
    kp.setClickable(status.driverMode === 'mock');
  }, [status.keyCount, status.columns, status.modelId, status.driverMode]);

  return (
    <div class="grid-section" id="grid-section">
      <div class="btn-grid" id="btn-grid" ref={gridRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DragResizer — the resize handle between grid section and panels
// ---------------------------------------------------------------------------

function DragResizer(): preact.JSX.Element {
  const resizerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const resizer = resizerRef.current;
    if (!resizer) return;

    const saved = localStorage.getItem(GRID_WIDTH_KEY);
    const gridSection = document.getElementById('grid-section');
    if (saved && gridSection) gridSection.style.width = `${saved}px`;

    let dragging = false;

    const onMouseDown = (e: MouseEvent): void => {
      const gs = document.getElementById('grid-section');
      if (!gs) return;
      dragging = true;
      resizer.classList.add('active');
      const startX = e.clientX;
      const startW = gs.getBoundingClientRect().width;
      const onMove = (ev: MouseEvent): void => {
        if (!dragging) return;
        const w = Math.max(50, startW + ev.clientX - startX);
        gs.style.width = `${w}px`;
        localStorage.setItem(GRID_WIDTH_KEY, String(Math.round(w)));
      };
      const onUp = (): void => {
        dragging = false;
        resizer.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      // eslint-disable-next-line @eslint-react/web-api-no-leaked-event-listener -- onMove/onUp remove themselves via onUp; the outer mousedown is cleaned up in the effect return
      document.addEventListener('mousemove', onMove);
      // eslint-disable-next-line @eslint-react/web-api-no-leaked-event-listener -- see above
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };

    resizer.addEventListener('mousedown', onMouseDown);
    return () => resizer.removeEventListener('mousedown', onMouseDown);
  }, []);

  return <div class="resize-handle" id="section-resizer" ref={resizerRef} />;
}

// ---------------------------------------------------------------------------
// MockConfigForm — collapsible device config panel
// ---------------------------------------------------------------------------

function MockConfigForm(): preact.JSX.Element {
  const mockConfig = useStore((s) => s.mockConfig);
  const status = useStore((s) => s.status);

  const [dockFw, setDockFw] = useState(mockConfig?.dockFirmwareVersion ?? '');
  const [dockSerial, setDockSerial] = useState(mockConfig?.serialNumber ?? '');
  const [childFw, setChildFw] = useState(mockConfig?.childFirmwareVersion ?? '');
  const [childSerial, setChildSerial] = useState(mockConfig?.childSerialNumber ?? '');
  const [childPid, setChildPid] = useState(
    () => `0x${(mockConfig?.productId ?? 0).toString(16).padStart(4, '0')}`,
  );
  const [mac, setMac] = useState(mockConfig?.macAddress ?? '02:00:00:00:00:01');
  const [open, setOpen] = useState(false);

  // Sync from store when mockConfig arrives / changes
  useEffect(() => {
    if (!mockConfig) return;
    // eslint-disable-next-line @eslint-react/set-state-in-effect -- controlled form fields must sync from external store; no other pattern applies here
    setDockFw(mockConfig.dockFirmwareVersion ?? '');
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setDockSerial(mockConfig.serialNumber ?? '');
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setChildFw(mockConfig.childFirmwareVersion ?? '');
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setChildSerial(mockConfig.childSerialNumber ?? '');
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setChildPid(`0x${(mockConfig.productId ?? 0).toString(16).padStart(4, '0')}`);
    // eslint-disable-next-line @eslint-react/set-state-in-effect
    setMac(mockConfig.macAddress ?? '02:00:00:00:00:01');
  }, [mockConfig]);

  function handleApply(): void {
    const pid = parseInt(childPid, 16);
    void fetch('/api/mock-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dockFirmwareVersion: dockFw,
        childFirmwareVersion: childFw,
        serialNumber: dockSerial,
        childSerialNumber: childSerial,
        productId: isNaN(pid) ? (mockConfig?.productId ?? 0) : pid,
        macAddress: mac.trim(),
      }),
    });
  }

  return (
    <div class="panel collapsible" id="mock-cfg-panel">
      <h3 class={`collapse-header${open ? '' : ' collapsed'}`} onClick={() => setOpen((o) => !o)}>
        <span>
          Device Config <span class="cfg-subtitle-hdr">(all modes)</span>
        </span>
        <span class="collapse-arrow">▼</span>
      </h3>
      <div id="mock-cfg-body" class={`collapse-body${open ? ' open' : ''}`}>
        <div class="cfg-grid">
          <strong>Dock (Network Dock)</strong>
          <label>Dock FW</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-dock-fw"
              type="text"
              maxLength={8}
              placeholder="1.01.014"
              value={dockFw}
              onInput={(e) => setDockFw((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setDockFw('1.01.014')}>
              1.01.014
            </button>
          </span>
          <label>Dock Serial</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-dock-serial"
              type="text"
              maxLength={20}
              placeholder="CL21K1A00001"
              value={dockSerial}
              onInput={(e) => setDockSerial((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setDockSerial('CL21K1A00001')}>
              CL21K1A00001
            </button>
          </span>
          <strong>
            Child (<span id="cfg-child-model-label">{status.modelName ?? 'Stream Deck MK.2'}</span>)
          </strong>
          <label>Child FW</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-child-fw"
              type="text"
              maxLength={8}
              placeholder="1.03.000"
              value={childFw}
              onInput={(e) => setChildFw((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setChildFw('1.03.000')}>
              1.03.000
            </button>
            <button class="cfg-preset" type="button" onClick={() => setChildFw('2.00.026')}>
              2.00.026
            </button>
          </span>
          <label>Child Serial</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-child-serial"
              type="text"
              maxLength={20}
              placeholder="A7FZA5191ILSNQ"
              value={childSerial}
              onInput={(e) => setChildSerial((e.target as HTMLInputElement).value)}
            />
            <button
              class="cfg-preset"
              type="button"
              onClick={() => setChildSerial('A7FZA5191ILSNQ')}
            >
              A7FZA5191ILSNQ
            </button>
            <button class="cfg-preset" type="button" onClick={() => setChildSerial('CL21K1A00001')}>
              CL21K1A00001
            </button>
          </span>
          <label>Child PID (hex)</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-child-pid"
              type="text"
              maxLength={6}
              placeholder="0x00a5"
              value={childPid}
              onInput={(e) => setChildPid((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setChildPid('0x00a5')}>
              0x00a5
            </button>
            <button class="cfg-preset" type="button" onClick={() => setChildPid('0x0080')}>
              0x0080
            </button>
          </span>
          <label>Dock MAC</label>
          <span class="cfg-inp-group">
            <input
              id="cfg-mac"
              type="text"
              maxLength={17}
              placeholder="02:00:00:00:00:01"
              value={mac}
              onInput={(e) => setMac((e.target as HTMLInputElement).value)}
            />
            <button class="cfg-preset" type="button" onClick={() => setMac('02:00:00:00:00:01')}>
              default
            </button>
          </span>
        </div>
        <button id="cfg-apply" type="button" onClick={handleApply}>
          Apply
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KeyEventsPanel — collapsible list of key events (≤50, plain .map is fine)
// ---------------------------------------------------------------------------

function KeyEventsPanel(): preact.JSX.Element {
  const keyEvents = useStore((s) => s.keyEvents);
  const [open, setOpen] = useState(true);

  return (
    <div class="panel collapsible">
      <h3 class={`collapse-header${open ? '' : ' collapsed'}`} onClick={() => setOpen((o) => !o)}>
        <span>Key Events</span>
        <span class="collapse-arrow">▼</span>
      </h3>
      <div id="key-events-body" class={`collapse-body${open ? ' open' : ''}`}>
        <div id="key-events">
          {keyEvents.map((e: KeyEvent) => {
            const t = new Date(e.ts).toISOString().slice(11, 23);
            return (
              <div key={`${e.ts}-${e.mk2Index}-${e.state}`} class="ke">
                {e.state === 'down' ? <span class="dn">↓</span> : <span class="up">↑</span>}
                <span>key {e.mk2Index}</span>
                <span class="kt">{t}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LogConsolePanel — UNCONTROLLED log consoles with rAF-batched DOM appends
//
// Architecture: Preact renders the chrome (tabs, filters, clear buttons) as
// normal controlled JSX. The <pre> and <div> log containers are uncontrolled:
// they are populated imperatively via refs + rAF flush, never by Preact's
// reconciler. This is plan §5 option 1.
//
// Filter changes trigger a full DOM wipe + re-render from store snapshot.
// New entries from the store are appended incrementally (tracked by array
// index so we never re-walk already-rendered entries).
// ---------------------------------------------------------------------------

function LogConsolePanel(): preact.JSX.Element {
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
            class={`tab-btn${isServer ? ' active' : ''}`}
            id="tab-server"
            type="button"
            onClick={() => setActiveTab('server')}
          >
            Server
          </button>
          <button
            class={`tab-btn${!isServer ? ' active' : ''}`}
            id="tab-comm"
            type="button"
            onClick={() => setActiveTab('comm')}
          >
            Comm
          </button>
          <button
            id="copy-logs"
            class="tab-btn"
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
            type="text"
            placeholder="component"
            maxLength={20}
            value={sfComponent}
            onInput={(e) => setSfComponent((e.target as HTMLInputElement).value)}
          />
          <button id="clr-log" type="button" onClick={handleClearServer}>
            Clear
          </button>
        </div>
        <div id="comm-filters" class="filter-row" style={{ display: isServer ? 'none' : '' }}>
          <select
            id="comm-proto-filter"
            value={cfProtocol}
            onChange={(e) => setCfProtocol((e.target as HTMLSelectElement).value)}
          >
            <option value="">All</option>
            <option value="elgato">Elgato</option>
            <option value="mirabox">Mirabox</option>
          </select>
          <select
            id="comm-dir-filter"
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
          <button id="clr-comm" type="button" onClick={handleClearComm}>
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

// ---------------------------------------------------------------------------
// AdvancedApp — top-level component
// ---------------------------------------------------------------------------

export function AdvancedApp(): preact.JSX.Element {
  return (
    <>
      <AdvHeader />
      <main>
        <AdvKeyGrid />
        <DragResizer />
        <aside class="panels">
          <MockConfigForm />
          <KeyEventsPanel />
          <LogConsolePanel />
        </aside>
      </main>
    </>
  );
}
