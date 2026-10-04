// Shown before the first /api/state snapshot: no store data exists yet, so this
// renders no stage and reads nothing from the store.
import { ICON, Icon } from '../components/Icon.js';

export function BootScreen({
  failed,
  onRetry,
}: Readonly<{ failed: boolean; onRetry: () => void }>): preact.JSX.Element {
  if (!failed) {
    return (
      <div class="app">
        <section class="stage" role="status">
          <div class="status-line">
            <span class="ico-spin" /> Connecting to DeckBridge…
          </div>
        </section>
      </div>
    );
  }
  return (
    <div class="app">
      <section class="stage" role="alert">
        <div class="conflict">
          <Icon class="conflict-badge circle" html={ICON.warn} />
          <h1>Cannot reach DeckBridge</h1>
          <p class="conflict-body">Check that DeckBridge is running, then retry.</p>
          <button class="ctabtn" type="button" onClick={onRetry}>
            Retry connection
          </button>
        </div>
      </section>
    </div>
  );
}
