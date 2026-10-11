// Dock hooks -> extension events: the one place that turns what a dock sees into the
// public ExtensionEvent shape (extension/api.ts).
import { VIRTUAL_DOCK_INDEX } from '../shared/types.js';
import { advertisedGeometry } from '../devices/registry.js';
import type { DeckSource, ExtensionEvent } from '../extension/api.js';
import type { Dock } from './dock.js';
import type { DockHooks } from './dock-types.js';
import { physicalEncoderCount } from './dock-status.js';

type DeckAttached = Extract<ExtensionEvent, { type: 'deckAttached' }>;

/** Where events go. `wants` false = no running extension takes that type, so it is not built. */
export interface ExtensionEventSink {
  wants(type: ExtensionEvent['type']): boolean;
  emit(event: ExtensionEvent): void;
}

export class ExtensionEventWiring {
  /** Last attach per dock index, replayed to an extension that starts later. */
  private readonly attached = new Map<number, DeckAttached>();

  constructor(
    private readonly sink: ExtensionEventSink,
    private readonly dockAt: (index: number) => Dock | undefined,
  ) {}

  /** The Dock is looked up per event: dock 0 outlives its devices, so a replug may bring a different deck. */
  hooks(index: number): Pick<DockHooks, 'attached' | 'input' | 'imageSent'> {
    const deviceKey = (): string => this.dockAt(index)?.identity?.deviceKey ?? '';
    return {
      attached: (mock) => {
        const dock = this.dockAt(index);
        const key = dock?.identity?.deviceKey ?? '';
        if (!dock || key === '') return;
        let source: DeckSource = index === VIRTUAL_DOCK_INDEX ? 'browser' : 'usb';
        if (mock) source = 'mock';
        const event: DeckAttached = {
          type: 'deckAttached',
          at: Date.now(),
          deviceKey: key,
          modelName: dock.model.name,
          source,
          hasEncoders: physicalEncoderCount(dock.model) > 0,
          columns: advertisedGeometry(dock.model).columns,
          extraKeys: [...(dock.model.keyMap.extraKeys ?? [])],
        };
        this.attached.set(index, event);
        if (this.sink.wants('deckAttached')) this.sink.emit(event);
      },
      input: (input) => {
        if (!this.sink.wants('input')) return;
        const key = deviceKey();
        if (key !== '') this.sink.emit({ type: 'input', at: Date.now(), deviceKey: key, input });
      },
      imageSent: (_keyIndex, cached) => {
        if (!this.sink.wants('imageProcessed')) return;
        const key = deviceKey();
        if (key !== '') {
          this.sink.emit({ type: 'imageProcessed', at: Date.now(), deviceKey: key, cached });
        }
      },
    };
  }

  /** Dock `index` lost its device but lives on (dock 0): do not replay its deck. */
  forget(index: number): void {
    this.attached.delete(index);
  }

  /** deckAttached of every dock that still exists, for an extension that starts now. */
  currentDecks(): ExtensionEvent[] {
    return [...this.attached].filter(([index]) => this.dockAt(index)).map(([, event]) => event);
  }
}
