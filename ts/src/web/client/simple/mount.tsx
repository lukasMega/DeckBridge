import { render } from 'preact';
import { SimpleApp } from './SimpleApp.js';

export function mountSimple(): void {
  const root = document.getElementById('simple-view');
  if (!root) return;
  render(<SimpleApp />, root);
}
