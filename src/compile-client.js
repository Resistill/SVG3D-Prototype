// 编译客户端：在 Worker（src/compile-worker.js）里编译，主线程只接结果。
// 只保留最新的请求：正在编译时又来的请求合并成一个（打字时不会排起长队），被取代的请求得到 null。
// 建不了 Worker（老浏览器、file:// 打开）或 Worker 出错时退回主线程同步编译，结果相同
import { compile } from './s3d.js';

export function createCompiler() {
  let worker = null, busy = null, next = null, seq = 0;
  const local = (req) => {
    const t0 = performance.now();
    try {
      const { files = {}, ...rest } = req.opts;
      req.resolve({ result: compile(req.src, { ...rest, resolve: (p) => files[p] }), ms: performance.now() - t0, worker: false });
    } catch (e) { req.reject(e); }
  };
  const send = (req) => { busy = req; worker.postMessage({ id: req.id, src: req.src, opts: req.opts }); };
  const done = () => { busy = null; if (next) { const n = next; next = null; worker ? send(n) : local(n); } };
  try {
    worker = new Worker(new URL('./compile-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const req = busy;
      if (!req || req.id !== data.id) return;
      if (data.ok) req.resolve({ result: data.result, ms: data.ms, worker: true }); else req.reject(new Error(data.error));
      done();
    };
    // Worker 本身坏了（模块加载失败等）：以后都在主线程编译，手上的请求也就地重做
    worker.onerror = (e) => {
      console.warn('编译 Worker 不可用，改在主线程编译：', e.message);
      e.preventDefault?.();
      worker.terminate();
      worker = null;
      const req = busy;
      busy = null;
      if (req) local(req);
      done();
    };
  } catch { worker = null; }

  // compile(src, { file, files: {路径: 文本}, …其余 compile 选项 }) → Promise<{ result, ms, worker } | null>
  return function compileAsync(src, opts = {}) {
    return new Promise((resolve, reject) => {
      const req = { id: ++seq, src, opts, resolve, reject };
      if (!worker) return local(req);
      if (!busy) return send(req);
      if (next) next.resolve(null);
      next = req;
    });
  };
}
