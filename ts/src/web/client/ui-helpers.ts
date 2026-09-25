import type { ClientApp, DockUi, Status, TouchStripSize, UpdateInfo } from './ui-types.js';
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
    if (s.driverMode !== 'mock' && s.elgatoAppConflict && s.elgatoDevicePresent)
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
/** The version to show the topbar update dot for, or null to hide it —
 *  available, and not the version the user already dismissed. */
export function updateBadgeVersion(info: UpdateInfo | undefined): string | null {
  if (info?.updateAvailable !== true || info.latest === info.dismissedVersion) return null;
  return info.latest ?? null;
}

export function isMultiDockView(docks: DockUi[]): boolean {
  return docks.length > 1 || (docks.length === 1 && docks[0]!.index !== 0);
}

/** The selected dock's re-paired CORA profile — the single-dock views read the
 *  top-level status, which has no per-dock fields. */
export function selectedCoraProfile(s: Status): string | undefined {
  const selected = s.selectedDock ?? 0;
  return s.docks.find((d) => d.index === selected)?.coraProfile;
}

/** The selected dock's advertised touch strip, if its profile has one. */
export function selectedTouchStripSize(s: Status): TouchStripSize | undefined {
  const selected = s.selectedDock ?? 0;
  return s.docks.find((d) => d.index === selected)?.touchStripSize;
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
