/**
 * AdvHeader — pills, brightness row, mode/model/resize/image-mode/anim, stats.
 *
 * Split out of AdvancedApp.tsx (file-size refactor, no behavior change).
 */
import { useState, useEffect, useRef } from 'preact/hooks';
import { useStore } from './store.js';
import type { DeviceModel } from './ui-types.js';

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

export function AdvHeader(): preact.JSX.Element {
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
          <span>Ignore Elgato brightness</span>
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
