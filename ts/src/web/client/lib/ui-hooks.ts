// Shared browser-UI hooks. Keep this a leaf: web/client may import only
// web/client (boundaries G1), and nothing here may reach the server tier.
import { useEffect, useLayoutEffect } from 'preact/hooks';

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

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const POPOVER_MARGIN = 8;

/** How far to move a popover so it stays inside `bounds`: `dx` sideways, and `down`
 *  = open below the anchor when the top is cut and there is more room below. */
export function popoverShift(pop: Box, anchor: Box, bounds: Box): { dx: number; down: boolean } {
  let dx = 0;
  if (pop.left < bounds.left + POPOVER_MARGIN) dx = bounds.left + POPOVER_MARGIN - pop.left;
  else if (pop.right > bounds.right - POPOVER_MARGIN) {
    dx = Math.max(
      bounds.right - POPOVER_MARGIN - pop.right,
      bounds.left + POPOVER_MARGIN - pop.left,
    );
  }
  const roomAbove = anchor.top - bounds.top;
  const roomBelow = bounds.bottom - anchor.bottom;
  return { dx, down: pop.top < bounds.top + POPOVER_MARGIN && roomBelow > roomAbove };
}

/**
 * Keeps a `.xkey-popover` (absolute, `right: 0`, opening upward) inside `.app`, which
 * clips with overflow:hidden — an anchor near the left edge would push it out of view.
 * Pass `content` when the popover's size changes after mount (e.g. loaded previews).
 */
export function useKeepInApp(ref: { current: HTMLElement | null }, content?: unknown): void {
  useLayoutEffect(
    function keepInApp() {
      const el = ref.current;
      const anchor = el?.parentElement;
      if (!el || !anchor) return;
      // Measure from the stylesheet position: `content` re-runs this as the size changes.
      el.style.right = '';
      el.style.top = '';
      el.style.bottom = '';
      const app = el.closest('.app')?.getBoundingClientRect();
      const bounds = app ?? {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      };
      const { dx, down } = popoverShift(
        el.getBoundingClientRect(),
        anchor.getBoundingClientRect(),
        bounds,
      );
      if (dx !== 0) el.style.right = `${-dx}px`;
      if (down) {
        el.style.bottom = 'auto';
        el.style.top = 'calc(100% + 6px)';
      }
    },
    [ref, content],
  );
}
