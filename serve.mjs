// Minimal static file server: node serve.mjs [port]
// Also accepts PUT under /baked/ so the in-browser offline bake (?bake=1) can
// persist its artifacts next to the app for distribution.
import { createServer } from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, extname, join, normalize } from 'path';

const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const port = parseInt(process.argv[2]) || 8123;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.md': 'text/markdown; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'PUT') {
      if (!p.startsWith('/baked/')) { res.writeHead(403); res.end('writes only under /baked/'); return; }
      const file = normalize(join(root, p));
      if (!file.startsWith(normalize(join(root, 'baked')))) throw new Error('path escape');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.concat(chunks));
      res.writeHead(200);
      res.end('ok');
      console.log(`saved ${p} (${chunks.reduce((s, c) => s + c.length, 0)} bytes)`);
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(normalize(root))) throw new Error('path escape');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
