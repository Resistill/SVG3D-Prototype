// 界面用的 HTTP 接口（bin/serve.mjs 按需加载）：GUI 与命令行、MCP 调同一张命令表（tools/agent.mjs），没有另一套逻辑
//   GET  /api/ping                     接口在不在（静态托管时没有它，界面退化成单文件预览）
//   GET  /api/project?dir=work/xxx     project.json、层文件列表（base 只读）、待处理提议数、有没有 score.json
//   POST /api/run    {dir, cmd, args}  调 runCommand(cmd, dir, args)，返回 JSON；结果里的文件路径（render 的 PNG 等）附上相对仓库根目录的 url
//   GET  /api/selection?dir=           读 <dir>/state/selection.json（{paths, camera}）
//   PUT  /api/selection?dir=           写 <dir>/state/selection.json
// 安全：只听 127.0.0.1；Host 必须是本机（防 DNS 重绑定）；写操作只接受同源（Origin）且 Content-Type 必须是 JSON（跨域要预检，这里不回应预检）；
// dir 必须在仓库根目录之内
import { runCommand, COMMANDS } from './agent.mjs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// 工程里不当作层文件列出的子目录
const SKIP_DIRS = new Set(['proposals', 'renders', 'state', 'source', 'node_modules']);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export function createApi(root) {
  root = resolve(root);
  const inside = (p, base = root) => p === base || p.startsWith(base + sep);
  const toRel = (p) => relative(root, p).split(sep).join('/');
  const projectDir = (dir) => {
    if (!dir || typeof dir !== 'string') throw new HttpError(400, '缺少 dir（工程目录，相对仓库根目录）');
    const d = resolve(root, dir);
    if (!inside(d)) throw new HttpError(403, 'dir 必须在仓库根目录之内');
    return d;
  };
  // 同一个工程的命令排队执行（评分缓存、提议编号、层文件都是共享的）
  const queues = new Map();
  const serial = (key, fn) => {
    const p = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    queues.set(key, p);
    const clean = () => { if (queues.get(key) === p) queues.delete(key); };
    p.then(clean, clean);
    return p;
  };

  // 层文件：工程目录及子目录（base/ 等）里的 .s3d；base.s3d 与 base/ 下的由逆向生成，只读
  async function layerFiles(d) {
    const out = [];
    const walk = async (sub, depth) => {
      let ents = [];
      try { ents = await readdir(join(d, sub), { withFileTypes: true }); } catch { return; }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = sub ? `${sub}/${e.name}` : e.name;
        if (e.isDirectory()) { if (depth < 2 && !SKIP_DIRS.has(e.name)) await walk(rel, depth + 1); }
        else if (e.name.endsWith('.s3d')) out.push({ path: rel, readonly: rel === 'base.s3d' || rel.startsWith('base/') });
      }
    };
    await walk('', 0);
    return out;
  }

  // 命令参数里的路径不能逃出工程目录（render 的 out）或仓库（propose 的 file）
  function checkArgs(d, args) {
    if (args.out != null && !inside(resolve(d, String(args.out)), d)) throw new HttpError(403, 'out 必须在工程目录之内');
    if (args.file != null && !inside(resolve(root, String(args.file)))) throw new HttpError(403, 'file 必须在仓库根目录之内');
  }
  // 结果里的绝对文件路径（render、propose 的 file，preview 的 render.file）附上 url，界面直接拿来显示
  function withUrls(x) {
    if (Array.isArray(x)) return x.map(withUrls);
    if (!x || typeof x !== 'object') return x;
    const o = { ...x };
    if (typeof o.file === 'string' && /^([a-zA-Z]:[\\/]|\/)/.test(o.file) && inside(resolve(o.file))) o.url = toRel(resolve(o.file));
    if (o.render && typeof o.render === 'object') o.render = withUrls(o.render);
    return o;
  }

  async function body(req) {
    const chunks = [];
    let n = 0;
    for await (const c of req) { n += c.length; if (n > 8 << 20) throw new HttpError(413, '请求太大'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, '请求体不是 JSON'); }
  }

  const routes = {
    'GET /api/ping': async () => ({ ok: true, commands: Object.keys(COMMANDS) }),
    'GET /api/project': async (q) => {
      const d = projectDir(q.get('dir'));
      if (!existsSync(join(d, 'project.json'))) throw new HttpError(404, `${q.get('dir')} 不是 SVG3D 工程（没有 project.json）`);
      const project = JSON.parse(await readFile(join(d, 'project.json'), 'utf8'));
      let proposals = 0;
      try { proposals = (await readdir(join(d, 'proposals'))).filter((f) => /^\d+.*\.s3d$/.test(f)).length; } catch { /* 还没有提议 */ }
      return { dir: toRel(d), project, files: await layerFiles(d), proposals, score: existsSync(join(d, 'score.json')) };
    },
    'POST /api/run': async (q, req) => {
      const { dir, cmd, args = {} } = await body(req);
      if (!COMMANDS[cmd]) throw new HttpError(400, `没有命令 ${cmd}（可用：${Object.keys(COMMANDS).join(' ')}）`);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(400, 'args 要是对象');
      const d = projectDir(dir);
      checkArgs(d, args);
      try { return withUrls(await serial(d, () => runCommand(cmd, d, args))); } catch (e) { throw e instanceof HttpError ? e : new HttpError(400, e.message); }
    },
    'GET /api/selection': async (q) => {
      const d = projectDir(q.get('dir'));
      try { return JSON.parse(await readFile(join(d, 'state/selection.json'), 'utf8')); } catch { return { paths: [] }; }
    },
    'PUT /api/selection': async (q, req) => {
      const d = projectDir(q.get('dir'));
      if (!existsSync(join(d, 'project.json'))) throw new HttpError(404, '不是 SVG3D 工程');
      const sel = await body(req);
      if (!Array.isArray(sel.paths) || sel.paths.some((p) => typeof p !== 'string')) throw new HttpError(400, 'paths 要是字符串数组');
      const out = { paths: sel.paths, ...(sel.camera ? { camera: sel.camera } : {}), t: new Date().toISOString() };
      await mkdir(join(d, 'state'), { recursive: true });
      await writeFile(join(d, 'state/selection.json'), JSON.stringify(out, null, 2) + '\n');
      return out;
    },
  };

  return async function handle(req, res, url) {
    const send = (status, obj) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
    try {
      if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'host');
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && !LOCAL_ORIGIN.test(origin)) throw new HttpError(403, 'cross-origin');
        if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'Content-Type 要是 application/json');
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) throw new HttpError(404, `没有接口 ${req.method} ${url.pathname}`);
      send(200, await route(url.searchParams, req));
    } catch (e) {
      send(e.status ?? 500, { error: e.message });
    }
  };
}
