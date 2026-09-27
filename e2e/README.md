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

### Arranging state

`fixtures/app.ts` re-exports the helpers specs use to set up state without the UI:

- `api(request, baseURL, path, body?)` → `{ status, json }` (GET, or POST JSON), plus
  `getState` / `waitForState(predicate)` / `waitForDriver` over `GET /api/state`. All go
  through Playwright's `request` context, never an in-page `fetch` — a long run of
  page-side fetches wedges a later Lightpanda navigation.
- `useDevice(request, baseURL, modelId)` switches the mock device in place
  (`POST /api/device-model`) and waits for the new model. One app serves every device.
- `connectElgato(request, baseURL)` opens a fake Elgato app connection on the child CORA
  port (5344), which is what moves the UI to the "Everything's working" stage. A silent
  client is enough: the server never times out an unresponsive client. `close()` waits
  for `elgatoConnected: false`, so the next spec starts unpaired.
- `restoreSettings(request, baseURL, snapshot)` puts settings.json back to a
  `getSettings()` snapshot taken in `beforeAll`: per-device config (`extraKeys`, strip
  mode, knobs, brightness) and `multiDeck`, and device tuning only when it changed —
  every `modelOverrides` import reopens the session. Identities created since stay,
  stripped to their identity fields. (`POST /api/settings {}` resets nothing: an import
  only assigns the fields it carries.) `setOverride` / `resetOverride` apply device
  tuning and wait for the reopened mock to show it.
- `workerRequest` is a worker-scoped request context for `beforeAll`/`afterAll` hooks
  (`request` is test-scoped). Every describe block ends on MK.2 with its settings
  restored, so spec order does not matter.
- `nextFrame(baseURL, match, trigger)` reads `/api/ws` from Node — WS round-trips need
  no page load. `Marker` gives a shell command that appends a line to a temp file, so a
  spec can count how often a press/knob command or command widget ran.
- The mock driver takes simulated input the real drivers would emit:
  `POST /api/key/:n` (grid key), `/api/mock/extra-key/:wireId` (side key with a switch),
  `/api/mock/dial` and `/api/mock/touch`. All are mock-only (404 in real mode) and 400
  on input the current device cannot produce.

### Device matrix

`helpers/devices.ts` lists every mocked device with what it must report — geometry,
side keys, knobs, strip zones, CORA profile, whether its wire sizes are tunable. The
values are copied from `ts/src/devices/**`, not imported: the table is the independent
check. Each mocked device gets a `mock:<modelId>` identity, so its per-device settings
persist like a real one's.

| Device | Model id | Grid | Side keys | Strip / knobs | Specs |
|---|---|---|---|---|---|
| Ajazz AKP05E | `ajazz-akp05e` | 5×2 (8/4×2 as a Stream Deck +) | 15/10, Plus profile only, with switches | 4 zones, 4 knobs | matrix, ready, side-keys, touch-strip-knobs |
| Ajazz AKP153 rev. 1 | `ajazz-akp153` | 5×3 | 16/17/18, display-only | — | matrix, ready, side-keys |
| Ajazz AKP153 rev. 2 | `ajazz-akp153e-rev2` | 5×3 | — | — | matrix, ready |
| Mirabox 293S | `mirabox-293s` | 5×3 | 16/17/18, display-only | — | matrix, ready, side-keys |
| Mirabox 293V3 | `mirabox-293` | 5×3 | — | — | matrix, ready |
| Fifine D6 | `fifine-d6` | 5×3 | — | — | matrix, ready |
| Stream Deck Mini | `mini` | 3×2 | — | — | matrix, ready |
| Stream Deck MK.2 | `mk2` | 5×3 | — | — | matrix, ready, everything else |

- `device-matrix.spec.ts` — all devices: status + first WS snapshot, last-key round-trip,
  out-of-range key, capability presence/absence, device-tuning fields, and the key-grid
  preview across all devices in one page load.
- `ready-stage.spec.ts` — paired (fake CORA client): brightness, and which panels render
  per device (plain boards must show none).
- `side-keys.spec.ts` — 293S / AKP153 rev. 1 display-only column; AKP05E pressable keys.
- `touch-strip-knobs.spec.ts` — AKP05E strip modes, zones, knobs, Plus emulation, and
  simulated knob/strip input.
- `settings-panels.spec.ts` — device-independent Settings page on MK.2: mDNS rename,
  multi-deck, updates (never contacts GitHub; the page must not request
  `/api/update/check`), diagnostics redaction, settings import, log level, `/requirements`.

**Adding a device:**

1. Add a `DeviceCase` to `DEVICES` in `helpers/devices.ts`, with values read from its
   `DeviceModel` (and `advertiseAs` / `cora.emulations` for the profile fields). The
   matrix spec and the ready-stage panel checks pick it up; a device with no side keys,
   strip or knobs joins `PLAIN_DEVICES` on its own.
2. If it has side keys, a strip or knobs, add it to the matching spec — the matrix only
   checks that they are reported, not that they work.
3. Add a row to the table above.
