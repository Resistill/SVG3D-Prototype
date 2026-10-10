#!/usr/bin/env node
// 本地静态服务（零依赖）：node bin/serve.mjs [端口，默认 5178]
// 一律 Cache-Control: no-store——工具刚改过的文件、刚改过的代码，浏览器刷新就能看到
// 打开工程：http://localhost:5178/index.html?file=work/<工程>/scene.s3d
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath：Windows 上 URL 的 pathname 是 /D:/…，直接 resolve 会得到 D:\D:\…
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = +(process.argv[2] ?? process.env.PORT ?? 5178);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.s3d': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

// 预览器的“保存”：只能覆盖已有的 .s3d 文件；只接受同源请求（PUT 跨域要预检，这里不回应预检，别的网页写不了）
async function put(req, res, file) {
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { res.writeHead(403).end('cross-origin'); return; }
  if (extname(file) !== '.s3d') { res.writeHead(403).end('只能保存 .s3d 文件'); return; }
  try { if (!(await stat(file)).isFile()) throw 0; } catch { res.writeHead(404).end('文件不存在'); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  await writeFile(file, Buffer.concat(chunks));
  res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
}

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (req.method === 'PUT') return put(req, res, file);
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    // 页面本身附带 Clear-Site-Data：清掉浏览器以前按启发式规则缓存的旧模块（别的服务器留下的）
    const html = extname(file) === '.html';
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...(html ? { 'Clear-Site-Data': '"cache"' } : {}) });
    res.end(await readFile(file));
  } catch { res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found'); }
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`端口 ${port} 已被占用——预览服务可能已经在运行，直接打开 http://localhost:${port}/ 即可；或者换个端口：node bin/serve.mjs ${port + 1}`);
  else console.error(e.message);
  process.exitCode = 1;
}).listen(port, '127.0.0.1', () => console.log(`SVG3D 预览：http://localhost:${port}/\n打开工程：http://localhost:${port}/index.html?file=work/<工程>/scene.s3d`));
