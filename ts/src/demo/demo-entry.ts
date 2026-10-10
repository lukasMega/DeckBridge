// Install the backend and docs hook before the WebUI boots on import.
import './install.js';
import '../web/client/ui-entry.js';
import { backend } from './install.js';
import { mountBar } from './bar.js';
import { syncParentTheme } from './theme-sync.js';

const bar = document.getElementById('demo-bar');
if (bar) mountBar(bar, backend);
syncParentTheme();

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
