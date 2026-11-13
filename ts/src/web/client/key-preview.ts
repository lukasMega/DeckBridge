// Shared key-preview grid used by both the simple and advanced views.
// One image store + one renderer so the two views can never drift.
// No top-level DOM access — the pure helpers are unit-tested on txiki.js.

export interface ImageEntry {
  /** base64 */
  data: string;
  format: 'jpeg' | 'bmp';
}

export interface KeyPreviewOptions {
  showIndex?: boolean;
  flash?: boolean;
  onKeyClick?: (index: number) => void;
  /** 'click' (default): one click fires. 'dblclick': double-click or Enter/Space fires, so a
   *  single click stays free (the simple view's dock card selects on it). */
  gesture?: 'click' | 'dblclick';
}

const KEY_FLASH_MS = 200;

const imageStore = new Map<number, ImageEntry>();
const instances = new Set<KeyPreview>();
const imageListeners = new Set<() => void>();

/** Preact grids that show live key images re-render through this (the store is imperative). */
export function subscribeImages(listener: () => void): () => void {
  imageListeners.add(listener);
  return () => imageListeners.delete(listener);
}

function notifyImages(): void {
  for (const listener of imageListeners) listener();
}

/** data: URL with the frame's MIME type. */
export function imageSrc(entry: ImageEntry): string {
  const mime = entry.format === 'bmp' ? 'image/bmp' : 'image/jpeg';
  return `data:${mime};base64,${entry.data}`;
}

export function getImageEntry(index: number): ImageEntry | undefined {
  return imageStore.get(index);
}

export function applyImage(index: number, entry: ImageEntry): void {
  imageStore.set(index, entry);
  broadcast((p) => p.refreshKey(index));
  notifyImages();
}

export function clearImageStore(): void {
  imageStore.clear();
  notifyImages();
}

/** Wipe every cached image and blank all mounted grids — used when the
 *  selected preview dock changes (the server replays the new dock's frames
 *  right after the status broadcast). */
export function resetPreviews(): void {
  imageStore.clear();
  broadcast((p) => p.refreshAll());
  notifyImages();
}

export function flashKey(index: number): void {
  broadcast((p) => p.flash(index));
}

function broadcast(fn: (p: KeyPreview) => void): void {
  for (const p of instances) {
    if (!p.root.isConnected) {
      instances.delete(p);
      continue;
    }
    fn(p);
  }
}

export class KeyPreview {
  readonly root: HTMLElement;
  private readonly opts: KeyPreviewOptions;
  private keyCount = 0;
  private columns = 0;

  constructor(root: HTMLElement, opts: KeyPreviewOptions = {}) {
    this.root = root;
    this.opts = opts;
    root.classList.add('key-grid');
    // Drop instances whose DOM was discarded (simple view rebuilds its stage).
    for (const p of instances) if (!p.root.isConnected) instances.delete(p);
    instances.add(this);
  }

  rebuild(keyCount: number, columns: number): void {
    if (this.keyCount === keyCount && this.columns === columns) return;
    this.keyCount = keyCount;
    this.columns = columns;
    this.root.innerHTML = '';
    this.root.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    for (let i = 0; i < keyCount; i++) this.root.appendChild(this.buildCell(i));
    for (let i = 0; i < keyCount; i++) this.refreshKey(i);
  }

  setModel(modelId?: string, coraProfile?: string): void {
    if (modelId) this.root.dataset['model'] = modelId;
    if (coraProfile) this.root.dataset['cora'] = coraProfile;
    else delete this.root.dataset['cora'];
  }

  refreshAll(): void {
    for (let i = 0; i < this.keyCount; i++) this.refreshKey(i);
  }

  /** `title` (when given) becomes every cell's tooltip, e.g. why the grid is inert. */
  setClickable(clickable: boolean, title?: string): void {
    for (const c of this.root.children) {
      c.classList.toggle('clickable', clickable);
      if (title === undefined) continue;
      if (title === '') c.removeAttribute('title');
      else c.setAttribute('title', title);
    }
  }

  refreshKey(index: number): void {
    const cell = this.cell(index);
    if (!cell) return;
    const entry = imageStore.get(index);
    let img = cell.querySelector<HTMLImageElement>('img');
    if (!entry) {
      img?.remove();
      cell.classList.remove('lit');
      return;
    }
    if (!img) {
      img = document.createElement('img');
      cell.insertBefore(img, cell.firstChild);
    }
    img.src = imageSrc(entry);
    cell.classList.add('lit');
  }

  flash(index: number): void {
    if (!this.opts.flash) return;
    if (document.body.classList.contains('no-anim')) return;
    const cell = this.cell(index);
    if (!cell) return;
    cell.classList.add('flash');
    setTimeout(() => cell.classList.remove('flash'), KEY_FLASH_MS);
  }

  private buildCell(index: number): HTMLElement {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'key-cell';
    cell.dataset['key'] = String(index);
    if (this.opts.showIndex) {
      const idx = document.createElement('span');
      idx.className = 'kidx';
      idx.textContent = String(index);
      cell.appendChild(idx);
    }
    const onKeyClick = this.opts.onKeyClick;
    if (!onKeyClick) return cell;
    const fire = (): void => {
      if (cell.classList.contains('clickable')) onKeyClick(index);
    };
    if (this.opts.gesture === 'dblclick') {
      cell.addEventListener('dblclick', fire);
      // Handled on keydown: the dock card's own Enter/Space handler would otherwise swallow
      // the keystroke before the button turns it into a click.
      cell.addEventListener('keydown', (e) => {
        if ((e.key !== 'Enter' && e.key !== ' ') || !cell.classList.contains('clickable')) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) fire();
      });
    } else {
      cell.addEventListener('click', fire);
    }
    return cell;
  }

  private cell(index: number): HTMLElement | undefined {
    return this.root.children[index] as HTMLElement | undefined;
  }
}
