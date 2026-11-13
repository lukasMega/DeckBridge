// Minimal emitter behind `events` / `node:events` (see build.mjs, tsconfig paths); same semantics
// as the eventemitter3 it replaced for the methods the code uses. No 'error' special-casing:
// emit never throws for a missing listener.
type Listener = (...args: never[]) => void;
type Entry = readonly [fn: Listener, once: boolean];

export class EventEmitter {
  // Lists are replaced, never mutated, so an emit in flight walks the listeners it started with.
  readonly #events = new Map<string | symbol, Entry[]>();

  on(event: string | symbol, fn: Listener): this {
    return this.#add(event, [fn, false]);
  }

  once(event: string | symbol, fn: Listener): this {
    return this.#add(event, [fn, true]);
  }

  // Without `fn`, drops every listener of the event; with it, every registration of `fn`.
  off(event: string | symbol, fn?: Listener): this {
    return this.#drop(event, (e) => !fn || e[0] === fn);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.#events.clear();
    else this.#events.delete(event);
    return this;
  }

  listenerCount(event: string | symbol): number {
    return this.#events.get(event)?.length ?? 0;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.#events.get(event);
    if (!list) return false;
    for (const entry of list) {
      // Removed before the call, so a re-entrant emit cannot fire it twice.
      if (entry[1]) this.#drop(event, (e) => e[1] && e[0] === entry[0]);
      (entry[0] as (...a: unknown[]) => void).apply(this, args);
    }
    return true;
  }

  #add(event: string | symbol, entry: Entry): this {
    this.#events.set(event, [...(this.#events.get(event) ?? []), entry]);
    return this;
  }

  #drop(event: string | symbol, match: (e: Entry) => boolean): this {
    const left = this.#events.get(event)?.filter((e) => !match(e));
    if (left?.length) this.#events.set(event, left);
    else this.#events.delete(event);
    return this;
  }
}
