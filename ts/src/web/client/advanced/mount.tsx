import { render } from 'preact';
import { AdvancedApp } from './AdvancedApp.js';

export function mountAdvanced(): void {
  const root = document.getElementById('advanced-view');
  if (!root) return;
  render(<AdvancedApp />, root);
}
