import React, { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from '@docusaurus/router';
import { ANIM_EVENT, ANIM_STORAGE_KEY } from '../animPref';

// Click-to-fit lightbox for docs diagrams + reader sidebar controls.
// Covers markdown <img> AND inline mermaid <svg> (medium-zoom can't do SVG).
// Docusaurus auto-wraps the whole app with src/theme/Root — no swizzle eject needed.

type Preview = { kind: 'img'; src: string; alt: string } | { kind: 'svg'; html: string };

const readFlag = (k: string) => typeof window !== 'undefined' && localStorage.getItem(k) === '1';

export default function Root({ children }: { children: ReactNode }): ReactNode {
  const [preview, setPreview] = useState<Preview | null>(null);
  const close = useCallback(() => setPreview(null), []);

  // Delegated open: catch clicks on any doc image or mermaid diagram.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const el = e.target as HTMLElement | null;
      if (!el) return;

      const img = el.closest('.markdown img') as HTMLImageElement | null;
      if (img) {
        e.preventDefault();
        setPreview({ kind: 'img', src: img.currentSrc || img.src, alt: img.alt });
        return;
      }

      const host = el.closest('.docusaurus-mermaid-container') as HTMLElement | null;
      if (host) {
        const svg = host.querySelector('svg');
        if (svg) {
          const clone = svg.cloneNode(true) as SVGElement;
          clone.style.maxWidth = 'none'; // mermaid pins an inline max-width
          setPreview({ kind: 'svg', html: clone.outerHTML });
        }
      }
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  // Close on Esc / scroll, lock body scroll while open.
  useEffect(() => {
    if (!preview) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    window.addEventListener('wheel', close, { passive: true });
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', close);
      document.body.style.overflow = prev;
    };
  }, [preview, close]);

  // ---- Reader sidebar controls: hide + resize the doc nav and TOC ----
  const { pathname } = useLocation();
  const [onDoc, setOnDoc] = useState(false);
  const [hasToc, setHasToc] = useState(false);
  const [hideSidebar, setHideSidebar] = useState(() => readFlag('db-hide-sidebar'));
  const [hideToc, setHideToc] = useState(() => readFlag('db-hide-toc'));
  const [noAnim, setNoAnim] = useState(() => readFlag(ANIM_STORAGE_KEY));

  // Restore saved widths once on mount.
  useEffect(() => {
    const root = document.documentElement;
    const s = localStorage.getItem('db-sidebar-w');
    if (s) root.style.setProperty('--doc-sidebar-width', `${s}px`);
    const t = localStorage.getItem('db-toc-w');
    if (t) root.style.setProperty('--db-toc-width', `${t}px`);
  }, []);

  // Hide flags → <html> class + persist. Re-assert via a MutationObserver:
  // Docusaurus pushes per-page html classes through react-helmet-async, which
  // (defer:true) rewrites the whole <html> class attribute inside a rAF on every
  // client-side nav — a frame AFTER our effects run, so it wipes our classes and
  // the saved hidden state desyncs (button says hidden, panel shows). The observer
  // re-applies whenever the class attr changes, so we always get the last word.
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.classList.toggle('db-hide-sidebar', hideSidebar);
      root.classList.toggle('db-hide-toc', hideToc);
      root.classList.toggle('db-no-anim', noAnim);
    };
    apply();
    localStorage.setItem('db-hide-sidebar', hideSidebar ? '1' : '0');
    localStorage.setItem('db-hide-toc', hideToc ? '1' : '0');
    localStorage.setItem(ANIM_STORAGE_KEY, noAnim ? '1' : '0');
    // Let JS-driven animations (RotatingWord) freeze/resume in step.
    window.dispatchEvent(new Event(ANIM_EVENT));
    const obs = new MutationObserver(apply);
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, [hideSidebar, hideToc, noAnim]);

  // Is this a doc page, and does it render a desktop TOC? Probe DOM per route
  // (routeBasePath is '/', so the route alone can't tell docs from pages).
  useEffect(() => {
    const probe = () => {
      setOnDoc(!!document.querySelector('.theme-doc-sidebar-container'));
      const toc = document.querySelector('.theme-doc-toc-desktop');
      setHasToc(!!toc);
      // Tag the TOC column so custom.css can hide/resize it via a plain
      // descendant selector. A `:has()` rule keyed on the persistent
      // <html class="db-hide-toc"> is NOT re-evaluated for the fresh TOC col
      // React mounts on client-side navigation (the trigger class never
      // changed), so the carried-over hidden state wouldn't apply.
      toc?.closest('.col')?.classList.add('db-toc-col');
    };
    probe();
    const id = requestAnimationFrame(probe); // catch late layout
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  // Inject a drag handle into each visible panel; drag updates a CSS width var.
  useEffect(() => {
    if (!onDoc) return;
    const root = document.documentElement;
    const cleanups: Array<() => void> = [];

    const attach = (
      host: HTMLElement,
      edge: 'left' | 'right',
      cssVar: string,
      storageKey: string,
      sign: 1 | -1,
      min: number,
      max: number,
      fallback: number,
    ) => {
      const handle = document.createElement('div');
      handle.className = `db-resizer db-resizer--${edge}`;
      host.style.position = 'relative';
      host.appendChild(handle);

      let startX = 0;
      let startW = 0;
      let lastW = 0;

      const onMove = (e: PointerEvent) => {
        lastW = Math.max(min, Math.min(max, startW + sign * (e.clientX - startX)));
        root.style.setProperty(cssVar, `${lastW}px`);
      };
      const onUp = () => {
        handle.classList.remove('db-active');
        root.classList.remove('db-resizing');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        if (lastW) localStorage.setItem(storageKey, String(Math.round(lastW)));
      };
      const onDown = (e: PointerEvent) => {
        e.preventDefault();
        const cur = parseFloat(getComputedStyle(root).getPropertyValue(cssVar));
        startW = Number.isFinite(cur) ? cur : fallback;
        startX = e.clientX;
        lastW = startW;
        handle.classList.add('db-active');
        root.classList.add('db-resizing');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      };
      handle.addEventListener('pointerdown', onDown);
      cleanups.push(() => {
        handle.removeEventListener('pointerdown', onDown);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        handle.remove();
      });
    };

    if (!hideSidebar) {
      const left = document.querySelector('.theme-doc-sidebar-container') as HTMLElement | null;
      if (left) attach(left, 'right', '--doc-sidebar-width', 'db-sidebar-w', 1, 180, 520, 300);
    }
    if (hasToc && !hideToc) {
      const tocCol = document
        .querySelector('.theme-doc-toc-desktop')
        ?.closest('.col') as HTMLElement | null;
      if (tocCol) attach(tocCol, 'left', '--db-toc-width', 'db-toc-w', -1, 160, 560, 300);
    }
    return () => cleanups.forEach((fn) => fn());
  }, [onDoc, hasToc, hideSidebar, hideToc, pathname]);

  return (
    <>
      {children}

      <button
        className={`db-anim-toggle${noAnim ? '' : ' db-active'}`}
        aria-pressed={!noAnim}
        aria-label={noAnim ? 'Enable animations' : 'Disable animations'}
        title={noAnim ? 'Enable animations' : 'Disable animations'}
        onClick={() => setNoAnim((v) => !v)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          {noAnim && <line x1="3" y1="3" x2="21" y2="21" />}
        </svg>
      </button>

      {onDoc && (
        <div className="db-toggle-rail">
          <button
            className={`db-toggle-btn${hideSidebar ? ' db-active' : ''}`}
            aria-pressed={hideSidebar}
            title="Toggle the navigation sidebar"
            onClick={() => setHideSidebar((v) => !v)}
          >
            {hideSidebar ? 'Show nav' : 'Hide nav'}
          </button>
          {hasToc && (
            <button
              className={`db-toggle-btn${hideToc ? ' db-active' : ''}`}
              aria-pressed={hideToc}
              title="Toggle the table of contents"
              onClick={() => setHideToc((v) => !v)}
            >
              {hideToc ? 'Show contents' : 'Hide contents'}
            </button>
          )}
        </div>
      )}

      {preview && (
        <div className="img-zoom-overlay" onClick={close} role="dialog" aria-modal="true">
          <button className="img-zoom-close" aria-label="Close preview" onClick={close}>
            ×
          </button>
          {preview.kind === 'img' ? (
            <img className="img-zoom-content" src={preview.src} alt={preview.alt} />
          ) : (
            <div
              className="img-zoom-content img-zoom-svg"
              // SVG is cloned from already-rendered, trusted local mermaid output.
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          )}
        </div>
      )}
    </>
  );
}
