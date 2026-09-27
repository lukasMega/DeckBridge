/**
 * DragResizer — the resize handle between the grid section and the panels.
 * (The key grid itself is the shared components/KeyGridPreview.tsx now,
 * rendered by AdvancedApp inside #grid-section.)
 */
import { useEffect, useRef } from 'preact/hooks';

const GRID_WIDTH_KEY = 'mira2el-grid-width';

export function DragResizer(): preact.JSX.Element {
  const resizerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const resizer = resizerRef.current;
    if (!resizer) return;

    const saved = localStorage.getItem(GRID_WIDTH_KEY);
    const gridSection = document.getElementById('grid-section');
    if (saved && gridSection) gridSection.style.width = `${saved}px`;

    let dragging = false;

    const onMouseDown = (e: MouseEvent): void => {
      const gs = document.getElementById('grid-section');
      if (!gs) return;
      dragging = true;
      resizer.classList.add('active');
      const startX = e.clientX;
      const startW = gs.getBoundingClientRect().width;
      const onMove = (ev: MouseEvent): void => {
        if (!dragging) return;
        const w = Math.max(50, startW + ev.clientX - startX);
        gs.style.width = `${w}px`;
        localStorage.setItem(GRID_WIDTH_KEY, String(Math.round(w)));
      };
      const onUp = (): void => {
        dragging = false;
        resizer.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      // eslint-disable-next-line @eslint-react/web-api-no-leaked-event-listener -- onMove/onUp remove themselves via onUp; the outer mousedown is cleaned up in the effect return
      document.addEventListener('mousemove', onMove);
      // eslint-disable-next-line @eslint-react/web-api-no-leaked-event-listener -- see above
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };

    resizer.addEventListener('mousedown', onMouseDown);
    return () => resizer.removeEventListener('mousedown', onMouseDown);
  }, []);

  return <div class="resize-handle" id="section-resizer" ref={resizerRef} />;
}
