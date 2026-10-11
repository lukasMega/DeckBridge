// The backend and docs hook install before the WebUI boots on import.
import { backend } from './install.js';
// oxlint-disable-next-line import/no-unassigned-import -- boots the WebUI as a module side effect
import '../web/client/ui-entry.js';
import { mountBar } from './bar.js';
import { syncParentTheme } from './theme-sync.js';

const controlsHost = window.frameElement
  ? window.parent.document.getElementById('deckbridge-demo-controls')
  : null;
syncParentTheme(controlsHost ?? undefined);
if (controlsHost) {
  const shadow = controlsHost.shadowRoot ?? controlsHost.attachShadow({ mode: 'open' });
  const stylesheet = controlsHost.ownerDocument.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('./controls.css', window.location.href).href;
  const controls = controlsHost.ownerDocument.createElement('div');
  stylesheet.addEventListener('load', () => {
    const unmount = mountBar(controls, backend);
    window.addEventListener('pagehide', unmount, { once: true });
  });
  shadow.replaceChildren(stylesheet, controls);
  document.body.classList.add('demo-controls-external');
} else {
  const bar = document.getElementById('demo-bar');
  if (bar) mountBar(bar, backend);
}

function syncTray(): void {
  if (window.parent === window) return;
  window.parent.postMessage(
    {
      type: 'deckbridge-demo-status',
      plugged: backend.state.plugged,
      elgatoConnected: backend.state.elgatoConnected,
      modelName: backend.state.model.name,
    },
    window.location.origin,
  );
}
backend.onChange(syncTray);
syncTray();
