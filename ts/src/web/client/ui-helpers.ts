import type { ClientApp, DockUi, Status } from './ui-types.js';
import type { DeviceState } from './ui-state.js';

/** " to the Elgato app" / " to the Bitfocus Companion app" / "" — appended
 *  after "connected" in the ready-stage copy. Empty string (generic "connected
 *  and ready to use") when the client app couldn't be identified, rather than
 *  guessing wrong. */
export function clientAppName(app: ClientApp | undefined): string {
  if (app === 'elgato') return ' to the Elgato app';
  if (app === 'bitfocus') return ' to the Bitfocus Companion app';
  return '';
}

export function deriveState(s: Status): DeviceState {
  if (!s.driverConnected) {
    if (s.driverMode !== 'mock' && s.elgatoAppRunning && s.elgatoDevicePresent)
      return 'no-device-elgato-conflict';
    return 'no-device';
  }
  if (!s.elgatoConnected) return 'device-no-elgato';
  return 'ready';
}

/** True when `docks` must be rendered dock-aware rather than via the
 *  single-primary deriveState() wizard — either genuinely multiple docks, or
 *  a lone dock that isn't the primary (index 0): the primary disconnected
 *  while an extra dock is still live, which deriveState() can't see since it
 *  only reads the primary's own status fields. */
export function isMultiDockView(docks: DockUi[]): boolean {
  return docks.length > 1 || (docks.length === 1 && docks[0]!.index !== 0);
}

// Returns the multi-dock list when the server provides one; otherwise synthesizes
// a single-entry list from legacy top-level fields so the client keeps working
// against an older server bundle (dev skew between client/server builds).
export function deriveDocks(s: Status): DockUi[] {
  if (s.docks && s.docks.length > 0) return s.docks;
  if (!s.driverConnected) return [];
  const keyCount = s.keyCount ?? 15;
  const columns = s.columns ?? 5;
  return [
    {
      index: 0,
      modelId: s.modelId ?? '',
      modelName: s.modelName ?? 'Stream Deck MK.2',
      keyCount,
      columns,
      rows: Math.ceil(keyCount / columns),
      primaryPort: 5343,
      // Legacy server has no per-dock primary signal: child-connected implies
      // primary-connected; otherwise conservatively false.
      primaryConnected: s.elgatoConnected,
      elgatoConnected: s.elgatoConnected,
    },
  ];
}

export type ThemePref = 'light' | 'dark' | 'auto';

/** Mirrors the inline pre-paint script in ui.html — must stay in sync. */
export function getTheme(): ThemePref {
  const t = localStorage.getItem('deckbridge.theme');
  return t === 'light' || t === 'dark' ? t : 'auto';
}

export function setTheme(pref: ThemePref): void {
  if (pref === 'auto') localStorage.removeItem('deckbridge.theme');
  else localStorage.setItem('deckbridge.theme', pref);
  const dark =
    pref === 'dark' ||
    (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
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
