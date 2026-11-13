// Module-level handlers (no closure capture — hoisted out of components).
import { deeplink, showToast } from '../ui-helpers.js';
import { fire, postJson } from '../lib/ui-api.js';

export function quitElgatoApp(): void {
  deeplink('streamdeck://app/quit');
  showToast('Quit command sent — reconnect your Stream Deck if needed.');
}

export function switchToAdvanced(): void {
  document.documentElement.setAttribute('data-mode', 'advanced');
  localStorage.setItem('deckbridge.mode', 'advanced');
}

export function postBrightnessOverride(e: Event): void {
  fire('/api/brightness-override', { enabled: (e.target as HTMLSelectElement).value === 'ignore' });
}

/** Press a key on the SELECTED dock from the preview. A 403 (feature off) shows the server's
 *  own message, since the toggle lives in Settings. */
export function pressKey(index: number): void {
  postJson(`/api/key/${index}`, undefined, 'Key press failed').catch((e: unknown) =>
    showToast((e as Error).message),
  );
}
