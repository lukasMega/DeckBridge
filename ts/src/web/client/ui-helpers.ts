import type { Status } from './ui-types.js';
import type { DeviceState } from './ui-state.js';

export function deriveState(s: Status): DeviceState {
  if (!s.driverConnected) {
    if (s.driverMode !== 'mock' && s.elgatoAppRunning) return 'no-device-elgato-conflict';
    return 'no-device';
  }
  if (!s.elgatoConnected) return 'device-no-elgato';
  return 'ready';
}

export function deeplink(url: string): void {
  const f = document.createElement('iframe');
  f.style.display = 'none';
  f.src = url;
  document.body.appendChild(f);
  window.setTimeout(() => f.remove(), 1200);
}

export function showToast(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  const tEl = t as HTMLElement & { _tid?: ReturnType<typeof setTimeout> };
  if (tEl._tid !== undefined) clearTimeout(tEl._tid);
  tEl._tid = setTimeout(() => t.classList.remove('show'), 2600);
}
