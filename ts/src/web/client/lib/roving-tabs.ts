// Arrow/Home/End navigation for a role="tablist" with a roving tabIndex.
const NAV_KEYS: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  ArrowUp: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

/** Moves focus to the next tab and returns its position; undefined = not a nav key. */
export function rovingTabKey(e: KeyboardEvent, index: number, count: number): number | undefined {
  const nav = NAV_KEYS[e.key];
  if (!nav || count === 0) return undefined;
  e.preventDefault();
  const next = nav(index, count);
  const list = (e.currentTarget as HTMLElement).closest('[role="tablist"]');
  list?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  return next;
}
