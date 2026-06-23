// Shared key-preview grid used by both the simple and advanced views.
// One image store + one renderer so the two views can never drift.
// No top-level DOM access — the pure helpers are unit-tested on txiki.js.

export interface ImageEntry {
  v: number;
  data?: string;
  format?: string;
}

export interface KeyPreviewOptions {
  showIndex?: boolean;
  flash?: boolean;
  onKeyClick?: (index: number) => void;
}

const KEY_FLASH_MS = 200;

const imageStore = new Map<number, ImageEntry>();
const instances = new Set<KeyPreview>();

/** data: URL (correct MIME) when bytes were pushed over WS, else versioned server URL. */
export function imageSrc(index: number, entry: ImageEntry): string {
  if (entry.data) {
    const mime = entry.format === 'bmp' ? 'image/bmp' : 'image/jpeg';
    return `data:${mime};base64,${entry.data}`;
  }
  return `/api/image/${index}?v=${entry.v}`;
}

export function getImageEntry(index: number): ImageEntry | undefined {
  return imageStore.get(index);
}

export function applyImage(index: number, entry: ImageEntry): void {
  imageStore.set(index, entry);
  broadcast((p) => p.refreshKey(index));
}

export function clearImage(index: number): void {
  imageStore.delete(index);
  broadcast((p) => p.refreshKey(index));
}

export function clearImageStore(): void {
  imageStore.clear();
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

  setModel(modelId?: string): void {
    if (modelId) this.root.dataset['model'] = modelId;
  }

  setClickable(clickable: boolean): void {
    for (const c of this.root.children) c.classList.toggle('clickable', clickable);
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
    img.src = imageSrc(index, entry);
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
    if (onKeyClick) {
      cell.addEventListener('click', () => {
        if (!cell.classList.contains('clickable')) return;
        onKeyClick(index);
      });
    }
    return cell;
  }

  private cell(index: number): HTMLElement | undefined {
    return this.root.children[index] as HTMLElement | undefined;
  }
}
