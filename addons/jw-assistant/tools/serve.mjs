import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = new Map([
  ['/ui/index.html', 'text/html; charset=utf-8'],
  ['/ui/field-panel.mjs', 'text/javascript; charset=utf-8'],
  ['/field/standards.mjs', 'text/javascript; charset=utf-8'],
  ['/storage/local-store.mjs', 'text/javascript; charset=utf-8'],
  ['/ui/app.mjs', 'text/javascript; charset=utf-8'],
  ['/ui/locales.mjs', 'text/javascript; charset=utf-8'],
  ['/ui/styles.css', 'text/css; charset=utf-8'],
  ['/core/engine.mjs', 'text/javascript; charset=utf-8'],
  ['/review/store.mjs', 'text/javascript; charset=utf-8'],
  ['/review/export.mjs', 'text/javascript; charset=utf-8'],
  ['/jw-adapter/importer.mjs', 'text/javascript; charset=utf-8'],
  ['/jw-adapter/capture-bundle.mjs', 'text/javascript; charset=utf-8'],
  ['/fixtures/timber-plan.json', 'application/json; charset=utf-8'],
]);

export function previewServer() {
  return createServer(async (req, res) => {
    const finish = (code, body = '') => { res.writeHead(code); res.end(body); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const address = `127.0.0.1:${req.socket.localPort}`;
    if (req.headers.host !== address) return finish(403);
    if (req.headers.origin && req.headers.origin !== `http://${address}`) return finish(403);
    if (!['GET', 'HEAD'].includes(req.method)) return finish(405);
    try {
      const url = new URL(req.url, `http://${address}`);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/' || pathname === '/ui') {
        res.setHeader('Location', '/ui/');
        return finish(302);
      }
      const requested = pathname === '/ui/' ? '/ui/index.html' : pathname;
      if (!files.has(requested)) return finish(404);
      const target = await realpath(path.join(root, requested.slice(1)));
      const relative = path.relative(await realpath(root), target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return finish(403);
      const data = await readFile(target);
      res.setHeader('Content-Type', files.get(requested));
      res.setHeader('Content-Length', data.length);
      res.writeHead(200);
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      finish(error instanceof URIError ? 400 : 404);
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.argv[2] || 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a port from 1024 to 65535.');
  const server = previewServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Local drawing review: http://127.0.0.1:${port}/ui/`));
}
