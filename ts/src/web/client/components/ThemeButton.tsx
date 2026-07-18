// Light/dark/auto theme cycle button — shared by the simple topbar and the
// advanced header. Each instance keeps its own icon state, but the click
// handler always cycles from the persisted preference so two mounted
// instances (both views mount at startup) can never diverge in behavior.
import { useState } from 'preact/hooks';
import { getTheme, setTheme as persistTheme, type ThemePref } from '../ui-helpers.js';
import { ICON } from '../ui-icons.js';

const THEME_CYCLE: readonly ThemePref[] = ['light', 'dark', 'auto'];
const THEME_ICON: Record<ThemePref, string> = { light: ICON.sun, dark: ICON.moon, auto: ICON.auto };
const THEME_LABEL: Record<ThemePref, string> = { light: 'Light', dark: 'Dark', auto: 'Auto' };

export function ThemeButton({ id }: Readonly<{ id?: string }> = {}): preact.JSX.Element {
  const [theme, setTheme] = useState<ThemePref>(() => getTheme());
  const cycleTheme = (): void => {
    const cur = getTheme();
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(cur) + 1) % THEME_CYCLE.length]!;
    persistTheme(next);
    setTheme(next);
  };
  return (
    <button
      class="iconbtn circle"
      id={id}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Click to change.`}
      title={`Theme: ${THEME_LABEL[theme]}`}
      type="button"
      onClick={cycleTheme}
      // eslint-disable-next-line @eslint-react/dom-no-dangerously-set-innerhtml -- static trusted SVG icon markup
      dangerouslySetInnerHTML={{ __html: THEME_ICON[theme] }}
    />
  );
}
