// Light/dark theme preference, persisted in localStorage.
export type ThemePref = 'light' | 'dark' | 'auto';

/** Mirrors the inline pre-paint script in ui.html — must stay in sync. */
export function getTheme(): ThemePref {
  const t = localStorage.getItem('deckbridge.theme');
  return t === 'light' || t === 'dark' ? t : 'auto';
}

export function setTheme(pref: ThemePref): void {
  if (pref === 'auto') localStorage.removeItem('deckbridge.theme');
  else localStorage.setItem('deckbridge.theme', pref);
  const dark =
    pref === 'dark' ||
    (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
