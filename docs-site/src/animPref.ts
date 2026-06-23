// Shared "animations disabled" preference.
// CSS animations + transitions are killed site-wide via the `html.db-no-anim`
// class (see css/custom.css). JS-driven animations (RotatingWord) read this to
// freeze too. Root owns the <html> class + persistence and fires ANIM_EVENT on
// every toggle so subscribers re-sync.
export const ANIM_STORAGE_KEY = 'db-no-anim';
export const ANIM_EVENT = 'db-anim-change';

export function animationsDisabled(): boolean {
  return typeof window !== 'undefined' && localStorage.getItem(ANIM_STORAGE_KEY) === '1';
}
