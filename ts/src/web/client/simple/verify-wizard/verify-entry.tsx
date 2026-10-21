// Ways into the verify wizard: the offer above an untested deck's preview and the
// device-tuning button. Both ask /api/verify/spec first, so they show only where it runs.
import type { VerifyDismissBody, VerifySpecResponse } from '../../../contract-verify.js';
import { GhostButton } from '../../components/GhostButton.js';
import { patch, useStore } from '../../lib/store.js';
import { fire, useFetched } from '../../lib/ui-api.js';
import type { DockUi } from '../../ui-types.js';
import { VerifyWizard } from './verify-modal.js';

/** Model ids are registry slugs; the model in the URL refetches on a model change. */
const useAvailable = (dockIndex: number, modelId: string): boolean =>
  useFetched<VerifySpecResponse>(`/api/verify/spec?dock=${dockIndex}&model=${modelId}`).data?.ok ===
  true;

const open = (dockIndex: number): void => patch({ verifyDock: dockIndex });

/** Mounted once beside the stages (SimpleApp). */
export function VerifyHost(): preact.JSX.Element | null {
  const dockIndex = useStore((s) => s.verifyDock);
  if (dockIndex === null) return null;
  return <VerifyWizard dockIndex={dockIndex} onClose={() => patch({ verifyDock: null })} />;
}

function Offer({ dock }: Readonly<{ dock: DockUi }>): preact.JSX.Element | null {
  if (!useAvailable(dock.index, dock.modelId)) return null;
  const dismiss = (never: boolean): void =>
    fire('/api/verify/dismiss', { modelId: dock.modelId, never } satisfies VerifyDismissBody);
  return (
    <div
      class="warnrow survey-nudge verify-offer"
      id={`verify-offer-${dock.index}`}
      role="region"
      aria-label="Device check"
    >
      <strong>Untested deck. Check its images?</strong>
      <span class="grow" />
      <GhostButton id={`verify-offer-start-${dock.index}`} onClick={() => open(dock.index)}>
        Check my device
      </GhostButton>
      <GhostButton onClick={() => dismiss(false)}>Not now</GhostButton>
      <GhostButton onClick={() => dismiss(true)}>Don't ask again</GhostButton>
    </div>
  );
}

/** Banner above a deck's preview: an untested model the user has not dismissed. */
export function VerifyOffer({ index }: Readonly<{ index: number }>): preact.JSX.Element | null {
  const dock = useStore((s) =>
    s.status.docks.find(
      (d) =>
        d.index === index && d.tested === false && !s.status.verifyDismissed?.includes(d.modelId),
    ),
  );
  // Offer only fetches the spec once the cheap checks pass.
  return dock ? <Offer dock={dock} /> : null;
}

/** Device tuning: the selected dock. */
export function VerifyButton({
  modelId,
}: Readonly<{ modelId: string }>): preact.JSX.Element | null {
  const dockIndex = useStore((s) => s.status.selectedDock);
  if (!useAvailable(dockIndex, modelId)) return null;
  return (
    <GhostButton id="tuning-verify" onClick={() => open(dockIndex)}>
      Check images step by step
    </GhostButton>
  );
}
