# deckbridge docs site

Documentation site for [DeckBridge](../) — built with [Docusaurus](https://docusaurus.io/).

Uses **pnpm** through repository `mise` tasks.
Dependencies use committed `pnpm-lock.yaml`.

## Develop

```bash
pnpm install
pnpm run start      # dev server with live reload
pnpm run build      # static site → build/
pnpm run serve      # serve the built site
pnpm run typecheck  # tsc
```

## Dependency security fixes

The `fast-uri` override requires `^3.1.8`, fixing percent-encoded host case
normalization (CVE-2026-86472) with an upstream release.

`pnpm-workspace.yaml` applies version-specific patches from `../patches/`:

- `braces@3.0.3` (CVE-2026-93687): reject patterns exceeding 100 nested
  brace/parenthesis blocks before recursive AST walkers run. The TypeScript
  workspace shares this patch for ESLint's transitive copy.
- `http-cache-semantics@4.2.0` (CVE-2026-93748): prevent `max-stale` and other
  stale-response paths from bypassing existing cache security restrictions.
  Normal expiry and explicitly permitted caching retain their behavior.

`pnpm run test:security` checks both mitigations against Docusaurus's actual
transitive dependencies and runs as part of `pnpm test` in CI.

These are local mitigations, not upstream releases. Dependabot may continue
reporting the affected package versions. Remove each patch registration and
file when an upstream release passes the regression tests, then regenerate
the lockfiles. HTTP cache 4.3.0 still reproduces the `max-stale` issue.

## Refresh screenshots

From repository root:

```bash
mise run docs-screenshots
```

Captures both themes using isolated mocks.
Updates `/features`, `/getting-started`, and homepage assets.
Includes four setup states and AKP05.
Runtime and dependencies build automatically.
No hardware or running server required.
Failed captures preserve existing screenshot assets.

Uses `$CHROME_BIN` or macOS Google Chrome.
Otherwise, install Chromium once:

```bash
pnpm --dir e2e exec playwright install chromium
```

## Project-specific bits

- **Mermaid → inline SVG at build** — `plugins/remark-mermaid-prerender.mjs` runs
  ` ```mermaid ` fences through `mmdc`, so the markdown source is preserved but no
  mermaid runtime ships to the browser.
- **Offline local search** — `@easyops-cn/docusaurus-search-local` (no Algolia).
- **Custom theme** (`src/theme/Root.tsx`) — click-to-zoom lightbox for diagrams
  (markdown `<img>` + inline mermaid `<svg>`) plus reader controls that hide and
  resize the doc nav sidebar and the table of contents.
- **Sidebars** are explicit in `sidebars.ts` (`tutorialSidebar` + `technicalSidebar`).
