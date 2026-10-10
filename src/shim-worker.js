// 带 import map 的 Worker。Chrome 的模块 Worker 不认页面的 import map（152 仍是这样），而工具模块（tools/*.mjs）里有
// 'three'、'@gltf-transform/core'、'node:fs' 这类裸名字。做法：经典 Worker 先加载 es-module-shims（Worker 里自动是 shim 模式），
// 把页面的 import map 加上 node: 替身交给它，再由它加载入口模块。入口模块准备好后先发 { type: 'ready' }
const ESMS = 'https://cdn.jsdelivr.net/npm/es-module-shims@2.6.2/dist/es-module-shims.wasm.js';

export function workerImportMap() {
  const page = JSON.parse(document.querySelector('script[type=importmap]')?.textContent ?? '{}').imports ?? {};
  const abs = (u) => new URL(u, document.baseURI).href;
  const imports = Object.fromEntries(Object.entries(page).map(([k, v]) => [k, abs(v)]));
  imports['node:fs'] = new URL('./shims/node-fs.js', import.meta.url).href;
  imports['node:module'] = new URL('./shims/node-module.js', import.meta.url).href;
  return { imports };
}

// 自引用：three-mesh-bvh 的打包产物里有一行 import { BVH as BVH$1, … } from 'three-mesh-bvh'（引用自己）。原生 ESM 没问题，
// es-module-shims 按环处理时这些名字在求值时还是 undefined（Class extends value undefined）。加载时把这种“从自己导入”的语句去掉、
// 别名换回本地名字——同一个模块里的同一个绑定，语义不变。对任何映射到 URL 的包都适用，不只是这一个
// （这个函数会被 toString 进 Worker 的启动脚本，不能引用外面的东西）
export function patchSelfImports(src, spec) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const renames = [];
  src = src.replace(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${esc(spec)}\\2\\s*;?`, 'g'), (_, names) => {
    for (const part of names.split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig && alias && alias !== orig) renames.push([alias, orig]);
    }
    return '';
  });
  for (const [alias, orig] of renames) src = src.replace(new RegExp(`(?<![\\w$])${esc(alias)}(?![\\w$])`, 'g'), orig);
  return src;
}

// 返回 Promise<Worker>：入口模块加载完（收到 ready）才 resolve；加载失败 reject
export function shimWorker(entry) {
  const map = workerImportMap();
  const selfOf = Object.fromEntries(Object.entries(map.imports).filter(([k, v]) => !k.endsWith('/') && /^https?:/.test(v)).map(([k, v]) => [v, k]));
  const boot = `self.process = { env: {} };
const SELF = ${JSON.stringify(selfOf)};
${patchSelfImports.toString()}
self.esmsInitOptions = {
  async fetch(url, opts) {
    const res = await fetch(url, opts);
    const spec = SELF[res.url] ?? SELF[url];
    if (!spec || !res.ok) return res;
    return new Response(patchSelfImports(await res.text(), spec), { status: 200, headers: { 'Content-Type': 'text/javascript' } });
  },
};
importScripts(${JSON.stringify(ESMS)});
importShim.addImportMap(${JSON.stringify(map)});
importShim(${JSON.stringify(new URL(entry, import.meta.url).href)}).catch((e) => postMessage({ type: 'fatal', error: String(e && e.stack || e) }));`;
  const url = URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
  const w = new Worker(url);
  return new Promise((resolve, reject) => {
    const first = ({ data }) => {
      if (data?.type === 'ready') { w.removeEventListener('message', first); URL.revokeObjectURL(url); resolve(w); }
      else if (data?.type === 'fatal') { w.terminate(); reject(new Error(data.error)); }
    };
    w.addEventListener('message', first);
    w.addEventListener('error', (e) => reject(new Error(e.message || 'Worker 加载失败')), { once: true });
  });
}

// 一问一答的调用：每条消息带 id，按 id 取回结果（transfer 里的 ArrayBuffer 转交给 Worker，不复制）
export function rpc(worker) {
  let seq = 0;
  const waiting = new Map();
  worker.addEventListener('message', ({ data }) => {
    const p = waiting.get(data?.id);
    if (!p) return;
    waiting.delete(data.id);
    if (data.ok) p.resolve(data); else p.reject(new Error(data.error));
  });
  return (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id }, transfer);
  });
}
