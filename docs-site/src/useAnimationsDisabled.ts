import { useEffect, useState } from 'react';
import { ANIM_EVENT, animationsDisabled } from './animPref';

// Reactive "should motion be suppressed?" — true when the site's animations
// toggle (src/theme/Root) is on OR the OS `prefers-reduced-motion` is set.
// Re-renders on either signal. Use it to gate JS-driven animation (intervals,
// rAF loops, Web Animations) the same way the global CSS
// `@media (prefers-reduced-motion: reduce)` rule gates CSS animation.
export function useAnimationsDisabled(): boolean {
  const [disabled, setDisabled] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setDisabled(animationsDisabled() || mq.matches);
    sync();
    window.addEventListener(ANIM_EVENT, sync);
    mq.addEventListener('change', sync);
    return () => {
      window.removeEventListener(ANIM_EVENT, sync);
      mq.removeEventListener('change', sync);
    };
  }, []);
  return disabled;
}
