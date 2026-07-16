/**
 * AdvKeyGrid / DragResizer — advanced key grid and the resize handle beside it.
 *
 * Split out of AdvancedApp.tsx (file-size refactor, no behavior change).
 */
import { useEffect, useRef } from 'preact/hooks';
import { useStore } from './store.js';
import { KeyPreview } from './key-preview.js';

const GRID_WIDTH_KEY = 'mira2el-grid-width';

// ---------------------------------------------------------------------------
// AdvKeyGrid — advanced key grid (clickable in mock mode, shows index, flash)
// ---------------------------------------------------------------------------

export function AdvKeyGrid(): preact.JSX.Element {
  const status = useStore((s) => s.status);
  const gridRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<KeyPreview | null>(null);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const kp = new KeyPreview(el, {
      showIndex: true,
      flash: true,
      onKeyClick: (i) => {
        void fetch(`/api/key/${i}`, { method: 'POST' });
      },
    });
    previewRef.current = kp;
    kp.rebuild(15, 5);
  }, []);

  useEffect(() => {
    const kp = previewRef.current;
    if (!kp) return;
    if (status.keyCount && status.columns) kp.rebuild(status.keyCount, status.columns);
    kp.setModel(status.modelId);
    kp.setClickable(status.driverMode === 'mock');
  }, [status.keyCount, status.columns, status.modelId, status.driverMode]);

  return (
    <div class="grid-section" id="grid-section">
      <div class="btn-grid" id="btn-grid" ref={gridRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// DragResizer — the resize handle between grid section and panels
// ---------------------------------------------------------------------------

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
