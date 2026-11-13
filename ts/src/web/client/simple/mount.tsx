import { render } from 'preact';
import { SimpleApp } from './SimpleApp.js';
import { BootScreen } from './boot-screen.js';

export function mountSimple(): void {
  const root = document.getElementById('simple-view');
  if (!root) return;
  render(<SimpleApp />, root);
}

export function mountBoot(failed: boolean, onRetry: () => void): void {
  const root = document.getElementById('simple-view');
  if (!root) return;
  render(<BootScreen failed={failed} onRetry={onRetry} />, root);
}
