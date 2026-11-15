/**
 * 零依赖静态服务器。仅用于本地验收，不做缓存与控制头处理。
 *
 * 用法：node serve.js [port]
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 5180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

/** 只允许访问 ROOT 内部路径 */
function safeJoin(root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

const server = http.createServer(async (req, res) => {
  const abs = safeJoin(ROOT, req.url || '/');
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 越界路径');
    return;
  }

  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      const html = await fs.readFile(idx);
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
      return;
    }
    const data = await fs.readFile(abs);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(code === 404 ? `404 未找到：${req.url}` : `500 ${err.message}`);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mdviewer 已启动: http://127.0.0.1:${PORT}/`);
  console.log(`  Markdown 样例: http://127.0.0.1:${PORT}/?file=samples/welcome.md`);
  console.log(`  JSON 样例:     http://127.0.0.1:${PORT}/?file=samples/demo.json`);
});
