import type { Locator, Page } from '@playwright/test';

/**
 * Lightpanda has no layout engine, so `boundingBox()` returns a stub 5x5 rect and
 * Playwright's actionability check for `locator.click()` never passes — a real click
 * always times out.
 *
 * `locator.dispatchEvent('click')` is the usual workaround, but on Lightpanda it delivers
 * the event **twice** (measured: a raw `addEventListener('click')` counter reads 2 for one
 * `dispatchEvent`, 1 for `el.click()`). Anything that toggles — a sort direction, an
 * `aria-pressed` flag — silently ends up back where it started. So we call the element's
 * own `click()` instead, which auto-waits for attachment without an actionability check
 * and fires exactly once. Verified to drive React/Preact handlers *and* client-side
 * anchor navigation.
 *
 * Under E2E_BROWSER=chromium (the triage path) we use the genuine click, so a spec that
 * passes there but fails on Lightpanda tells you the difference is the runtime, not the
 * product.
 */
export const usingChromium = process.env.E2E_BROWSER === 'chromium';

export async function click(locator: Locator): Promise<void> {
  if (usingChromium) {
    await locator.click();
    return;
  }
  await locator
    .evaluate((el) => {
      (el as HTMLElement).click();
    })
    .catch((err: unknown) => {
      // Lightpanda occasionally loses the reply to callFunctionOn when the handler
      // re-renders the node it was invoked on. The click itself was delivered — only the
      // acknowledgement is gone — and the assertion that follows is what proves it
      // landed, so this one error is not a failure.
      if (!/promise was garbage collected/i.test(String(err))) throw err;
    });
}

/** Type into an input. `fill()` dispatches `input` itself, which React and Preact both honour. */
export async function typeInto(locator: Locator, value: string): Promise<void> {
  await locator.fill(value);
}

async function dispatchEscape(page: Page): Promise<void> {
  if (usingChromium) {
    await page.keyboard.press('Escape');
    return;
  }
  await page.evaluate(() => {
    // The app binds Escape on `window` (overlays.tsx `useEscape`) and the docs site on
    // `document` (Root.tsx). A synthetic event dispatched on one does not reach listeners
    // on the other, so fire both rather than guessing.
    const mk = () =>
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.dispatchEvent(mk());
    document.dispatchEvent(mk());
  });
}

/**
 * Fire Escape at the overlay dismiss handlers, retrying until `until` reports the overlay
 * is gone.
 *
 * The retry is not defensive padding — it closes a real race. `useEscape` registers its
 * listener from a `useEffect`, and Preact defers effects until after the commit, so the
 * overlay's DOM (which is what a test waits on) exists for a beat *before* anything is
 * listening for Escape. A single dispatch lands in that gap often enough to flake; it did,
 * on the About popover.
 *
 * Callers without an `until` predicate get one best-effort dispatch.
 */
export async function pressEscape(
  page: Page,
  until?: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  if (!until) {
    await dispatchEscape(page);
    return;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await dispatchEscape(page);
    if (await until()) return;
    if (Date.now() > deadline) return; // let the caller's assertion report the failure
    await new Promise((r) => setTimeout(r, 150));
  }
}
