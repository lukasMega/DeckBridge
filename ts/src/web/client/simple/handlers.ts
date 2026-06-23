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

export function switchToAdvanced(): void {
  document.documentElement.setAttribute('data-mode', 'advanced');
  localStorage.setItem('deckbridge.mode', 'advanced');
}

export function postBrightnessOverride(e: Event): void {
  fetch('/api/brightness-override', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: (e.target as HTMLInputElement).checked }),
  }).catch(() => undefined);
}
