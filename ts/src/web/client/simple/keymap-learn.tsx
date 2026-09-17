// Key-map learn mode: walk the grid position by position, record the raw wire id
// each physical key reports, and derive `wireInputToCora` from what the hardware
// actually does.
//
// This is what closes an "images land on the wrong keys" report without a
// build-per-guess loop: only the person holding the board can produce the map, and
// the derived arrays are exactly what a registry PR needs.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore } from '../store.js';
import { copyLabel, useCopyText } from '../use-copy-text.js';
import { postJson } from '../ui-api.js';
import { Feedback } from '../ui-async.js';
import type { DeviceOverridesView, KeyEvent } from '../ui-types.js';

/** Grid geometry for the prompts. The server advertises rows/columns on the
 *  status snapshot; fall back to a single row if it is missing. */
function gridLabel(position: number, columns: number): string {
  const row = Math.floor(position / columns) + 1;
  const col = (position % columns) + 1;
  return `row ${row}, column ${col}`;
}

/** wire id → CORA index, as a dense array indexed BY WIRE ID. Gaps (wire ids no
 *  key reported) become -1, the same "ignored key" marker the registry uses for
 *  the 293S 6th column. Exported for the regression test: this array is what gets
 *  pasted into a registry PR, so its exact shape is the deliverable. */
export function deriveWireInputToCora(recorded: ReadonlyMap<number, number>): number[] {
  if (recorded.size === 0) return [];
  const maxWire = Math.max(...recorded.keys());
  const out: number[] = Array.from({ length: maxWire + 1 }, () => -1);
  for (const [wireId, coraIndex] of recorded) out[wireId] = coraIndex;
  return out;
}

interface Session {
  learning: boolean;
  position: number;
  recorded: Map<number, number>;
  error: string | null;
}

const IDLE: Session = { learning: false, position: 0, recorded: new Map(), error: null };

/** Fold one incoming key event into the session. Pure, so the recording rules
 *  ('down' only; a missing wireId aborts) are testable and the effect below stays
 *  a one-liner. Returns the same object when the event changes nothing. */
function record(session: Session, e: KeyEvent | undefined, seenTs: number): Session {
  // 'down' only: a press produces down+up, and recording both would advance two
  // positions per key.
  if (!session.learning || !e || e.state !== 'down' || e.ts <= seenTs) return session;
  if (e.wireId === undefined) {
    return {
      ...session,
      learning: false,
      error: 'This device reports no raw wire id — learn mode needs a real, key-mapped device.',
    };
  }
  return {
    ...session,
    recorded: new Map(session.recorded).set(e.wireId, session.position),
    position: session.position + 1,
  };
}

export function KeymapLearn({
  view,
  onSaved,
}: Readonly<{ view: DeviceOverridesView; onSaved: () => void }>): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const latestKeyEvent = useStore((s) => s.keyEvents[0]);
  const [session, setSession] = useState<Session>(() => IDLE);
  const [saved, setSaved] = useState(false);
  // Key events are a rolling buffer, so the newest entry is still there when
  // learn mode starts; remember the one we had at that moment and ignore it.
  const seenTsRef = useRef<number>(0);
  const copy = useCopyText();

  const keyCount = status.keyCount ?? 0;
  const columns = status.columns ?? keyCount;
  const { learning, position, recorded, error } = session;
  const done = learning && position >= keyCount;

  useEffect(() => {
    if (done) return;
    const seen = seenTsRef.current;
    if (latestKeyEvent && latestKeyEvent.ts > seen) seenTsRef.current = latestKeyEvent.ts;
    setSession((prev) => record(prev, latestKeyEvent, seen));
  }, [latestKeyEvent, done]);

  function start(): void {
    setSaved(false);
    seenTsRef.current = latestKeyEvent?.ts ?? 0;
    setSession({ ...IDLE, recorded: new Map(), learning: true });
  }

  function cancel(): void {
    setSession({ ...IDLE, recorded: new Map() });
  }

  async function save(): Promise<void> {
    setSession((prev) => ({ ...prev, error: null }));
    try {
      const wireInputToCora = deriveWireInputToCora(recorded);
      await postJson(
        '/api/device-overrides',
        {
          modelId: view.modelId,
          overrides: {
            ...view.overrides,
            // The derived array replaces `inputOffset` outright: the two are
            // alternative encodings of the same direction, and leaving a stale
            // offset alongside an explicit map is a trap for the next reader.
            keyMap: { ...view.overrides.keyMap, wireInputToCora, inputOffset: undefined },
          },
        },
        'Save failed',
      );
      setSaved(true);
      setSession((prev) => ({ ...prev, learning: false }));
      onSaved();
    } catch (e) {
      setSession((prev) => ({ ...prev, error: (e as Error).message || 'Save failed.' }));
    }
  }

  const derived = recorded.size > 0 ? deriveWireInputToCora(recorded) : [];
  const derivedJson = JSON.stringify({ wireInputToCora: derived }, null, 2);

  return (
    <>
      <p class="help-section-label">Key-map learn mode</p>
      <p class="help-lead">Fix misplaced key presses. Follow prompts to remap keys.</p>

      {!learning && (
        <div class="settings-actions">
          <button
            id="keymap-learn-start"
            class="ghostbtn"
            type="button"
            disabled={keyCount === 0}
            onClick={start}
          >
            Start learn mode
          </button>
        </div>
      )}

      {learning && !done && (
        <p class="settings-status" id="keymap-learn-prompt">
          Press the key at {gridLabel(position, columns)} ({position + 1} of {keyCount})
        </p>
      )}

      {learning && (
        <div class="settings-actions">
          <button id="keymap-learn-cancel" class="ghostbtn" type="button" onClick={cancel}>
            Cancel
          </button>
          {done && (
            <button
              id="keymap-learn-save"
              class="ghostbtn"
              type="button"
              onClick={() => void save()}
            >
              Save this map
            </button>
          )}
        </div>
      )}

      {derived.length > 0 && (
        <>
          <pre class="settings-json-preview panel-inset" id="keymap-learn-result">
            {derivedJson}
          </pre>
          <div class="settings-actions">
            <button class="ghostbtn" type="button" onClick={() => void copy.copy(derivedJson)}>
              {copyLabel(copy.status, 'Copy for a registry PR')}
            </button>
          </div>
        </>
      )}

      <Feedback error={error} status={saved ? 'Key map saved — the device reconnects…' : null} />
    </>
  );
}
