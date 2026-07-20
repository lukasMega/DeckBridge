// Module-level handlers (no closure capture — hoisted out of components).
import { deeplink, showToast } from '../ui-helpers.js';

export function openSdApp(e: MouseEvent): void {
  e.preventDefault();
  deeplink('streamdeck://');
  showToast('Opening Elgato Stream Deck…');
}

export function quitElgatoApp(): void {
  deeplink('streamdeck://app/quit');
  showToast('Quit command sent — reconnect your Stream Deck if needed.');
}

// The Elgato app only re-dials docks on launch, so quit then relaunch to make
// it rediscover a dock that restarted while the app kept running.
export function restartElgatoApp(): void {
  deeplink('streamdeck://app/quit');
  showToast('Restarting Elgato app…');
  window.setTimeout(() => deeplink('streamdeck://open/mainwindow'), 1500);
}

export function switchToAdvanced(): void {
  document.documentElement.setAttribute('data-mode', 'advanced');
  localStorage.setItem('deckbridge.mode', 'advanced');
}

export function postBrightnessOverride(e: Event): void {
  fetch('/api/brightness-override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: (e.target as HTMLSelectElement).value === 'ignore' }),
  }).catch(() => undefined);
}
