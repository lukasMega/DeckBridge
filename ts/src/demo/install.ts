import { setDemoDocsHref } from '../web/client/lib/demo-docs.js';
import { DOCS_BASE, DOCS_TOPICS } from '../shared/docs-topics.js';
import { DemoBackend } from './backend.js';

export const backend = new DemoBackend();
setDemoDocsHref((topic) => DOCS_BASE + DOCS_TOPICS[topic]);
