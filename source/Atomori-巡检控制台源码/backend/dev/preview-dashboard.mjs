// Preview updated static assets while the existing local device backend keeps running.
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';

const webRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const staticApp = createApp({ webRoot, store: {} });
const port = Number(process.env.ATOMORI_PREVIEW_PORT || 3002);
const server = createServer((req, res) => {
  if (!req.url.startsWith('/api/')) return staticApp(req, res);
  const upstream = request({
    hostname: '127.0.0.1', port: 3000, method: req.method, path: req.url,
    headers: { ...req.headers, host: '127.0.0.1:3000' }
  }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { message: '本机 3000 数据服务不可用' } }));
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
server.listen(port, '127.0.0.1', () => console.log(`Dashboard preview: http://127.0.0.1:${port}/`));
