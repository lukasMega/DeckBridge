import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '3000' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});
const build = resolve(import.meta.dirname, '../build');
const baseUrl = '/DeckBridge/';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

// Keep nested index.html URLs intact; Docusaurus's clean-URL redirects drop baseUrl.
const server = createServer(async function serve(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!pathname.startsWith(baseUrl)) {
    res.writeHead(302, { Location: baseUrl }).end();
    return;
  }
  const route = pathname.slice(baseUrl.length);
  const file = resolve(build, extname(route) ? route : `${route || '.'}/index.html`);
  if (!file.startsWith(`${build}${sep}`)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': types['.html'] });
    res.end(await readFile(resolve(build, '404.html')));
  }
});
server.listen(Number(values.port), values.host, function ready() {
  console.log(`Serving http://${values.host}:${values.port}${baseUrl}`);
});
