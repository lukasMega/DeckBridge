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
 */
import { AdvHeader } from './advanced-header.js';
import { AdvKeyGrid, DragResizer } from './advanced-key-grid.js';
import { MockConfigForm } from './advanced-mock-config.js';
import { KeyEventsPanel } from './advanced-key-events.js';
import { LogConsolePanel } from './advanced-log-panel.js';
import { SettingsPanel } from './advanced-settings-panel.js';

// ---------------------------------------------------------------------------
// AdvancedApp — top-level component
// ---------------------------------------------------------------------------

export function AdvancedApp(): preact.JSX.Element {
  return (
    <>
      <AdvHeader />
      <main>
        <AdvKeyGrid />
        <DragResizer />
        <aside class="panels">
          <MockConfigForm />
          <SettingsPanel />
          <KeyEventsPanel />
          <LogConsolePanel />
        </aside>
      </main>
    </>
  );
}
