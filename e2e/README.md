# Browser e2e (Playwright + Lightpanda)

Two suites, one runtime:

| Project | Target | Command |
|---|---|---|
| `app` | the DeckBridge Web UI, served by the real bundle in mock mode | `mise run e2e-app` |
| `docs` | the built Docusaurus site (`docs-site/build/`) | `mise run e2e-docs` |

`mise run e2e-browser` (alias `e2e-all`) runs both; `mise run e2e-types` type-checks the
suite. Both, plus `e2e-types`, are part of `mise run beforeCommit`.
(The older `mise run e2e` is a different thing — a black-box smoke test of a packaged
release zip, `scripts/e2e-smoke.sh`.)

Preconditions:

- **app** — `mise run build` (the task depends on it) and **CORA ports 5343/5344 free**.
  `app.ts` awaits its CORA listeners before connecting the mock driver, and that retry
  loop never gives up, so an occupied port leaves the UI permanently in the "no device"
  stage. `helpers/app-server.ts` preflights both ports and fails with a named error.
- **docs** — `mise run docs-build` first. The suite serves `docs-site/build/`; it never
  builds, because a build is minutes long and re-renders every mermaid diagram through
  headless Chrome.

## The runtime is Lightpanda, not Chromium

[Lightpanda](https://lightpanda.io) is a headless browser written in Zig with a real JS
engine and DOM but **no rendering or layout engine**. It boots in milliseconds — the docs
suite finishes in ~6 s — and it runs React 19 + Docusaurus hydration, Preact, `fetch` and
WebSocket correctly (all verified by these specs).

`global-setup.ts` starts one `lightpanda serve` CDP server for the run;
`fixtures/browser.ts` attaches with `chromium.connectOverCDP`.

### The browser version is pinned separately

Pinning `@lightpanda/browser` in `package.json` does **not** pin the browser — the wrapper
ships no binary, and a bare `lightpanda install` fetches the latest *nightly*. The same
wrapper version handed us nightly 9384 one day and 9405 the next, and 9405 never finished
hydrating the docs site (`data-has-hydrated="false"`) while running ~5× slower.

So the browser is pinned in **`e2e/.lightpanda-version`** to a tagged release (nightly tags
are overwritten upstream and cannot be re-fetched). `scripts/ensure-lightpanda.mjs` installs
exactly that version and refuses a cached binary that reports anything else; both CI
workflows key their cache on that file. To move the pin, edit it and re-run the suites.

### What you cannot use

Because there is no layout, these silently return stubs instead of failing loudly:

| API | What actually happens |
|---|---|
| `page.screenshot()`, `toHaveScreenshot()` | returns a hardcoded placeholder image |
| `page.pdf()` | returns a hardcoded placeholder PDF |
| `locator.boundingBox()` | returns a fake 5×5 rect |
| `locator.click()` / `hover()` / `dragTo()` | hangs on the actionability check, then times out |

Assert on DOM state, attributes, text, classes and network — never pixels.

### Interaction

Use `helpers/click.ts`:

```ts
import { click, typeInto, pressEscape } from '../../helpers/click.js';
await click(page.locator('#themeBtn'));
```

`click()` calls the element's own `.click()`. Note that `locator.dispatchEvent('click')` —
the usual Playwright workaround for missing actionability — **delivers the event twice**
on Lightpanda (measured with a raw listener counter), so anything that toggles ends up
back where it started. That bug is why the helper exists.

### Triage: run the same specs in real Chromium

```bash
E2E_BROWSER=chromium mise run e2e-browser
```

This skips Lightpanda entirely, launches `$CHROME_BIN` (or the macOS default), and makes
`click()` a genuine click. If a spec passes here and fails on Lightpanda, the difference is
the runtime, not the product.

## Scope

These specs cover **only what needs a live JS runtime**. The static layers already own
their ground and must not be duplicated:

- `docs-site/scripts/*.mts` — routes, sitemap, internal links, `#anchor` targets,
  one-`h1`-per-page, navbar/footer presence, mermaid prerendering, feeds.
- `ts/scripts/test-client.mjs` — Preact store/clipboard component regressions.

Not covered by design: the app's "Everything's working" stage, lit key images and the
side-keys panel. All three need a real CORA TCP client (or a real device); mock mode
reaches `driverConnected` but never `elgatoConnected`.
