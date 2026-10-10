#!/usr/bin/env node
// 本地服务（零依赖）：node bin/serve.mjs [端口，默认 5178] [--no-api]
// 静态文件 + 界面用的接口 /api/*（tools/api.mjs：工程、命令、选中状态；--no-api 时只有静态文件，界面退化成单文件预览）
// 一律 Cache-Control: no-store——工具刚改过的文件、刚改过的代码，浏览器刷新就能看到
// 打开工程：http://localhost:5178/index.html?file=work/<工程>/scene.s3d
import { createServer } from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, normalize, extname, resolve, sep, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath：Windows 上 URL 的 pathname 是 /D:/…，直接 resolve 会得到 D:\D:\…
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const noApi = argv.includes('--no-api');
const port = +(argv.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 5178);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.jsonl': 'text/plain; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.s3d': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };

// .s3d（与 .json）的版本号：内容的哈希。GET 时放在 ETag 里，保存时界面带 If-Match，磁盘上的文件被别处（工具、另一个窗口）改过就返回 409
const etag = (buf) => `"${createHash('sha1').update(buf).digest('hex')}"`;

// 工程的基础层（base.s3d 与 base/ 下的分区文件）由逆向生成，只读
const isBaseLayer = (file) => (basename(file) === 'base.s3d' && existsSync(join(dirname(file), 'project.json')))
  || (basename(dirname(file)) === 'base' && existsSync(join(dirname(dirname(file)), 'project.json')));

// 预览器的“保存”：只能覆盖已有的 .s3d 文件；只接受同源请求（PUT 跨域要预检，这里不回应预检，别的网页写不了）
async function put(req, res, file) {
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { res.writeHead(403).end('cross-origin'); return; }
  if (extname(file) !== '.s3d') { res.writeHead(403).end('只能保存 .s3d 文件'); return; }
  if (isBaseLayer(file)) { res.writeHead(403).end('基础层由逆向生成，只读（修改写在 edits.s3d 里）'); return; }
  try { if (!(await stat(file)).isFile()) throw 0; } catch { res.writeHead(404).end('文件不存在'); return; }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const match = req.headers['if-match'];
  if (match && match !== '*') {
    const cur = etag(await readFile(file));
    if (cur !== match) { res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8', ETag: cur, 'Cache-Control': 'no-store' }).end('文件已被别处修改'); return; }
  }
  const buf = Buffer.concat(chunks);
  await writeFile(file, buf);
  res.writeHead(204, { 'Cache-Control': 'no-store', ETag: etag(buf) }).end();
}

// 接口模块按需加载（它带着整套工具：逆向、评分、渲染），静态文件不受影响；加载失败时提示怎么启动
let apiP = null;
const api = () => (apiP ??= import('../tools/api.mjs').then((m) => m.createApi(root)).catch((e) => { apiP = null; throw e; }));

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) {
      if (noApi) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end('no api'); return; }
      let handle;
      try { handle = await api(); } catch (e) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: `接口加载失败：${e.message}。试试 node --import ./bin/node-hooks.mjs bin/serve.mjs` }));
        return;
      }
      return await handle(req, res, url);
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (req.method === 'PUT') return await put(req, res, file);
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    // 页面本身附带 Clear-Site-Data：清掉浏览器以前按启发式规则缓存的旧模块（别的服务器留下的）
    const ext = extname(file), html = ext === '.html', buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...(html ? { 'Clear-Site-Data': '"cache"' } : {}), ...(ext === '.s3d' || ext === '.json' ? { ETag: etag(buf) } : {}) });
    res.end(buf);
  } catch { if (!res.headersSent) res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found'); }
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`端口 ${port} 已被占用——预览服务可能已经在运行，直接打开 http://localhost:${port}/ 即可；或者换个端口：node bin/serve.mjs ${port + 1}`);
  else console.error(e.message);
  process.exitCode = 1;
}).listen(port, '127.0.0.1', () => console.log(`SVG3D 预览：http://localhost:${port}/${noApi ? '（--no-api：只有静态文件）' : ''}\n打开工程：http://localhost:${port}/index.html?file=work/<工程>/scene.s3d`));
