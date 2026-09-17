// Shared browser-UI hooks. Keep this a leaf: web/client may import only
// web/client (boundaries G1), and nothing here may reach the server tier.
import { useEffect } from 'preact/hooks';

/**
 * Closes an overlay on Escape, and — when `anchorRef` is given — on a pointer
 * press outside that anchor. Popovers pass an anchor; full-page overlays (which
 * have nothing "outside" to click) pass none, so they keep Escape-only dismissal.
 */
export function useDismiss(onClose: () => void, anchorRef?: { current: HTMLElement | null }): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    if (!anchorRef) return () => window.removeEventListener('keydown', onKey);

    const onPointerDown = (e: PointerEvent): void => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose, anchorRef]);
}
