export function syncParentTheme(controlsHost?: HTMLElement): void {
  // A standalone demo has no parent theme to follow.
  if (parent === window) return;
  try {
    const parentRoot = parent.document.documentElement;
    function updateTheme(): void {
      const theme = parentRoot.getAttribute('data-theme');
      if (theme) {
        document.documentElement.setAttribute('data-theme', theme);
        controlsHost?.setAttribute('data-theme', theme);
      }
    }
    updateTheme();
    new MutationObserver(updateTheme).observe(parentRoot, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  } catch {
    // Cross-origin embedding keeps the initial media-query theme.
  }
}
