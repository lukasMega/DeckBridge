/**
 * AdvancedApp — Preact ADVANCED view (debug / power-user). Mounts into
 * #advanced-view, reads store.ts. Log consoles are UNCONTROLLED: an effect
 * appends DOM nodes via a rAF flush, so a burst of 100 comm packets per image
 * chunk costs one layout, not 100.
 */
import { useStore } from './store.js';
import { AdvHeader } from './advanced-header.js';
import { DragResizer } from './advanced-key-grid.js';
import { MockConfigForm } from './advanced-mock-config.js';
import { KeyEventsPanel } from './advanced-key-events.js';
import { LogConsolePanel } from './advanced-log-panel.js';
import { KeyGridPreview } from './components/KeyGridPreview.js';
import { Brightness } from './simple/controls.js';
import { fire } from './ui-api.js';

function postKey(index: number): void {
  fire(`/api/key/${index}`);
}

// Thin layout wrapper so only this subtree re-renders on status changes;
// #grid-section stays because DragResizer targets it by id.
function AdvGridSection(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  return (
    <div class="grid-section" id="grid-section">
      <KeyGridPreview
        keyCount={status.keyCount ?? 15}
        columns={status.columns ?? 5}
        dimmed={false}
        modelId={status.modelId}
        label="Key grid"
        showIndex
        flash
        onKeyClick={postKey}
        clickable={status.driverMode === 'mock'}
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
          <MockConfigForm />
          <KeyEventsPanel />
          <LogConsolePanel />
        </aside>
      </main>
    </>
  );
}
