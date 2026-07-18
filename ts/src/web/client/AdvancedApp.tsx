/**
 * AdvancedApp — Preact replacement for the ADVANCED view (debug / power-user).
 *
 * Mounts into #advanced-view and reads from store.ts.
 *
 * Log consoles are UNCONTROLLED: Preact mounts the container refs once and
 * never re-renders them. An effect subscribes to the store and appends DOM
 * nodes via a rAF flush (ported verbatim from ui-logs.ts) so a burst of
 * 100 comm packets per image chunk costs one layout, not 100.
 *
 * The subcomponents below live in sibling files (file-size refactor, no
 * behavior change): advanced-header.tsx, advanced-key-grid.tsx,
 * advanced-mock-config.tsx, advanced-key-events.tsx, advanced-log-panel.tsx.
 * The key grid itself is the shared components/KeyGridPreview.tsx (same
 * component as the simple view's live preview, with the debug extras on).
 */
import { useStore } from './store.js';
import { AdvHeader } from './advanced-header.js';
import { DragResizer } from './advanced-key-grid.js';
import { MockConfigForm } from './advanced-mock-config.js';
import { KeyEventsPanel } from './advanced-key-events.js';
import { LogConsolePanel } from './advanced-log-panel.js';
import { SettingsPanel } from './advanced-settings-panel.js';
import { KeyGridPreview } from './components/KeyGridPreview.js';
import { Brightness } from './simple/controls.js';

function postKey(index: number): void {
  void fetch(`/api/key/${index}`, { method: 'POST' });
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

// ---------------------------------------------------------------------------
// AdvancedApp — top-level component
// ---------------------------------------------------------------------------

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
          <SettingsPanel />
          <KeyEventsPanel />
          <LogConsolePanel />
        </aside>
      </main>
    </>
  );
}
