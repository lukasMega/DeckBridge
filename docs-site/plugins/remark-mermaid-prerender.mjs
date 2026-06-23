// Build-time mermaid → inline SVG, so ```mermaid source stays in the .md but
// NO mermaid/d3/cytoscape/katex runtime ships in the client bundle.
//
// Why custom: Docusaurus loads docusaurus.config via jiti v1, which transpiles
// ESM deps to CJS and dies on `import.meta.resolve` inside mermaid-isomorphic
// (the engine behind remark-mermaidjs / rehype-mermaid). So we can't import a
// browser-driving ESM plugin from the config. Instead we shell out to `mmdc`
// (mermaid-cli) in a SEPARATE process — jiti never touches its ESM — and inline
// the result. This file itself uses only Node built-ins (no `import.meta`), so
// jiti transpiles it cleanly.
//
// Rendered SVGs are content-hashed and cached under node_modules/.cache, so a
// diagram is only re-rendered when its source changes.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CWD = process.cwd();
const CACHE_DIR = join(CWD, 'node_modules', '.cache', 'db-mermaid');
const MMDC = join(CWD, 'node_modules', '.bin', 'mmdc');
// Reuse the system Chrome so mmdc's puppeteer never needs its own download.
const DEFAULT_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Replace every ```mermaid fence with the pre-rendered SVG (in place). */
function replaceMermaid(node, chromePath) {
  const source = node.value;
  const hash = createHash('sha256')
    .update(`${source}`)
    .digest('hex')
    .slice(0, 16);
  const svgPath = join(CACHE_DIR, `${hash}.svg`);

  if (!existsSync(svgPath)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const mmdPath = join(CACHE_DIR, `${hash}.mmd`);
    writeFileSync(mmdPath, source);
    const env = { ...process.env };
    if (chromePath && existsSync(chromePath)) {
      env.PUPPETEER_EXECUTABLE_PATH = chromePath;
    }
    execFileSync(MMDC, ['-i', mmdPath, '-o', svgPath, '-b', 'transparent'], {
      env,
      stdio: 'pipe',
    });
  }

  // Strip any leading <?xml …?> so the markup is valid inline HTML.
  const svg = readFileSync(svgPath, 'utf8').replace(/^<\?xml[^>]*\?>\s*/, '');

  // Mutate the mdast `code` node into a raw-HTML node carrying the diagram.
  // Reuse the class the old runtime theme-mermaid emitted, so the existing
  // custom.css sizing + Root.tsx lightbox keep working unchanged.
  node.type = 'html';
  node.value = `<div class="docusaurus-mermaid-container">${svg}</div>`;
  delete node.lang;
  delete node.meta;
}

/** Walk the mdast tree, transforming mermaid code fences. */
function walk(node, chromePath) {
  if (node.type === 'code' && node.lang === 'mermaid') {
    replaceMermaid(node, chromePath);
    return;
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, chromePath);
  }
}

/** remark plugin factory. */
export default function remarkMermaidPrerender(options = {}) {
  const chromePath = options.chromePath ?? DEFAULT_CHROME;
  return (tree) => {
    walk(tree, chromePath);
  };
}
