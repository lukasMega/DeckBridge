// P per advertised CORA profile: how the Elgato app pre-orients an upright image before
// sending it. Derived from the hardware-tested models as P = T⁻¹ ∘ S (T = model.image
// rotate/flip, S = splash.transformOverride); see "Resolved questions" O1 in
// .claude/plans/2026-10-21_device-verify-wizard.md. test/verify-orientation.test.ts pins
// that every advertised profile has an entry.
import type { VerifyOrientation } from '../contract-verify.js';

const FRAME_ORIENTATION: Readonly<Record<string, VerifyOrientation>> = {
  mk2: { rotate: 180, flipH: false },
  mini: { rotate: 90, flipH: true },
  'stream-deck-plus': { rotate: 0, flipH: false },
};

/** P for an advertised profile id (`advertisedModel(model).id`), or undefined when unknown. */
export function frameOrientation(profileId: string): VerifyOrientation | undefined {
  const p = Object.hasOwn(FRAME_ORIENTATION, profileId) ? FRAME_ORIENTATION[profileId] : undefined;
  return p && { ...p };
}
