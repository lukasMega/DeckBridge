/**
 * KeyEventsPanel — collapsible list of key events (≤50, plain .map is fine).
 *
 * Split out of AdvancedApp.tsx (file-size refactor, no behavior change).
 */
import { useStore } from './store.js';
import { Collapsible } from './components/Collapsible.js';
import type { KeyEvent } from './ui-types.js';

export function KeyEventsPanel(): preact.JSX.Element {
  const keyEvents = useStore((s) => s.keyEvents);

  return (
    <Collapsible class="panel" bodyId="key-events-body" title="Key Events" defaultOpen>
      <div id="key-events">
        {keyEvents.map((e: KeyEvent) => {
          const t = new Date(e.ts).toISOString().slice(11, 23);
          return (
            <div key={`${e.ts}-${e.mk2Index}-${e.state}`} class="ke">
              {e.state === 'down' ? <span class="dn">↓</span> : <span class="up">↑</span>}
              <span>key {e.mk2Index}</span>
              <span class="kt">{t}</span>
            </div>
          );
        })}
      </div>
    </Collapsible>
  );
}
