/**
 * AdvancedApp — Preact ADVANCED view (debug / power-user). Mounts into
 * #advanced-view, reads store.ts. Log consoles are UNCONTROLLED: an effect
 * appends DOM nodes via a rAF flush, so a burst of 100 comm packets per image
 * chunk costs one layout, not 100.
 */
import { useStore } from '../lib/store.js';
import { AdvHeader } from './header.js';
import { DragResizer } from './key-grid.js';
import { MockConfigForm } from './mock-config.js';
import { KeyEventsPanel } from './key-events.js';
import { LogConsolePanel } from './log-panel.js';
import { KeyGridPreview } from '../components/KeyGridPreview.js';
import { Brightness } from '../simple/controls.js';
import { pressKey } from '../simple/handlers.js';
import { selectedCoraProfile } from '../ui-helpers.js';

// Thin layout wrapper so only this subtree re-renders on status changes;
// #grid-section stays because DragResizer targets it by id.
function AdvGridSection(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const keyPressEnabled = useStore((s) => s.keyPressEnabled);
  return (
    <div class="grid-section" id="grid-section">
      <KeyGridPreview
        keyCount={status.keyCount}
        columns={status.columns}
        dimmed={false}
        modelId={status.modelId}
        coraProfile={selectedCoraProfile(status)}
        label="Key grid"
        showIndex
        flash
        onKeyClick={pressKey}
        clickable={keyPressEnabled && status.elgatoConnected}
      />
    </div>
  );
}

// AdvancedApp — top-level component

export function AdvancedApp(): preact.JSX.Element {
  return (
    <>
      <AdvHeader />
      <main>
        <AdvGridSection />
        <DragResizer />
        <aside class="panels">
          <div class="panel">
            <Brightness />
          </div>
          {__MOCK_BUILD__ && <MockConfigForm />}
          <KeyEventsPanel />
          <LogConsolePanel />
        </aside>
      </main>
    </>
  );
}
