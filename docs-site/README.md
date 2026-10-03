# deckbridge docs site

Documentation site for [DeckBridge](../) — built with [Docusaurus](https://docusaurus.io/).

Uses **npm** (a `package-lock.json` is committed; there is no `yarn.lock`).

## Develop

```bash
npm install
npm run start      # dev server with live reload
npm run build      # static site → build/
npm run serve      # serve the built site
npm run typecheck  # tsc
```

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
