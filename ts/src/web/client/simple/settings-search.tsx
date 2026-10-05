import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

function matches(element: HTMLElement, terms: string[], group: string): boolean {
  const labels = Array.from(
    element.querySelectorAll('[aria-label], [placeholder]'),
    (field) =>
      `${field.getAttribute('aria-label') ?? ''} ${field.getAttribute('placeholder') ?? ''}`,
  ).join(' ');
  const text = `${group} ${element.textContent} ${labels}`.toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
}

function filterGroup(group: HTMLElement, terms: string[]): number {
  const title = group.getAttribute('aria-label') ?? '';
  let visible = 0;
  for (const item of group.querySelectorAll<HTMLElement>(
    ':scope > .collapsible, :scope > .settings-actions',
  )) {
    item.hidden = !matches(item, terms, title);
    if (!item.hidden) visible++;
    for (const panel of [item, ...item.querySelectorAll<HTMLElement>('.collapsible')]) {
      panel.toggleAttribute('data-search-match', terms.length > 0 && matches(panel, terms, title));
    }
  }
  group.hidden = visible === 0;
  return visible;
}

export function SettingsGroup({
  title,
  children,
}: Readonly<{ title: string; children: ComponentChildren }>): preact.JSX.Element {
  return (
    <section class="settings-group" aria-label={title}>
      <h2 class="help-section-label">{title}</h2>
      {children}
    </section>
  );
}

export function SettingsSearch({
  children,
}: Readonly<{ children: ComponentChildren }>): preact.JSX.Element {
  const [query, setQuery] = useState('');
  const statusRef = useRef<HTMLParagraphElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const container = rootRef.current;
    if (!container) return;
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    // Index mounted content, including collapsed controls. Async panel loads update
    // this index without remounting forms or replacing their unsaved edits.
    const filter = (): void => {
      let total = 0;
      for (const group of container.querySelectorAll<HTMLElement>('.settings-group')) {
        total += filterGroup(group, terms);
      }
      if (statusRef.current) {
        statusRef.current.className = total === 0 ? 'help-lead' : 'visually-hidden';
        const label = total === 1 ? 'section' : 'sections';
        const result =
          total === 0 ? 'No settings found. Try another search.' : `${total} matching ${label}`;
        statusRef.current.textContent = terms.length > 0 ? result : '';
      }
    };
    filter();
    const observer = new MutationObserver(filter);
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, [query]);

  return (
    <>
      <div class="settings-search">
        <h1>Settings</h1>
        <label class="visually-hidden" for="settings-search">
          Search settings
        </label>
        <input
          ref={inputRef}
          id="settings-search"
          class="input"
          type="search"
          placeholder="Search settings…"
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query !== '') {
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        {query !== '' && (
          <button
            class="ghostbtn"
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            Clear
          </button>
        )}
      </div>
      <p ref={statusRef} class="visually-hidden" role="status" />
      <div ref={rootRef}>{children}</div>
    </>
  );
}
