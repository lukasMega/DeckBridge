import type { DocsTopic } from '../../contract.js';

// Docs-site demo only (src/demo/install.ts): GitHub Pages has no /go/docs redirect.
// Callers guard with `__DEMO__`, so the app build drops this module.
let docsHref: ((topic: DocsTopic) => string) | undefined;

export function setDemoDocsHref(fn: (topic: DocsTopic) => string): void {
  docsHref = fn;
}

export function demoDocsHref(topic: DocsTopic): string {
  return docsHref?.(topic) ?? `/go/docs/${topic}`;
}
